#!/usr/bin/env node
/**
 * Running form trend: GCT, stride length, vertical oscillation over time.
 * Helps spot form changes that may indicate fatigue or injury risk.
 *
 * Usage:
 *   node running-form-trend.js [--days 180] [--period week|month] [--summary]
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

function getWeekKey(dateStr) {
  const d = new Date(dateStr + 'T12:00:00');
  const day = d.getDay() || 7;
  const start = new Date(d);
  start.setDate(d.getDate() - day + 1);
  return start.toLocaleDateString('en-CA', { timeZone: TZ }).slice(0, 10);
}

function main() {
  const args = process.argv.slice(2);
  const days = parseInt((args.find((a) => a.startsWith('--days=')) || '--days=180').slice(7), 10);
  const period = (args.find((a) => a.startsWith('--period=')) || '--period=month').slice(9);
  const summary = args.includes('--summary');

  const workouts = loadJsonlFiles('workouts_');
  const recent = getRecent(workouts, days);
  const running = recent.filter((w) => {
    const t = (w.workout_type || w.workoutType || w.type || '').toLowerCase();
    return /run|jog/i.test(t) && !/strength|climbing/i.test(t);
  });

  const withForm = running.filter((w) => {
    const gct = w.running_ground_contact_time_avg_s ?? w.running_ground_contact_time_avg_s;
    const stride = w.running_stride_length_avg_m;
    const vert = w.running_vertical_oscillation_avg_m;
    return gct != null || stride != null || vert != null;
  });

  const byPeriod = {};
  for (const w of withForm) {
    const date = w.localDate || w.date;
    if (!date) continue;
    const key = period === 'week' ? getWeekKey(date) : date.slice(0, 7);
    const gct = w.running_ground_contact_time_avg_s ?? null;
    const stride = w.running_stride_length_avg_m != null ? w.running_stride_length_avg_m * 100 : null;
    const vert = w.running_vertical_oscillation_avg_m != null ? w.running_vertical_oscillation_avg_m * 100 : null;
    if (!byPeriod[key]) byPeriod[key] = { gcts: [], strides: [], verts: [], dates: [] };
    if (gct != null) byPeriod[key].gcts.push(gct);
    if (stride != null) byPeriod[key].strides.push(stride);
    if (vert != null) byPeriod[key].verts.push(vert);
    byPeriod[key].dates.push(date);
  }

  const keys = Object.keys(byPeriod).sort();
  const data = keys.map((k) => {
    const p = byPeriod[k];
    const avg = (arr) => arr.length ? arr.reduce((a, b) => a + b, 0) / arr.length : null;
    return {
      period: k,
      gctMs: p.gcts.length ? Math.round(avg(p.gcts) * 1000) : null,
      strideCm: p.strides.length ? Math.round(avg(p.strides) * 10) / 10 : null,
      vertOscCm: p.verts.length ? Math.round(avg(p.verts) * 10) / 10 : null,
      runs: p.dates.length,
    };
  });

  const result = {
    generatedAt: new Date().toISOString(),
    days,
    period,
    runsWithFormData: withForm.length,
    totalRuns: running.length,
    byPeriod: data,
  };

  if (summary) {
    console.log('\n=== Running Form Trend ===\n');
    if (result.byPeriod.length === 0) {
      console.log('Keine Läufe mit GCT/Stride/Vert.Osz. gefunden (Watch/Tracker nötig).\n');
      return;
    }
    for (const p of result.byPeriod) {
      const parts = [];
      if (p.gctMs != null) parts.push(`GCT ${p.gctMs}ms`);
      if (p.strideCm != null) parts.push(`Stride ${p.strideCm}cm`);
      if (p.vertOscCm != null) parts.push(`Vert ${p.vertOscCm}cm`);
      console.log(`${p.period}  (${p.runs} Läufe)  ${parts.join('  |  ')}`);
    }
    console.log('\nGCT↑/Stride↓ kann Ermüdung anzeigen. Vert.Osz. stabil halten.\n');
  } else {
    console.log(JSON.stringify(result));
  }
}

main();
