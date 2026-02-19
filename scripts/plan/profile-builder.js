#!/usr/bin/env node
/**
 * Builds profile.json from Salvor cache or intake baseline (manual fallback).
 * Computes baselines, domain summaries (endurance, strength, sleep, body), flags.
 * Writes workspace/health/coach/profile.json and workspace/current/health_profile_summary.json.
 */

const fs = require('fs');
const path = require('path');

const WORKSPACE = process.env.OPENCLAW_WORKSPACE || path.join(process.env.HOME || '/root', '.openclaw/workspace');
const COACH_ROOT = path.join(WORKSPACE, 'health', 'coach');
const CACHE_DIR = path.join(COACH_ROOT, 'salvor_cache');
const INTAKE_FILE = path.join(COACH_ROOT, 'intake.json');
const { computeFromProfile, getGoalsWithTargets } = require('../lib/goal-progress');
const PROFILE_FILE = path.join(COACH_ROOT, 'profile.json');
const SUMMARY_FILE = path.join(WORKSPACE, 'current', 'health_profile_summary.json');
const TZ = 'Europe/Berlin';

function ensureDir(dir) {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

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

function getRecent(records, days = 28) {
  const cutoff = new Date();
  cutoff.setDate(cutoff.getDate() - days);
  const cutoffStr = cutoff.toLocaleDateString('en-CA', { timeZone: TZ });
  return records.filter((r) => (r.localDate || r.date) >= cutoffStr);
}

function isEnduranceType(type) {
  const t = (type || '').toLowerCase();
  return /run|zone|walking|cycling|cardio|jog/i.test(t) && !/strength|full body|gym|flexibility|climbing/i.test(t);
}

function isStrengthType(type) {
  const t = (type || '').toLowerCase();
  return /strength|full body|gym|flexibility|climbing|hypertrophy/i.test(t);
}

function buildProfileFromSalvor(workouts, sleep, vitals, activity, scores) {
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

  const avgSleep = sleepTotals.length ? sleepTotals.reduce((a, s) => a + s.totalMinutes, 0) / sleepTotals.length : null;
  const avgDeep = sleepTotals.length ? sleepTotals.reduce((a, s) => a + s.deepMinutes, 0) / sleepTotals.length : null;
  const avgRem = sleepTotals.length ? sleepTotals.reduce((a, s) => a + s.remMinutes, 0) / sleepTotals.length : null;
  const lastSleep = sleepTotals[sleepTotals.length - 1];
  const sleepDeficit = avgSleep && lastSleep && lastSleep.totalMinutes < avgSleep * 0.9;

  // Workouts (last 28 days) — correct categorization
  const workoutsRecent = getRecent(workouts, 28);
  const byType = {};
  let totalDuration = 0;
  let longRunMinutes = 0;
  let runCount = 0;
  let runDuration = 0;
  let strengthCount = 0;
  let strengthDuration = 0;

  for (const w of workoutsRecent) {
    const type = (w.workout_type || w.workoutType || w.type || 'Other').trim();
    byType[type] = (byType[type] || 0) + 1;
    const dur = (w.duration_seconds ?? w.durationSeconds ?? w.duration ?? 0) / 60;
    totalDuration += dur;

    if (isEnduranceType(type)) {
      runCount++;
      runDuration += dur;
      if (dur > longRunMinutes) longRunMinutes = dur;
    } else if (isStrengthType(type)) {
      strengthCount++;
      strengthDuration += dur;
    }
  }

  const runsPerWeek = runCount / 4;
  const strengthPerWeek = strengthCount / 4;
  const cardioCount = runCount;
  const workoutsPerWeek = workoutsRecent.length / 4;

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
  const weightKg = vitalsRecent.length ? vitalsRecent.filter((v) => v.weight_kg != null).slice(-1)[0]?.weight_kg : null;
  const restingHR = vitalsRecent.length ? vitalsRecent.filter((v) => v.resting_heart_rate != null).slice(-1)[0]?.resting_heart_rate : null;
  const lastWithVo2 = vitalsRecent.filter((v) => (v.vo2_max ?? v.vo2Max) != null).slice(-1)[0];
  const vo2max = lastWithVo2 ? (lastWithVo2.vo2_max ?? lastWithVo2.vo2Max) : null;
  const lastWithHrv = vitalsRecent.filter((v) => (v.hrv ?? v.hrvMs) != null).slice(-1)[0];
  const hrvMs = lastWithHrv ? (lastWithHrv.hrv ?? lastWithHrv.hrvMs) : null;

  // Weight trend: last 2 weeks vs previous 2 weeks (for bodycomp progress)
  const weightsWithDates = vitalsRecent.filter((v) => v.weight_kg != null).map((v) => ({ w: v.weight_kg, d: v.localDate || v.date }));
  let weightTrendKg = null;
  if (weightsWithDates.length >= 4) {
    const mid = Math.floor(weightsWithDates.length / 2);
    const recent = weightsWithDates.slice(mid);
    const older = weightsWithDates.slice(0, mid);
    const avgRecent = recent.reduce((a, x) => a + x.w, 0) / recent.length;
    const avgOlder = older.reduce((a, x) => a + x.w, 0) / older.length;
    weightTrendKg = Math.round((avgRecent - avgOlder) * 10) / 10;
  }

  const hasEnoughWorkouts = workoutsRecent.length >= 4;
  const hasEnoughSleep = sleepTotals.length >= 7;
  const confidence = {
    endurance: hasEnoughWorkouts && runCount > 0 ? 'high' : runCount > 0 ? 'moderate' : 'low',
    strength: hasEnoughWorkouts && strengthCount > 0 ? 'high' : strengthCount > 0 ? 'moderate' : 'low',
    sleep: hasEnoughSleep ? 'high' : sleepTotals.length > 0 ? 'moderate' : 'low',
    overall: hasEnoughWorkouts || hasEnoughSleep ? 'moderate' : 'low',
  };

  return {
    dataQuality: 'salvor',
    confidence,
    version: 2,
    generatedAt: now.toISOString(),
    timeZone: TZ,
    windowDays: 28,
    domains: {
      endurance: {
        sessionsLast28Days: runCount,
        sessionsPerWeek: Math.round(runsPerWeek * 10) / 10,
        totalMinutesLast28Days: Math.round(runDuration),
        longestRunMinutes: Math.round(longRunMinutes) || null,
      },
      strength: {
        sessionsLast28Days: strengthCount,
        sessionsPerWeek: Math.round(strengthPerWeek * 10) / 10,
        totalMinutesLast28Days: Math.round(strengthDuration),
      },
      sleep: {
        avgTotalMinutes: Math.round(avgSleep) || null,
        avgDeepMinutes: Math.round(avgDeep) || null,
        avgRemMinutes: Math.round(avgRem) || null,
        lastNight: lastSleep ? { totalMinutes: lastSleep.totalMinutes, deepMinutes: lastSleep.deepMinutes, remMinutes: lastSleep.remMinutes } : null,
        deficit: sleepDeficit,
        sampleSize: sleepTotals.length,
      },
      body: {
        weightKg,
        restingHeartRateBpm: restingHR,
      },
    },
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
      workoutsPerWeek: Math.round(workoutsPerWeek * 10) / 10,
      runsPerWeek: Math.round(runsPerWeek * 10) / 10,
      strengthCount,
      cardioCount,
      byType: Object.entries(byType).reduce((a, [k, v]) => ({ ...a, [k]: v }), {}),
      totalDurationMinutes: Math.round(totalDuration),
      longestRunMinutes: Math.round(longRunMinutes) || null,
    },
    vitals: { weightKg, restingHeartRateBpm: restingHR, weightTrendKg, vo2max, hrvMs },
    scores: {
      lastReadiness: lastScore?.readiness?.score ?? lastScore?.readiness ?? null,
      avgReadiness: avgReadiness ? Math.round(avgReadiness) : null,
      lastLoadRatio: loadRatio,
      dataQuality: lastScore?.data_quality ?? null,
    },
    flags: { sleepDeficit, lowReadiness, loadSpike },
  };
}

