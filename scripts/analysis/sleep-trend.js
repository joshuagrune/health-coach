#!/usr/bin/env node
/**
 * Sleep trend: detailed analysis over time.
 * Total, deep, REM, core, awake; weekday vs weekend; consistency.
 *
 * Usage:
 *   node sleep-trend.js [--days 90] [--period week|month] [--summary]
 */

const fs = require('fs');
const path = require('path');

const WORKSPACE = process.env.OPENCLAW_WORKSPACE || path.join(process.env.HOME || '/root', '.openclaw/workspace');
const COACH_ROOT = path.join(WORKSPACE, 'health', 'coach');
const CACHE_DIR = path.join(COACH_ROOT, 'salvor_cache');
const INTAKE_FILE = path.join(COACH_ROOT, 'intake.json');
const { getGoalsWithTargets, computeFromSleepByPeriod, formatProgressLine } = require('../lib/goal-progress');

function loadJson(p) {
  try {
    return JSON.parse(fs.readFileSync(p, 'utf8'));
  } catch {
    return null;
  }
}
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
  const days = parseInt((args.find((a) => a.startsWith('--days=')) || '--days=90').slice(7), 10);
  const period = (args.find((a) => a.startsWith('--period=')) || '--period=week').slice(9);
  const summary = args.includes('--summary');
  return { days, period: period === 'month' ? 'month' : 'week', summary };
}

function getWeekKey(dateStr) {
  const d = new Date(dateStr + 'T12:00:00');
  const day = d.getDay() || 7;
  const start = new Date(d);
  start.setDate(d.getDate() - day + 1);
  return start.toLocaleDateString('en-CA', { timeZone: TZ }).slice(0, 10);
}

function isWeekend(dateStr) {
  const d = new Date(dateStr + 'T12:00:00');
  const day = d.getDay();
  return day === 0 || day === 6;
}

function formatDuration(min) {
  if (min == null || !Number.isFinite(min)) return '—';
  const h = Math.floor(min / 60);
  const m = Math.round(min % 60);
  return `${h}h ${m}m`;
}

function stdDev(arr) {
  if (arr.length < 2) return 0;
  const avg = arr.reduce((a, b) => a + b, 0) / arr.length;
  const variance = arr.reduce((a, v) => a + (v - avg) ** 2, 0) / arr.length;
  return Math.sqrt(variance);
}

function main() {
  const args = process.argv.slice(2);
  const { days, period, summary } = parseArgs(args);

  const sleep = loadJsonlFiles('sleep_');
  const recent = getRecent(sleep, days).sort((a, b) => (a.localDate || a.date).localeCompare(b.localDate || b.date));

  const byPeriod = {};
  for (const s of recent) {
    const date = s.localDate || s.date;
    if (!date) continue;
    const key = period === 'month' ? date.slice(0, 7) : getWeekKey(date);
    const total = s.total_minutes ?? s.totalMinutes ?? 0;
    const deep = s.deep_minutes ?? s.deepMinutes ?? 0;
    const rem = s.rem_minutes ?? s.remMinutes ?? 0;
    const core = s.core_minutes ?? s.coreMinutes ?? 0;
    const awake = s.awake_minutes ?? s.awakeMinutes ?? 0;
    if (total <= 0) continue;
    if (!byPeriod[key]) byPeriod[key] = { totals: [], deeps: [], rems: [], cores: [], awakes: [], dates: [] };
    byPeriod[key].totals.push(total);
    byPeriod[key].deeps.push(deep);
    byPeriod[key].rems.push(rem);
    byPeriod[key].cores.push(core);
    byPeriod[key].awakes.push(awake);
    byPeriod[key].dates.push(date);
  }

  const keys = Object.keys(byPeriod).sort();
  const byPeriodData = keys.map((k) => {
    const p = byPeriod[k];
    const avg = (arr) => arr.reduce((a, b) => a + b, 0) / arr.length;
    return {
      period: k,
      avgTotal: Math.round(avg(p.totals) * 10) / 10,
      avgDeep: Math.round(avg(p.deeps) * 10) / 10,
      avgRem: Math.round(avg(p.rems) * 10) / 10,
      avgCore: Math.round(avg(p.cores) * 10) / 10,
      avgAwake: Math.round(avg(p.awakes) * 10) / 10,
      nights: p.totals.length,
      stdTotal: Math.round(stdDev(p.totals) * 10) / 10,
    };
  });

  const weekday = recent.filter((s) => !isWeekend(s.localDate || s.date));
  const weekend = recent.filter((s) => isWeekend(s.localDate || s.date));
  const avgWeekday = weekday.length ? weekday.reduce((a, s) => a + (s.total_minutes ?? s.totalMinutes ?? 0), 0) / weekday.length : null;
  const avgWeekend = weekend.length ? weekend.reduce((a, s) => a + (s.total_minutes ?? s.totalMinutes ?? 0), 0) / weekend.length : null;

  const shortNights = recent.filter((s) => (s.total_minutes ?? s.totalMinutes ?? 999) < 360).length;
  const veryShortNights = recent.filter((s) => (s.total_minutes ?? s.totalMinutes ?? 999) < 300).length;

  const last7 = recent.slice(-7).map((s) => ({
    date: s.localDate || s.date,
    total: s.total_minutes ?? s.totalMinutes,
    deep: s.deep_minutes ?? s.deepMinutes,
    rem: s.rem_minutes ?? s.remMinutes,
    awake: s.awake_minutes ?? s.awakeMinutes,
  }));

  const result = {
    generatedAt: new Date().toISOString(),
    days,
    period,
    nights: recent.length,
    byPeriod: byPeriodData,
    weekdayVsWeekend: {
      weekday: avgWeekday != null ? Math.round(avgWeekday * 10) / 10 : null,
      weekend: avgWeekend != null ? Math.round(avgWeekend * 10) / 10 : null,
      weekdayNights: weekday.length,
      weekendNights: weekend.length,
    },
    shortNights: { under6h: veryShortNights, under7h: shortNights - veryShortNights, totalUnder7h: shortNights },
    consistency: recent.length >= 2 ? Math.round(stdDev(recent.map((s) => s.total_minutes ?? s.totalMinutes ?? 0)) * 10) / 10 : null,
    last7Nights: last7,
  };

  if (summary) {
    printSummary(result);
  } else {
    console.log(JSON.stringify(result));
  }
}

