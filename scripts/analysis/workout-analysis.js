#!/usr/bin/env node
/**
 * Workout analysis: compare metrics across workouts of the same type.
 * Reads Salvor cache, extracts all available metrics, compares latest with previous.
 * Output: JSON (for agent) or --text for human-readable.
 *
 * Usage:
 *   node workout-analysis.js [--type Running] [--days 90] [--text] [--latest N]
 */

const path = require('path');
const { getWorkspace, getCoachRoot, loadJsonlFiles, getRecent } = require('../lib/cache-io');

const WORKSPACE = getWorkspace();
const COACH_ROOT = getCoachRoot();

/** Format pace as min:sec/km (never 5:64 — use proper seconds 0-59) */
function formatPacePerKm(secondsPerKm) {
  if (secondsPerKm == null || !Number.isFinite(secondsPerKm)) return null;
  const total = Math.round(secondsPerKm);
  const min = Math.floor(total / 60);
  const sec = total % 60;
  return `${min}:${String(sec).padStart(2, '0')}/km`;
}

/** Format duration as Xmin */
function formatDuration(minutes) {
  if (minutes == null || !Number.isFinite(minutes)) return null;
  return `${Math.round(minutes)}min`;
}

function extractRunningMetrics(w) {
  const durSec = w.duration_seconds ?? w.durationSeconds ?? w.duration ?? 0;
  const distM = w.distance_meters ?? w.distanceMeters ?? 0;
  const paceSecPerKm = distM > 0 ? durSec / (distM / 1000) : null;
  return {
    date: w.localDate || w.date,
    type: w.workout_type || w.workoutType || w.type,
    durationMinutes: Math.round(durSec / 60),
    distanceKm: distM > 0 ? Math.round(distM / 10) / 100 : null,
    pacePerKm: formatPacePerKm(paceSecPerKm),
    paceSecondsPerKm: paceSecPerKm,
    avgHeartRate: w.avg_heart_rate ?? w.avgHeartRate ?? null,
    maxHeartRate: w.max_heart_rate ?? w.maxHeartRate ?? null,
    groundContactTimeS: w.running_ground_contact_time_avg_s ?? null,
    strideLengthCm: w.running_stride_length_avg_m != null ? Math.round(w.running_stride_length_avg_m * 100) : null,
    verticalOscillationCm: w.running_vertical_oscillation_avg_m != null ? Math.round(w.running_vertical_oscillation_avg_m * 1000) / 10 : null,
    powerAvgW: w.running_power_avg_w ?? w.cycling_power_avg_w ?? null,
    powerMaxW: w.running_power_max_w ?? w.cycling_power_max_w ?? null,
  };
}

function extractStrengthMetrics(w) {
  const durSec = w.duration_seconds ?? w.durationSeconds ?? w.duration ?? 0;
  return {
    date: w.localDate || w.date,
    type: w.workout_type || w.workoutType || w.type,
    durationMinutes: Math.round(durSec / 60),
    avgHeartRate: w.avg_heart_rate ?? w.avgHeartRate ?? null,
  };
}

function extractCyclingMetrics(w) {
  const durSec = w.duration_seconds ?? w.durationSeconds ?? w.duration ?? 0;
  const distM = w.distance_meters ?? w.distanceMeters ?? 0;
  const paceSecPerKm = distM > 0 ? durSec / (distM / 1000) : null;
  return {
    date: w.localDate || w.date,
    type: w.workout_type || w.workoutType || w.type,
    durationMinutes: Math.round(durSec / 60),
    distanceKm: distM > 0 ? Math.round(distM / 10) / 100 : null,
    pacePerKm: formatPacePerKm(paceSecPerKm),
    avgHeartRate: w.avg_heart_rate ?? w.avgHeartRate ?? null,
    cadenceRpm: w.cycling_cadence_avg_rpm ?? null,
    powerAvgW: w.cycling_power_avg_w ?? null,
  };
}

function extractMetrics(w) {
  const type = (w.workout_type || w.workoutType || w.type || '').toLowerCase();
  if (/run|jog|walking/i.test(type) && !/strength|climbing/i.test(type)) return extractRunningMetrics(w);
  if (/cycling|bike/i.test(type)) return extractCyclingMetrics(w);
  return extractStrengthMetrics(w);
}

function groupByType(workouts) {
  const byType = {};
  for (const w of workouts) {
    const type = w.workout_type || w.workoutType || w.type || 'Other';
    if (!byType[type]) byType[type] = [];
    byType[type].push(w);
  }
  for (const k of Object.keys(byType)) {
    byType[k].sort((a, b) => (b.localDate || b.date || '').localeCompare(a.localDate || a.date || ''));
  }
  return byType;
}