function buildProfileFromIntake(intake) {
  const baseline = intake.baseline || {};
  const now = new Date();
  return {
    dataQuality: 'manual',
    confidence: { endurance: 'low', strength: 'low', sleep: 'low', overall: 'low' },
    version: 2,
    generatedAt: now.toISOString(),
    timeZone: TZ,
    windowDays: 28,
    domains: {
      endurance: {
        sessionsLast28Days: (baseline.runningFrequencyPerWeek ?? 2) * 4,
        sessionsPerWeek: baseline.runningFrequencyPerWeek ?? 2,
        totalMinutesLast28Days: (baseline.runningFrequencyPerWeek ?? 2) * 4 * (baseline.longestRecentRunMinutes ?? 45),
        longestRunMinutes: baseline.longestRecentRunMinutes ?? 60,
      },
      strength: {
        sessionsLast28Days: (baseline.strengthFrequencyPerWeek ?? 2) * 4,
        sessionsPerWeek: baseline.strengthFrequencyPerWeek ?? 2,
        totalMinutesLast28Days: (baseline.strengthFrequencyPerWeek ?? 2) * 4 * (baseline.longestStrengthSessionMinutes ?? 60),
      },
      sleep: { avgTotalMinutes: null, avgDeepMinutes: null, avgRemMinutes: null, lastNight: null, deficit: false, sampleSize: 0 },
      body: { weightKg: null, restingHeartRateBpm: null },
    },
    sleep: { avgTotalMinutes: null, avgDeepMinutes: null, avgRemMinutes: null, lastNight: null, deficit: false, sampleSize: 0 },
    workouts: {
      totalLast28Days: ((baseline.runningFrequencyPerWeek ?? 2) + (baseline.strengthFrequencyPerWeek ?? 2)) * 4,
      workoutsPerWeek: (baseline.runningFrequencyPerWeek ?? 2) + (baseline.strengthFrequencyPerWeek ?? 2),
      runsPerWeek: baseline.runningFrequencyPerWeek ?? 2,
      strengthCount: (baseline.strengthFrequencyPerWeek ?? 2) * 4,
      cardioCount: (baseline.runningFrequencyPerWeek ?? 2) * 4,
      byType: {},
      totalDurationMinutes: 0,
      longestRunMinutes: baseline.longestRecentRunMinutes ?? 60,
    },
    vitals: { weightKg: null, restingHeartRateBpm: null, weightTrendKg: null, vo2max: null, hrvMs: null },
    scores: { lastReadiness: null, avgReadiness: null, lastLoadRatio: null, dataQuality: null },
    flags: { sleepDeficit: false, lowReadiness: false, loadSpike: false },
  };
}

