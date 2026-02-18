#!/usr/bin/env node
/**
 * Pace-at-HR trend: running efficiency over time.
 * Shows pace at a given HR zone (e.g. Z2 130–150 bpm) per week/month.
 * Faster pace at same HR = improved fitness.
 *
 * Usage:
 *   node pace-at-hr-trend.js [--hr-min 130] [--hr-max 150] [--days 180] [--period week|month] [--summary]
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

function formatPacePerKm(secondsPerKm) {
  if (secondsPerKm == null || !Number.isFinite(secondsPerKm)) return null;
  const total = Math.round(secondsPerKm);
  const min = Math.floor(total / 60);
  const sec = total % 60;
  return `${min}:${String(sec).padStart(2, '0')}/km`;
}

function parseArgs(args) {
  const hrMin = parseInt((args.find((a) => a.startsWith('--hr-min=')) || '--hr-min=130').slice(9), 10);
  const hrMax = parseInt((args.find((a) => a.startsWith('--hr-max=')) || '--hr-max=150').slice(9), 10);
  const days = parseInt((args.find((a) => a.startsWith('--days=')) || '--days=180').slice(7), 10);
  const period = (args.find((a) => a.startsWith('--period=')) || '--period=month').slice(9);
  const summary = args.includes('--summary');
  return { hrMin, hrMax, days, period: period === 'week' ? 'week' : 'month', summary };
}

function getWeekKey(dateStr) {
  const d = new Date(dateStr + 'T12:00:00');
  const day = d.getDay() || 7;
  const start = new Date(d);
  start.setDate(d.getDate() - day + 1);
  return start.toLocaleDateString('en-CA', { timeZone: TZ }).slice(0, 10);
}

function main() {
  const args = process.argv.slice(2);
  const { hrMin, hrMax, days, period, summary } = parseArgs(args);

  const workouts = loadJsonlFiles('workouts_');
  const recent = getRecent(workouts, days);
  const running = recent.filter((w) => {
    const t = (w.workout_type || w.workoutType || w.type || '').toLowerCase();
    return /run|jog/i.test(t) && !/strength|climbing/i.test(t);
  });

  const inZone = running.filter((w) => {
    const hr = w.avg_heart_rate ?? w.avgHeartRate ?? null;
    return hr != null && hr >= hrMin && hr <= hrMax;
  });

  const byPeriod = {};
  for (const w of inZone) {
    const date = w.localDate || w.date;
    if (!date) continue;
    const key = period === 'week' ? getWeekKey(date) : date.slice(0, 7);
    const durSec = w.duration_seconds ?? w.durationSeconds ?? w.duration ?? 0;
    const distM = w.distance_meters ?? w.distanceMeters ?? 0;
    const paceSecPerKm = distM > 0 ? durSec / (distM / 1000) : null;
    if (paceSecPerKm == null) continue;
    if (!byPeriod[key]) byPeriod[key] = { paces: [], dates: [] };
    byPeriod[key].paces.push(paceSecPerKm);
    byPeriod[key].dates.push(date);
  }

  const keys = Object.keys(byPeriod).sort();
  const data = keys.map((k) => {
    const p = byPeriod[k];
    const avgPace = p.paces.reduce((a, b) => a + b, 0) / p.paces.length;
    return {
      period: k,
      avgPaceSecondsPerKm: Math.round(avgPace * 10) / 10,
      pacePerKm: formatPacePerKm(avgPace),
      count: p.paces.length,
      dates: p.dates,
    };
  });

  const result = {
    generatedAt: new Date().toISOString(),
    days,
    period,
    hrZone: { min: hrMin, max: hrMax },
    runningCount: running.length,
    inZoneCount: inZone.length,
    byPeriod: data,
  };

  if (summary) {
    printSummary(result);
  } else {
    console.log(JSON.stringify(result));
  }
}

function printSummary(result) {
  console.log(`\n=== Pace bei ${result.hrZone.min}–${result.hrZone.max} bpm (Z2) — ${result.period}ly, last ${result.days} days ===\n`);
  if (result.byPeriod.length === 0) {
    console.log(`Keine Läufe mit Ø Puls in ${result.hrZone.min}–${result.hrZone.max} bpm gefunden.\n`);
    return;
  }
  const paces = result.byPeriod.map((p) => p.avgPaceSecondsPerKm);
  const best = Math.min(...paces);
  const worst = Math.max(...paces);
  for (const p of result.byPeriod) {
    const delta = p.avgPaceSecondsPerKm - best;
    const arrow = delta === 0 ? '★' : delta > 0 ? '↑' : '↓';
    console.log(`${p.period}  ${p.pacePerKm}  (${p.count} Läufe)  ${arrow}`);
  }
  console.log(`\nBester Ø: ${formatPacePerKm(best)} | Schlechtester: ${formatPacePerKm(worst)}`);
  console.log('Schneller bei gleichem Puls = bessere Effizienz.\n');
}

main();
