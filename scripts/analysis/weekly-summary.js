#!/usr/bin/env node
/**
 * Weekly summary: volume, sleep, adherence, highlights for the agent.
 * Consolidates key metrics for quick overview. Writes to workspace/current/health_weekly_summary.json.
 *
 * Usage:
 *   node weekly-summary.js [--days 7] [--text]
 */

const fs = require('fs');
const path = require('path');

const WORKSPACE = process.env.OPENCLAW_WORKSPACE || path.join(process.env.HOME || '/root', '.openclaw/workspace');
const COACH_ROOT = path.join(WORKSPACE, 'health', 'coach');
const CACHE_DIR = path.join(COACH_ROOT, 'salvor_cache');
const OUTPUT_FILE = path.join(WORKSPACE, 'current', 'health_weekly_summary.json');
const TZ = 'Europe/Berlin';

function loadJson(p) {
  try {
    return JSON.parse(fs.readFileSync(p, 'utf8'));
  } catch {
    return null;
  }
}

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

function formatPace(secPerKm) {
  if (secPerKm == null || !Number.isFinite(secPerKm)) return null;
  const m = Math.floor(secPerKm / 60);
  const s = Math.round(secPerKm % 60);
  return m + ':' + String(s).padStart(2, '0') + '/km';
}

function main() {
  const args = process.argv.slice(2);
  const days = parseInt((args.find((a) => a.startsWith('--days=')) || '--days=7').slice(7), 10);
  const text = args.includes('--text');

  const profile = loadJson(path.join(COACH_ROOT, 'profile.json'));
  const workouts = loadJsonlFiles('workouts_');
  const sleep = loadJsonlFiles('sleep_');
  const scores = loadJsonlFiles('scores_');
  const vitals = loadJsonlFiles('vitals_');

  const recentWorkouts = getRecent(workouts, days);
  const recentSleep = getRecent(sleep, days);
  const recentScores = getRecent(scores, days);
  const recentVitals = getRecent(vitals, days);

  const totalDuration = recentWorkouts.reduce((a, w) => a + (w.duration_seconds ?? w.durationSeconds ?? 0), 0);
  const running = recentWorkouts.filter((w) => /run|jog/i.test((w.workout_type || '').toLowerCase()) && !/strength|climbing/i.test((w.workout_type || '').toLowerCase()));
  const totalRunKm = running.reduce((a, w) => a + (w.distance_meters ?? 0) / 1000, 0);
  const bestRun = running.length ? running.reduce((best, w) => (w.distance_meters ?? 0) > (best.distance_meters ?? 0) ? w : best) : null;

  const avgSleep = recentSleep.length ? recentSleep.reduce((a, s) => a + (s.total_minutes ?? s.totalMinutes ?? 0), 0) / recentSleep.length : null;
  const lastNight = recentSleep[recentSleep.length - 1];
  const lastScoreRec = recentScores.length ? recentScores[recentScores.length - 1] : null;
  const lastReadiness = lastScoreRec && lastScoreRec.readiness ? (typeof lastScoreRec.readiness === 'object' ? lastScoreRec.readiness.score : lastScoreRec.readiness) : null;
  const lastRHR = recentVitals.length ? recentVitals[recentVitals.length - 1].resting_heart_rate : (profile && profile.vitals ? profile.vitals.restingHeartRateBpm : null);

  const byType = {};
  for (const w of recentWorkouts) {
    const t = w.workout_type || w.workoutType || 'Other';
    byType[t] = (byType[t] || 0) + 1;
  }

  const summary = {
    generatedAt: new Date().toISOString(),
    periodDays: days,
    workouts: {
      count: recentWorkouts.length,
      totalMinutes: Math.round(totalDuration / 60),
      runs: running.length,
      runKm: Math.round(totalRunKm * 100) / 100,
      byType,
      highlight: bestRun ? {
        date: bestRun.localDate || bestRun.date,
        type: bestRun.workout_type,
        distanceKm: Math.round((bestRun.distance_meters ?? 0) / 10) / 100,
        durationMin: Math.round((bestRun.duration_seconds ?? 0) / 60),
        pace: formatPace((bestRun.distance_meters ?? 0) > 0 ? (bestRun.duration_seconds ?? 0) / ((bestRun.distance_meters ?? 0) / 1000) : null),
      } : null,
    },
    sleep: {
      avgMinutes: avgSleep != null ? Math.round(avgSleep * 10) / 10 : null,
      lastNightMinutes: lastNight ? (lastNight.total_minutes ?? lastNight.totalMinutes) : null,
      nights: recentSleep.length,
    },
    readiness: lastReadiness,
    restingHeartRate: lastRHR,
    profileFlags: profile && profile.flags ? profile.flags : {},
  };

  const outDir = path.dirname(OUTPUT_FILE);
  if (!fs.existsSync(outDir)) fs.mkdirSync(outDir, { recursive: true });
  fs.writeFileSync(OUTPUT_FILE, JSON.stringify(summary, null, 2), 'utf8');

  if (text) {
    console.log('\n=== Weekly Summary ===\n');
    console.log('Workouts: ' + summary.workouts.count + ' (' + summary.workouts.totalMinutes + ' min)');
    if (summary.workouts.runs) console.log('  Runs: ' + summary.workouts.runs + ' × ' + summary.workouts.runKm + ' km');
    if (summary.workouts.highlight) console.log('  Highlight: ' + summary.workouts.highlight.date + ' ' + summary.workouts.highlight.distanceKm + ' km @ ' + summary.workouts.highlight.pace);
    console.log('\nSleep: Avg ' + (summary.sleep.avgMinutes ? Math.floor(summary.sleep.avgMinutes / 60) + 'h ' + Math.round(summary.sleep.avgMinutes % 60) + 'm' : '—') + ' (' + summary.sleep.nights + ' nights)');
    if (summary.readiness != null) console.log('Readiness: ' + summary.readiness);
    if (summary.restingHeartRate != null) console.log('Resting HR: ' + summary.restingHeartRate + ' bpm');
    if (Object.keys(summary.profileFlags).length) console.log('\nFlags:', summary.profileFlags);
    console.log('');
  } else {
    console.log(JSON.stringify(summary));
  }
}

main();
