#!/usr/bin/env node
/**
 * Load management: Acute:Chronic Load Ratio for injury risk.
 * Acute = last 7 days load (intensity-weighted: HR zones, effort_score, or duration), Chronic = 28-day rolling avg.
 * Ratio 1.0-1.5 = safe, >1.5 = elevated risk, >2.0 = high risk.
 *
 * Usage:
 *   node load-management.js [--days 35] [--summary]
 */

const path = require('path');
const { getWorkspace, getCoachRoot, loadJsonlFiles, getRecent, TZ } = require('../lib/cache-io');
const { shouldExcludeFromLoad, computeWorkoutLoad } = require('../lib/workout-utils');

const WORKSPACE = getWorkspace();
const COACH_ROOT = getCoachRoot();

function dailyLoads(workouts) {
  const byDate = {};
  for (const w of workouts) {
    const type = w.workout_type || w.workoutType || w.type || '';
    if (shouldExcludeFromLoad(w)) continue; // low-intensity active recovery excluded; intense yoga counts
    const d = w.localDate || w.date;
    if (!d) continue;
    const load = computeWorkoutLoad(w); // intensity-weighted: HR zones, effort_score, or duration
    byDate[d] = (byDate[d] || 0) + load;
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
    acuteLoad: Math.round(acuteLoad * 10) / 10,
    chronicLoad: Math.round(chronicLoad * 10) / 10,
    ratio,
    risk,
    acutePeriod: acuteDates[0] + ' to ' + acuteDates[acuteDates.length - 1],
    chronicPeriod: chronicDates[0] + ' to ' + chronicDates[chronicDates.length - 1],
  };

  if (summary) {
    console.log('\n=== Load Management (Acute:Chronic) ===\n');
    console.log('Load = intensity-weighted (HR zones, effort_score, or duration)');
    console.log('Acute (7d):  ' + result.acuteLoad);
    console.log('Chronic (28d Ø): ' + result.chronicLoad);
    console.log('Ratio: ' + result.ratio + '  →  ' + result.risk);
    console.log('\n1.0-1.5 = safe | >1.5 = elevated risk | >2.0 = high risk\n');
  } else {
    console.log(JSON.stringify(result));
  }
}

main();
