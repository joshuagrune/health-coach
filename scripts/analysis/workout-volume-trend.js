#!/usr/bin/env node
/**
 * Workout volume trend: duration, distance, count per week/month over time.
 * Optional --type filter (Running, Strength, etc.).
 *
 * Usage:
 *   node workout-volume-trend.js [--type Running] [--days 180] [--period week|month] [--summary]
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

function parseArgs(args) {
  const typeIdx = args.indexOf('--type');
  const typeFilter = (args.find((a) => a.startsWith('--type=')) || '').slice(7) || (typeIdx >= 0 && args[typeIdx + 1] ? args[typeIdx + 1] : null);
  const days = parseInt((args.find((a) => a.startsWith('--days=')) || '--days=180').slice(7), 10);
  const period = (args.find((a) => a.startsWith('--period=')) || '--period=month').slice(9);
  const summary = args.includes('--summary');
  return { typeFilter, days, period: period === 'week' ? 'week' : 'month', summary };
}

function aggregateByPeriod(workouts, period) {
  const byKey = {};
  for (const w of workouts) {
    const date = w.localDate || w.date;
    if (!date) continue;
    const key = period === 'week' ? getWeekKey(date) : date.slice(0, 7); // YYYY-MM
    if (!byKey[key]) byKey[key] = { durationMinutes: 0, distanceKm: 0, count: 0 };
    const durSec = w.duration_seconds ?? w.durationSeconds ?? w.duration ?? 0;
    const distM = w.distance_meters ?? w.distanceMeters ?? 0;
    byKey[key].durationMinutes += Math.round(durSec / 60);
    byKey[key].distanceKm += distM > 0 ? Math.round(distM / 10) / 100 : 0;
    byKey[key].count += 1;
  }
  return byKey;
}

function getWeekKey(dateStr) {
  const d = new Date(dateStr + 'T12:00:00');
  const day = d.getDay() || 7; // Sun=7 for ISO week (Mon start)
  const start = new Date(d);
  start.setDate(d.getDate() - day + 1);
  return start.toLocaleDateString('en-CA', { timeZone: TZ }).slice(0, 10);
}

function main() {
  const args = process.argv.slice(2);
  const { typeFilter, days, period, summary } = parseArgs(args);

  const workouts = loadJsonlFiles('workouts_');
  let recent = getRecent(workouts, days);
  if (typeFilter) {
    recent = recent.filter((w) => (w.workout_type || w.workoutType || w.type || '') === typeFilter);
  }

  const byPeriod = aggregateByPeriod(recent, period);
  const keys = Object.keys(byPeriod).sort();
  const data = keys.map((k) => ({ period: k, ...byPeriod[k] }));

  const result = {
    generatedAt: new Date().toISOString(),
    days,
    period,
    typeFilter: typeFilter || 'all',
    count: recent.length,
    byPeriod: data,
  };

  if (summary) {
    printSummary(result);
  } else {
    console.log(JSON.stringify(result));
  }
}

function printSummary(result) {
  const label = result.typeFilter !== 'all' ? ` (${result.typeFilter})` : '';
  console.log(`\n=== Workout Volume Trend${label} — ${result.period}ly, last ${result.days} days ===\n`);
  if (result.byPeriod.length === 0) {
    console.log('No workouts found.\n');
    return;
  }
  const maxDur = Math.max(...result.byPeriod.map((p) => p.durationMinutes));
  const maxBar = 30;
  for (const p of result.byPeriod) {
    const barLen = maxDur > 0 ? Math.round((p.durationMinutes / maxDur) * maxBar) : 0;
    const bar = '█'.repeat(barLen) + '░'.repeat(maxBar - barLen);
    const distStr = p.distanceKm > 0 ? ` | ${p.distanceKm.toFixed(1)} km` : '';
    console.log(`${p.period}  ${String(p.durationMinutes).padStart(4)} min  ${p.count}×  ${bar}${distStr}`);
  }
  const total = result.byPeriod.reduce((a, p) => a + p.durationMinutes, 0);
  const avg = total / result.byPeriod.length;
  console.log(`\nTotal: ${total} min | Avg per ${result.period}: ${Math.round(avg)} min\n`);
}

main();
