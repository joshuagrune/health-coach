#!/usr/bin/env node
/**
 * Load management: Acute:Chronic Load Ratio for injury risk.
 * Acute = last 7 days load (duration-weighted), Chronic = 28-day rolling avg.
 * Ratio 1.0-1.5 = safe, >1.5 = elevated risk, >2.0 = high risk.
 *
 * Usage:
 *   node load-management.js [--days 35] [--summary]
 */

const fs = require('fs');
const path = require('path');

const WORKSPACE = process.env.OPENCLAW_WORKSPACE || path.join(process.env.HOME || '/root', '.openclaw/workspace');
const COACH_ROOT = path.join(WORKSPACE, 'health', 'coach');
const CACHE_DIR = path.join(COACH_ROOT, 'salvor_cache');
const TZ = 'Europe/Berlin';

function loadJsonlFiles(prefix) {
  const out = [];
  if (!fs.existsSync(CACHE_DIR)) return out;
  const files = fs.readdirSync(CACHE_DIR).filter((f) => f.startsWith(prefix) && f.endsWith('.jsonl'));
  for (const f of files.sort()) {
    const lines = fs.readFileSync(path.join(CACHE_DIR, f), 'utf8').trim().split('\n').filter(Boolean);
    for (const line of lines) {
      try {
        out.push(JSON.parse(line));
      } catch (_) {}
    }
  }
  return out;
}

function getRecent(records, days) {
  const cutoff = new Date();
  cutoff.setDate(cutoff.getDate() - days);
  const cutoffStr = cutoff.toLocaleDateString('en-CA', { timeZone: TZ });
  return records.filter((r) => (r.localDate || r.date) >= cutoffStr);
}

function dailyLoads(workouts) {
  const byDate = {};
  for (const w of workouts) {
    const d = w.localDate || w.date;
    if (!d) continue;
    const dur = (w.duration_seconds ?? w.durationSeconds ?? 0) / 60;
    byDate[d] = (byDate[d] || 0) + dur;
  }
  return byDate;
}

function main() {
  const args = process.argv.slice(2);
  const days = parseInt((args.find((a) => a.startsWith('--days=')) || '--days=35').slice(7), 10);
  const summary = args.includes('--summary');
  const typeFilter = (args.find((a) => a.startsWith('--type=')) || '').slice(7) || (args.includes('--type') && args[args.indexOf('--type') + 1] ? args[args.indexOf('--type') + 1] : null);

  const workouts = loadJsonlFiles('workouts_');
  let recent = getRecent(workouts, days);
  if (typeFilter) recent = recent.filter((w) => (w.workout_type || w.workoutType || w.type || '') === typeFilter);

  const loads = dailyLoads(recent);
  const dates = Object.keys(loads).sort();
  if (dates.length < 7) {
    const out = { generatedAt: new Date().toISOString(), error: 'Insufficient data (need 7+ days)', ratio: null };
    console.log(summary ? JSON.stringify(out, null, 2) : JSON.stringify(out));
    return;
  }

  const today = new Date().toLocaleDateString('en-CA', { timeZone: TZ });
  const acuteDates = dates.filter((d) => d <= today).slice(-7);
  const chronicDates = dates.filter((d) => d <= today).slice(-28);

  const acuteLoad = acuteDates.reduce((a, d) => a + (loads[d] || 0), 0);
  const chronicLoad = chronicDates.reduce((a, d) => a + (loads[d] || 0), 0) / 4;

  const ratio = chronicLoad > 0 ? Math.round((acuteLoad / chronicLoad) * 100) / 100 : null;
  let risk = 'unknown';
  if (ratio != null) {
    if (ratio > 2.0) risk = 'high';
    else if (ratio > 1.5) risk = 'elevated';
    else if (ratio >= 0.8 && ratio <= 1.5) risk = 'safe';
    else if (ratio < 0.8) risk = 'detraining';
  }

  const result = {
    generatedAt: new Date().toISOString(),
    days,
    typeFilter: typeFilter || 'all',
    acuteLoadMinutes: Math.round(acuteLoad * 10) / 10,
    chronicLoadMinutes: Math.round(chronicLoad * 10) / 10,
    ratio,
    risk,
    acutePeriod: acuteDates[0] + ' to ' + acuteDates[acuteDates.length - 1],
    chronicPeriod: chronicDates[0] + ' to ' + chronicDates[chronicDates.length - 1],
  };

  if (summary) {
    console.log('\n=== Load Management (Acute:Chronic) ===\n');
    console.log('Acute (7d):  ' + result.acuteLoadMinutes + ' min');
    console.log('Chronic (28d Ø): ' + result.chronicLoadMinutes + ' min');
    console.log('Ratio: ' + result.ratio + '  →  ' + result.risk);
    console.log('\n1.0-1.5 = safe | >1.5 = elevated risk | >2.0 = high risk\n');
  } else {
    console.log(JSON.stringify(result));
  }
}

main();