function compareWithPrevious(extracted, type) {
  if (extracted.length === 0) return null;
  const latest = extracted[0];
  const previous = extracted.slice(1, 6); // last 5 of same type
  const comparison = { latest, previous, type };
  const numericKeys = ['durationMinutes', 'distanceKm', 'paceSecondsPerKm', 'avgHeartRate', 'maxHeartRate', 'groundContactTimeS', 'strideLengthCm', 'verticalOscillationCm', 'powerAvgW'];
  comparison.deltas = {};
  for (const key of numericKeys) {
    const v = latest[key];
    if (v == null || !previous.length) continue;
    const prevVals = previous.map((p) => p[key]).filter((x) => x != null);
    if (prevVals.length === 0) continue;
    const avgPrev = prevVals.reduce((a, b) => a + b, 0) / prevVals.length;
    comparison.deltas[key] = { current: v, avgPrevious: Math.round(avgPrev * 100) / 100, delta: Math.round((v - avgPrev) * 100) / 100 };
  }
  return comparison;
}

function main() {
  const args = process.argv.slice(2);
  const typeIdx = args.indexOf('--type');
  const typeFilter = (args.find((a) => a.startsWith('--type=')) || '').slice(7) || (typeIdx >= 0 && args[typeIdx + 1] ? args[typeIdx + 1] : null);
  const days = parseInt((args.find((a) => a.startsWith('--days=')) || '--days=90').slice(7), 10);
  const text = args.includes('--text');
  const summary = args.includes('--summary');
  const latestN = parseInt((args.find((a) => a.startsWith('--latest=')) || '--latest=10').slice(9), 10);

  const workouts = loadJsonlFiles('workouts_');
  const recent = getRecent(workouts, days);
  const byType = groupByType(recent);

  const types = typeFilter ? [typeFilter] : Object.keys(byType);
  const result = { generatedAt: new Date().toISOString(), days, byType: {} };

  for (const type of types) {
    const list = byType[type] || [];
    const extracted = list.map(extractMetrics);
    const comparison = compareWithPrevious(extracted, type);
    result.byType[type] = {
      count: list.length,
      latest: extracted.slice(0, latestN),
      comparison: comparison ? { latest: comparison.latest, deltas: comparison.deltas } : null,
    };
  }

  if (summary) {
    printSummary(result);
  } else if (text) {
    console.log(JSON.stringify(result, null, 2));
  } else {
    console.log(JSON.stringify(result));
  }
}

function printSummary(result) {
  for (const [type, data] of Object.entries(result.byType)) {
    console.log(`\n=== ${type} (${data.count} workouts, last ${result.days} days) ===\n`);
    const latest = data.comparison?.latest || data.latest[0];
    if (!latest) continue;
    console.log(`Latest: ${latest.date}`);
    if (latest.durationMinutes) console.log(`  Duration: ${latest.durationMinutes} min`);
    if (latest.distanceKm) console.log(`  Distance: ${latest.distanceKm} km`);
    if (latest.pacePerKm) console.log(`  Pace: ${latest.pacePerKm}`);
    if (latest.avgHeartRate) console.log(`  Avg HR: ${Math.round(latest.avgHeartRate)} bpm`);
    if (latest.groundContactTimeS != null) console.log(`  GCT: ${(latest.groundContactTimeS * 1000).toFixed(0)} ms`);
    if (latest.strideLengthCm != null) console.log(`  Stride length: ${latest.strideLengthCm} cm`);
    if (latest.verticalOscillationCm != null) console.log(`  Vertical oscillation: ${latest.verticalOscillationCm} cm`);
    if (latest.powerAvgW != null) console.log(`  Avg power: ${Math.round(latest.powerAvgW)} W`);
    const deltas = data.comparison?.deltas;
    if (deltas && Object.keys(deltas).length) {
      console.log('\n  vs. avg of last 5:');
      const labels = { durationMinutes: 'Duration', distanceKm: 'Distance', paceSecondsPerKm: 'Pace (s/km)', avgHeartRate: 'Avg HR', maxHeartRate: 'Max HR', groundContactTimeS: 'GCT', strideLengthCm: 'Stride length', verticalOscillationCm: 'Vert.Osc.', powerAvgW: 'Power' };
      for (const [k, v] of Object.entries(deltas)) {
        const label = labels[k] || k;
        const sign = v.delta > 0 ? '+' : '';
        console.log(`    ${label}: ${sign}${v.delta}`);
      }
    }
  }
  console.log('');
}

main();