function printSummary(result) {
  console.log(`\n=== Sleep Trend — last ${result.days} days (${result.nights} Nächte) ===\n`);

  if (result.byPeriod.length === 0) {
    console.log('Keine Schlafdaten gefunden.\n');
    return;
  }

  console.log('--- Pro Woche/Monat ---\n');
  const maxBar = 25;
  const maxTotal = Math.max(...result.byPeriod.map((p) => p.avgTotal));
  for (const p of result.byPeriod) {
    const barLen = maxTotal > 0 ? Math.round((p.avgTotal / maxTotal) * maxBar) : 0;
    const bar = '█'.repeat(barLen) + '░'.repeat(maxBar - barLen);
    const deepPct = p.avgTotal > 0 ? Math.round((p.avgDeep / p.avgTotal) * 100) : 0;
    const remPct = p.avgTotal > 0 ? Math.round((p.avgRem / p.avgTotal) * 100) : 0;
    console.log(`${p.period}  Ø ${formatDuration(p.avgTotal)}  (${p.nights} Nächte)  ${bar}`);
    console.log(`       Deep: ${formatDuration(p.avgDeep)} (${deepPct}%)  |  REM: ${formatDuration(p.avgRem)} (${remPct}%)  |  Awake: ${formatDuration(p.avgAwake)}  |  σ: ${p.stdTotal.toFixed(0)} min`);
  }

  console.log('\n--- Wochentag vs. Wochenende ---\n');
  const wd = result.weekdayVsWeekend;
  if (wd.weekday != null) console.log(`  Wochentage (Mo–Fr): Ø ${formatDuration(wd.weekday)}  (${wd.weekdayNights} Nächte)`);
  if (wd.weekend != null) console.log(`  Wochenende (Sa–So): Ø ${formatDuration(wd.weekend)}  (${wd.weekendNights} Nächte)`);
  if (wd.weekday != null && wd.weekend != null) {
    const diff = wd.weekend - wd.weekday;
    const absMin = Math.abs(diff);
    const dir = diff >= 0 ? 'mehr' : 'weniger';
    console.log(`  Differenz: ${formatDuration(absMin)} ${dir} am Wochenende`);
  }

  console.log('\n--- Kurze Nächte ---\n');
  console.log(`  < 6h: ${result.shortNights.under6h}  |  < 7h: ${result.shortNights.totalUnder7h}`);

  if (result.consistency != null) {
    console.log('\n--- Konsistenz ---\n');
    console.log(`  Std.Abw. Schlafdauer: ${result.consistency} min`);
  }

  const intake = loadJson(INTAKE_FILE);
  const goalsWithTargets = getGoalsWithTargets(intake?.goals || []);
  const sleepGoals = goalsWithTargets.filter((g) => g.metric === 'sleep');
  if (sleepGoals.length > 0 && result.byPeriod.length >= 1) {
    const progress = computeFromSleepByPeriod(sleepGoals, result.byPeriod);
    if (progress.length > 0) {
      console.log('\n--- Goal Progress (Sleep) ---\n');
      for (const p of progress) {
        console.log('  ' + formatProgressLine(p));
      }
    }
  }

  console.log('\n--- Letzte 7 Nächte ---\n');
  for (const n of result.last7Nights) {
    const eff = n.total > 0 ? Math.round(((n.total - (n.awake || 0)) / n.total) * 100) : 0;
    console.log(`  ${n.date}  ${formatDuration(n.total)}  Deep: ${formatDuration(n.deep)}  REM: ${formatDuration(n.rem)}  Eff: ${eff}%`);
  }
  console.log('');
}

main();
