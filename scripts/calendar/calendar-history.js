#!/usr/bin/env node
/**
 * Adds completed (historical) Salvor workouts to the Sport calendar via khal.
 * Reads from salvor_cache/workouts_YYYY-MM.jsonl, converts startTimeUtc → local CET
 * before calling khal, avoiding the 1h UTC/CET offset error.
 *
 * Usage:
 *   node calendar-history.js [--dry-run] [--days=30] [--month=2026-02]
 *
 * Requires: vdirsyncer, khal. SPORT_CALENDAR_ID in env or workspace/.env.
 */

const { execSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const WORKSPACE = process.env.OPENCLAW_WORKSPACE || path.join(process.env.HOME || '/root', '.openclaw/workspace');
const COACH_ROOT = path.join(WORKSPACE, 'health', 'coach');
const TZ = 'Europe/Berlin';

function getSportCalendarId() {
  if (process.env.SPORT_CALENDAR_ID) return process.env.SPORT_CALENDAR_ID.trim().replace(/^["']|["']$/g, '');
  try {
    const envPath = path.join(WORKSPACE, '.env');
    if (fs.existsSync(envPath)) {
      const raw = fs.readFileSync(envPath, 'utf8');
      const m = raw.match(/^\s*SPORT_CALENDAR_ID\s*=\s*(.+)/m);
      if (m) return m[1].trim().replace(/^["']|["']$/g, '');
    }
  } catch (_) {}
  return null;
}

function run(cmd, opts = {}) {
  return execSync(cmd, { encoding: 'utf8', cwd: WORKSPACE, ...opts });
}

/** Convert a UTC ISO string to local HH:MM in Europe/Berlin */
function utcToLocalHHMM(utcIso) {
  const d = new Date(utcIso);
  return d.toLocaleTimeString('de-DE', { timeZone: TZ, hour: '2-digit', minute: '2-digit', hour12: false });
}

/** Convert a UTC ISO string to local YYYY-MM-DD in Europe/Berlin */
function utcToLocalDate(utcIso) {
  const d = new Date(utcIso);
  return d.toLocaleDateString('en-CA', { timeZone: TZ });
}

/** DD.MM.YYYY for khal */
function toKhalDate(isoDate) {
  const [y, m, d] = isoDate.split('-');
  return `${d}.${m}.${y}`;
}

/** Load all workouts from salvor_cache for a given month (YYYY-MM) */
function loadSalvorMonth(yyyyMM) {
  const file = path.join(COACH_ROOT, 'salvor_cache', `workouts_${yyyyMM}.jsonl`);
  if (!fs.existsSync(file)) return [];
  return fs.readFileSync(file, 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((line) => { try { return JSON.parse(line); } catch { return null; } })
    .filter(Boolean);
}

/** Workout type → emoji + calendar label */
function formatTitle(workout) {
  const type = workout.workout_type || workout.workoutType || 'Workout';
  const emojis = {
    Running: '🏃 Running',
    'Strength Training': '💪 Strength Training',
    Volleyball: '🏐 Volleyball',
    Cycling: '🚴 Cycling',
    Swimming: '🏊 Swimming',
    Walking: '🚶 Walking',
    Climbing: '🧗 Climbing',
    Flexibility: '🧘 Flexibility',
    Hiking: '🥾 Hiking',
  };
  return emojis[type] || `🏋️ ${type}`;
}

function main() {
  const dryRun = process.argv.includes('--dry-run');
  const daysArg = process.argv.find((a) => a.startsWith('--days='));
  const days = daysArg ? parseInt(daysArg.slice(7), 10) : 30;
  const monthArg = process.argv.find((a) => a.startsWith('--month='));

  const today = new Date().toLocaleDateString('en-CA', { timeZone: TZ });
  const cutoff = new Date(today);
  cutoff.setDate(cutoff.getDate() - days);
  const cutoffStr = cutoff.toLocaleDateString('en-CA', { timeZone: TZ });

  // Determine which months to scan
  const months = [];
  if (monthArg) {
    months.push(monthArg.slice(8));
  } else {
    // Current month and previous month to cover the window
    const now = new Date();
    months.push(`${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`);
    const prev = new Date(now.getFullYear(), now.getMonth() - 1, 1);
    months.push(`${prev.getFullYear()}-${String(prev.getMonth() + 1).padStart(2, '0')}`);
  }

  // Load workouts from all relevant months
  const workouts = months.flatMap(loadSalvorMonth);

  // Filter to the time window (completed, within last N days, not today or future)
  const toAdd = workouts.filter((w) => {
    if (!w.startTimeUtc) return false;
    const localDate = utcToLocalDate(w.startTimeUtc);
    if (localDate < cutoffStr) return false;
    if (localDate >= today) return false; // only historical
    return true;
  });

  // Deduplicate by id
  const seen = new Set();
  const unique = toAdd.filter((w) => {
    if (seen.has(w.id)) return false;
    seen.add(w.id);
    return true;
  });

  // Sort chronologically
  unique.sort((a, b) => a.startTimeUtc.localeCompare(b.startTimeUtc));

  if (unique.length === 0) {
    console.log('No historical workouts to add.');
    return;
  }

  const sportCalendarId = getSportCalendarId();
  if (!sportCalendarId) {
    console.error('SPORT_CALENDAR_ID not set. Add to env or workspace/.env');
    process.exit(1);
  }

  if (dryRun) {
    console.log(`DRY-RUN: Would add ${unique.length} historical workout(s) to calendar "${sportCalendarId}":\n`);
    for (const w of unique) {
      const localDate = utcToLocalDate(w.startTimeUtc);
      const startLocal = utcToLocalHHMM(w.startTimeUtc);
      const endLocal = w.endTimeUtc ? utcToLocalHHMM(w.endTimeUtc) : '??:??';
      const title = formatTitle(w);
      console.log(`  ${localDate} ${startLocal}–${endLocal}  ${title}  [${w.id}]  (UTC start: ${w.startTimeUtc})`);
    }
    return;
  }

  console.log('Running vdirsyncer sync...');
  try { run('vdirsyncer sync'); } catch (e) { console.warn('vdirsyncer sync warning:', e.message); }

  let created = 0;
  for (const w of unique) {
    const localDate = utcToLocalDate(w.startTimeUtc);
    const startLocal = utcToLocalHHMM(w.startTimeUtc);
    const endLocal = w.endTimeUtc ? utcToLocalHHMM(w.endTimeUtc) : (() => {
      // fallback: start + duration
      const d = new Date(w.startTimeUtc);
      d.setSeconds(d.getSeconds() + (w.duration_seconds || 3600));
      return utcToLocalHHMM(d.toISOString());
    })();
    const khalDate = toKhalDate(localDate);
    const title = formatTitle(w).replace(/"/g, '\\"');
    const desc = `salvor:${w.id}`;
    try {
      run(`khal new ${khalDate} ${startLocal} ${endLocal} "${title}" :: "${desc}" -a ${sportCalendarId}`);
      console.log(`  ✅ ${localDate} ${startLocal}–${endLocal}  ${title}`);
      created++;
    } catch (e) {
      console.error(`  ❌ Failed: ${w.id} — ${e.message}`);
    }
  }

  if (created > 0) {
    console.log(`\nSyncing ${created} new event(s) to iCloud...`);
    try { run('vdirsyncer sync'); } catch (_) {}
  }

  console.log(`\nDone. Added ${created}/${unique.length} workouts.`);
}

main();
