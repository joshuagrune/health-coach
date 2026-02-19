#!/usr/bin/env node
/**
 * Vitals trend: RHR, HRV, weight, VO2max over time.
 *
 * Usage:
 *   node vitals-trend.js [--days 90] [--period week|month] [--summary]
 */

const fs = require('fs');
const path = require('path');

const WORKSPACE = process.env.OPENCLAW_WORKSPACE || path.join(process.env.HOME || '/root', '.openclaw/workspace');
const COACH_ROOT = path.join(WORKSPACE, 'health', 'coach');
const CACHE_DIR = path.join(COACH_ROOT, 'salvor_cache');
const INTAKE_FILE = path.join(COACH_ROOT, 'intake.json');
const { getGoalsWithTargets, computeFromVitalsByPeriod, formatProgressLine } = require('../lib/goal-progress');

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

function getWeekKey(dateStr) {
  const d = new Date(dateStr + 'T12:00:00');
  const day = d.getDay() || 7;
  const start = new Date(d);
  start.setDate(d.getDate() - day + 1);
  return start.toLocaleDateString('en-CA', { timeZone: TZ }).slice(0, 10);
}

function main() {
  const args = process.argv.slice(2);
  const days = parseInt((args.find((a) => a.startsWith('--days=')) || '--days=90').slice(7), 10);
  const period = (args.find((a) => a.startsWith('--period=')) || '--period=week').slice(9);
  const summary = args.includes('--summary');

  const vitals = loadJsonlFiles('vitals_');
  const recent = getRecent(vitals, days);

  const byPeriod = {};
  for (const v of recent) {
    const date = v.localDate || v.date;
    if (!date) continue;
    const key = period === 'month' ? date.slice(0, 7) : getWeekKey(date);
    const rhr = v.resting_heart_rate ?? v.restingHeartRate ?? null;
    const hrv = v.hrv ?? v.hrvMs ?? null;
    const weight = v.weight_kg ?? v.weightKg ?? null;
    const vo2 = v.vo2_max ?? v.vo2Max ?? null;
    if (!byPeriod[key]) byPeriod[key] = { rhrs: [], hrvs: [], weights: [], vo2s: [], dates: [] };
    if (rhr != null) byPeriod[key].rhrs.push(rhr);
    if (hrv != null) byPeriod[key].hrvs.push(hrv);
    if (weight != null) byPeriod[key].weights.push(weight);
    if (vo2 != null) byPeriod[key].vo2s.push(vo2);
    byPeriod[key].dates.push(date);
  }

  const keys = Object.keys(byPeriod).sort();
  const data = keys.map((k) => {
    const p = byPeriod[k];
    const avg = (arr) => arr.length ? arr.reduce((a, b) => a + b, 0) / arr.length : null;
    const last = (arr) => arr.length ? arr[arr.length - 1] : null;
    return {
      period: k,
      avgRhr: p.rhrs.length ? Math.round(avg(p.rhrs) * 10) / 10 : null,
      avgHrv: p.hrvs.length ? Math.round(avg(p.hrvs) * 10) / 10 : null,
      lastWeight: p.weights.length ? Math.round(last(p.weights) * 10) / 10 : null,
      lastVo2: p.vo2s.length ? Math.round(last(p.vo2s) * 10) / 10 : null,
      samples: p.dates.length,
    };
  });

  const result = {
    generatedAt: new Date().toISOString(),
    days,
    period,
    samples: recent.length,
    byPeriod: data,
  };

  if (summary) {
    console.log('\n=== Vitals Trend ===\n');
    if (result.byPeriod.length === 0) {
      console.log('Keine Vitals-Daten gefunden.\n');
      return;
    }
    for (const p of result.byPeriod) {
      const parts = [];
      if (p.avgRhr != null) parts.push(`RHR ${p.avgRhr} bpm`);
      if (p.avgHrv != null) parts.push(`HRV ${p.avgHrv} ms`);
      if (p.lastWeight != null) parts.push(`${p.lastWeight} kg`);
      if (p.lastVo2 != null) parts.push(`VO2max ${p.lastVo2}`);
      console.log(`${p.period}  (${p.samples})  ${parts.join('  |  ')}`);
    }
    const intake = loadJson(INTAKE_FILE);
    const goalsWithTargets = getGoalsWithTargets(intake?.goals || []);
    const vitalsGoals = goalsWithTargets.filter((g) => ['weight', 'vo2max', 'rhr', 'hrv'].includes(g.metric));
    if (vitalsGoals.length > 0 && result.byPeriod.length >= 1) {
      const progress = computeFromVitalsByPeriod(vitalsGoals, result.byPeriod);
      if (progress.length > 0) {
        console.log('\n--- Goal Progress (Vitals) ---');
        for (const p of progress) {
          const line = p.current != null
            ? formatProgressLine(p)
            : `${p.kind}: Ziel ${p.target}${p.unit || ''} (keine Daten)`;
          console.log(line);
        }
        console.log('');
      }
    }
    console.log('');
  } else {
    console.log(JSON.stringify(result));
  }
}

main();
