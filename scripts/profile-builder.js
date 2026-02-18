#!/usr/bin/env node
/**
 * Builds profile.json from Salvor cache. Computes baselines, trends, flags.
 * Writes workspace/health/coach/profile.json and workspace/current/health_profile_summary.json.
 */

const fs = require('fs');
const path = require('path');

const WORKSPACE = process.env.OPENCLAW_WORKSPACE || path.join(process.env.HOME || '/root', '.openclaw/workspace');
const COACH_ROOT = path.join(WORKSPACE, 'health', 'coach');
const CACHE_DIR = path.join(COACH_ROOT, 'salvor_cache');
const PROFILE_FILE = path.join(COACH_ROOT, 'profile.json');
const SUMMARY_FILE = path.join(WORKSPACE, 'current', 'health_profile_summary.json');
const TZ = 'Europe/Berlin';

function ensureDir(dir) {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
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

function getRecent(records, days = 28) {
  const cutoff = new Date();
  cutoff.setDate(cutoff.getDate() - days);
  const cutoffStr = cutoff.toLocaleDateString('en-CA', { timeZone: TZ });
  return records.filter((r) => (r.localDate || r.date) >= cutoffStr);
}

function main() {
  ensureDir(COACH_ROOT);
  ensureDir(path.join(WORKSPACE, 'current'));

  const workouts = loadJsonlFiles('workouts_');
  const sleep = loadJsonlFiles('sleep_');
  const vitals = loadJsonlFiles('vitals_');
  const activity = loadJsonlFiles('activity_');
  const scores = loadJsonlFiles('scores_');

  const now = new Date();
  const today = now.toLocaleDateString('en-CA', { timeZone: TZ });

  // Sleep (last 28 days)
  const sleepRecent = getRecent(sleep, 28);
  const sleepTotals = sleepRecent.map((s) => ({
    date: s.localDate || s.date,
    totalMinutes: s.total_minutes ?? s.totalMinutes ?? 0,
    deepMinutes: s.deep_minutes ?? s.deepMinutes ?? 0,
    remMinutes: s.rem_minutes ?? s.remMinutes ?? 0,
    awakeMinutes: s.awake_minutes ?? s.awakeMinutes ?? 0,
  })).filter((s) => s.totalMinutes > 0);

  const avgSleep = sleepTotals.length
    ? sleepTotals.reduce((a, s) => a + s.totalMinutes, 0) / sleepTotals.length
    : null;
  const avgDeep = sleepTotals.length
    ? sleepTotals.reduce((a, s) => a + s.deepMinutes, 0) / sleepTotals.length
    : null;
  const avgRem = sleepTotals.length
    ? sleepTotals.reduce((a, s) => a + s.remMinutes, 0) / sleepTotals.length
    : null;

  const lastSleep = sleepTotals[sleepTotals.length - 1];
  const sleepDeficit = avgSleep && lastSleep && lastSleep.totalMinutes < avgSleep * 0.9;

  // Workouts (last 28 days)
  const workoutsRecent = getRecent(workouts, 28);
  const byType = {};
  let totalDuration = 0;
  let longRunMinutes = 0;
  for (const w of workoutsRecent) {
    const type = (w.workout_type || w.workoutType || w.type || 'Other').trim();
    byType[type] = (byType[type] || 0) + 1;
    const dur = (w.duration_seconds ?? w.durationSeconds ?? w.duration ?? 0) / 60;
    totalDuration += dur;
    if (type.toLowerCase().includes('run') || type.toLowerCase().includes('zone') || type === 'Walking') {
      if (dur > longRunMinutes) longRunMinutes = dur;
    }
  }

  const runsPerWeek = workoutsRecent.length / 4;
  const strengthCount = Object.entries(byType).filter(([t]) =>
    /strength|full body|gym|flexibility|climbing/i.test(t)
  ).reduce((a, [, c]) => a + c, 0);
  const cardioCount = workoutsRecent.length - strengthCount;

  // Scores (last 14 days)
  const scoresRecent = getRecent(scores, 14);
  const lastScore = scoresRecent[scoresRecent.length - 1];
  const avgReadiness = scoresRecent.length
    ? scoresRecent.reduce((a, s) => a + (s.readiness?.score ?? s.readiness ?? 0), 0) / scoresRecent.length
    : null;
  const lowReadiness = lastScore && (lastScore.readiness?.score ?? lastScore.readiness ?? 100) < 60;
  const loadRatio = lastScore?.training_load?.ratio ?? null;
  const loadSpike = loadRatio != null && loadRatio > 1.3;

  // Vitals (last 28 days)
  const vitalsRecent = getRecent(vitals, 28);
  const weightKg = vitalsRecent.length
    ? vitalsRecent.filter((v) => v.weight_kg != null).slice(-1)[0]?.weight_kg
    : null;
  const restingHR = vitalsRecent.length
    ? vitalsRecent.filter((v) => v.resting_heart_rate != null).slice(-1)[0]?.resting_heart_rate
    : null;

  const profile = {
    version: 1,
    generatedAt: now.toISOString(),
    timeZone: TZ,
    windowDays: 28,
    sleep: {
      avgTotalMinutes: Math.round(avgSleep) || null,
      avgDeepMinutes: Math.round(avgDeep) || null,
      avgRemMinutes: Math.round(avgRem) || null,
      lastNight: lastSleep ? { totalMinutes: lastSleep.totalMinutes, deepMinutes: lastSleep.deepMinutes, remMinutes: lastSleep.remMinutes } : null,
      deficit: sleepDeficit,
      sampleSize: sleepTotals.length,
    },
    workouts: {
      totalLast28Days: workoutsRecent.length,
      runsPerWeek: Math.round(runsPerWeek * 10) / 10,
      strengthCount,
      cardioCount,
      byType: Object.entries(byType).reduce((a, [k, v]) => ({ ...a, [k]: v }), {}),
      totalDurationMinutes: Math.round(totalDuration),
      longestRunMinutes: Math.round(longRunMinutes) || null,
    },
    vitals: {
      weightKg,
      restingHeartRateBpm: restingHR,
    },
    scores: {
      lastReadiness: lastScore?.readiness?.score ?? lastScore?.readiness ?? null,
      avgReadiness: avgReadiness ? Math.round(avgReadiness) : null,
      lastLoadRatio: loadRatio,
      dataQuality: lastScore?.data_quality ?? null,
    },
    flags: {
      sleepDeficit,
      lowReadiness,
      loadSpike,
    },
  };

  fs.writeFileSync(PROFILE_FILE, JSON.stringify(profile, null, 2), 'utf8');

  const summary = {
    updatedAt: now.toISOString(),
    sleep: profile.sleep.avgTotalMinutes ? `${Math.floor(profile.sleep.avgTotalMinutes / 60)}h ${profile.sleep.avgTotalMinutes % 60}min avg` : null,
    workoutsPerWeek: profile.workouts.runsPerWeek + (profile.workouts.strengthCount + profile.workouts.cardioCount) / 4,
    readiness: profile.scores.lastReadiness,
    flags: profile.flags,
  };

  fs.writeFileSync(SUMMARY_FILE, JSON.stringify(summary, null, 2), 'utf8');

  console.log('Profile built. Sleep avg:', profile.sleep.avgTotalMinutes, 'min. Workouts/28d:', profile.workouts.totalLast28Days, 'Flags:', Object.keys(profile.flags).filter((k) => profile.flags[k]).join(', ') || 'none');
}

main();