function main() {
  ensureDir(COACH_ROOT);
  ensureDir(path.join(WORKSPACE, 'current'));

  const workouts = loadJsonlFiles('workouts_');
  const sleep = loadJsonlFiles('sleep_');
  const vitals = loadJsonlFiles('vitals_');
  const activity = loadJsonlFiles('activity_');
  const scores = loadJsonlFiles('scores_');
  const intake = loadJson(INTAKE_FILE);

  let profile;
  if (workouts.length > 0 || sleep.length > 0) {
    profile = buildProfileFromSalvor(workouts, sleep, vitals, activity, scores);
  } else if (intake?.baseline) {
    profile = buildProfileFromIntake(intake);
  } else {
    profile = buildProfileFromIntake({ baseline: {} });
    profile.confidence = profile.confidence || { endurance: 'low', strength: 'low', sleep: 'low', overall: 'low' };
  }

  // Unified goal progress (bodycomp, sleep, vo2max, rhr, hrv) for agent feedback
  const goalsWithTargets = getGoalsWithTargets(intake?.goals || []);
  profile.goalProgress = goalsWithTargets.length > 0 ? computeFromProfile(intake.goals, profile) : [];

  fs.writeFileSync(PROFILE_FILE, JSON.stringify(profile, null, 2), 'utf8');

  const summary = {
    updatedAt: profile.generatedAt,
    dataQuality: profile.dataQuality,
    confidence: profile.confidence,
    sleep: profile.sleep.avgTotalMinutes ? `${Math.floor(profile.sleep.avgTotalMinutes / 60)}h ${profile.sleep.avgTotalMinutes % 60}min avg` : null,
    workoutsPerWeek: profile.workouts.workoutsPerWeek,
    readiness: profile.scores.lastReadiness,
    flags: profile.flags,
    goalProgress: profile.goalProgress || [],
  };

  fs.writeFileSync(SUMMARY_FILE, JSON.stringify(summary, null, 2), 'utf8');

  console.log('Profile built. Data:', profile.dataQuality, 'Sleep avg:', profile.sleep.avgTotalMinutes, 'min. Workouts/28d:', profile.workouts.totalLast28Days, 'Flags:', Object.keys(profile.flags).filter((k) => profile.flags[k]).join(', ') || 'none');
}

main();
