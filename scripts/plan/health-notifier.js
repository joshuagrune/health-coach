#!/usr/bin/env node
/**
 * Detect new workouts, scores (today), sleep (last night), and emit coach notifications when:
 * 1) a new workout was detected (plan refresh + feedback)
 * 2) scores for today first appear (Readiness, Sleep, Load)
 * 3) sleep for last night first appears
 *
 * Output:
 * - workspace/current/health_coach_notification.json
 * - workspace/current/health_coach_pending_alerts.json (append when notify=true)
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { execFileSync } = require('child_process');

const WORKSPACE = process.env.OPENCLAW_WORKSPACE || path.join(process.env.HOME || '/root', '.openclaw/workspace');
const COACH_ROOT = path.join(WORKSPACE, 'health', 'coach');
const CACHE_DIR = path.join(COACH_ROOT, 'salvor_cache');
const CURRENT_DIR = path.join(WORKSPACE, 'current');
const STATE_FILE = path.join(COACH_ROOT, 'workout_notify_state.json');
const TZ = 'Europe/Berlin';
const TODAY_FILE = path.join(CURRENT_DIR, 'workouts_today.json');
const WEEK_FILE = path.join(CURRENT_DIR, 'training_plan_week.json');
const NOTIFICATION_FILE = path.join(CURRENT_DIR, 'health_coach_notification.json');
const PENDING_ALERTS_FILE = path.join(CURRENT_DIR, 'health_coach_pending_alerts.json');

const COOLDOWN_HOURS = Math.max(1, parseInt(process.env.HC_NOTIFY_COOLDOWN_HOURS || '6', 10) || 6);

function loadJson(p, fallback = null) {
  try {
    return JSON.parse(fs.readFileSync(p, 'utf8'));
  } catch {
    return fallback;
  }
}

function saveJson(p, obj) {
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, JSON.stringify(obj, null, 2), 'utf8');
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

function toLocalDate(d) {
  return d.toLocaleDateString('en-CA', { timeZone: TZ });
}

function hashPlan(week) {
  const sessions = (week?.sessions || []).map((s) => ({
    date: s.localDate,
    title: s.title,
    kind: s.kind,
    duration: s.targets?.durationMinutes ?? null,
    status: s.status ?? null,
  }));
  return crypto.createHash('sha1').update(JSON.stringify(sessions)).digest('hex');
}

const SKILL_DIR = path.join(__dirname, '..', '..');

function runPlanGenerator() {
  execFileSync(process.execPath, [path.join(SKILL_DIR, 'scripts', 'plan', 'plan-generator.js')], {
    encoding: 'utf8',
    env: { ...process.env, OPENCLAW_WORKSPACE: WORKSPACE },
    maxBuffer: 2 * 1024 * 1024,
  });
}

function runWorkoutAnalysis(workoutType) {
  try {
    const out = execFileSync(process.execPath, [
      path.join(SKILL_DIR, 'scripts', 'analysis', 'workout-analysis.js'),
      '--type', workoutType || 'Running',
      '--days', '90',
      '--latest', '6',
    ], {
      encoding: 'utf8',
      env: { ...process.env, OPENCLAW_WORKSPACE: WORKSPACE },
      maxBuffer: 512 * 1024,
    });
    return JSON.parse(out.trim() || '{}');
  } catch {
    return null;
  }
}

function diffPlan(oldWeek, newWeek) {
  const toKey = (s) => `${s.localDate}|${s.kind}|${s.title}|${s.targets?.durationMinutes ?? ''}`;
  const oldSet = new Set((oldWeek?.sessions || []).map(toKey));
  const newSet = new Set((newWeek?.sessions || []).map(toKey));
  const added = [...newSet].filter((k) => !oldSet.has(k));
  const removed = [...oldSet].filter((k) => !newSet.has(k));
  return { added, removed };
}

function workoutFeedback(workout) {
  if (!workout) return 'Stark, dass du heute trainiert hast.';
  const type = workout.type || workout.title || 'Workout';
  const dur = workout.duration != null ? `${workout.duration} min` : null;
  const avg = workout.avgHeartRate != null ? `ØHF ${workout.avgHeartRate}` : null;
  const max = workout.maxHeartRate != null ? `max ${workout.maxHeartRate}` : null;
  const high = workout.hrZoneHighMinutes != null ? `Z4+Z5 ${workout.hrZoneHighMinutes} min` : null;
  const parts = [dur, avg, max, high].filter(Boolean).join(', ');
  return parts ? `Starke Session: ${type} (${parts}).` : `Starke Session: ${type}.`;
}

function formatChangeLine(entry) {
  const [date, kind, title, dur] = entry.split('|');
  const durTxt = dur ? `${dur} min` : '';
  return `${date}: ${title} (${kind}${durTxt ? `, ${durTxt}` : ''})`;
}

function formatScoresForAgent(score) {
  if (!score) return null;
  const r = score.readiness || {};
  const s = score.sleep || {};
  const tl = score.training_load || {};
  const readiness = r.score ?? r;
  const sleepDetail = s.detail || (s.score != null ? `Score ${s.score}` : null);
  const loadDetail = tl.detail || (tl.ratio != null ? `Load ratio ${tl.ratio.toFixed(2)}` : null);
  return {
    readiness: typeof readiness === 'number' ? readiness : null,
    readinessLabel: r.label || null,
    sleepDetail,
    loadDetail,
    recoveryLabel: score.recovery?.label || null,
  };
}

function formatSleepForAgent(sleep) {
  if (!sleep) return null;
  const total = sleep.total_minutes ?? sleep.totalMinutes ?? 0;
  const h = Math.floor(total / 60);
  const m = total % 60;
  return {
    totalMinutes: total,
    formatted: `${h}h ${m}min`,
    deepMinutes: sleep.deep_minutes ?? sleep.deepMinutes ?? null,
    remMinutes: sleep.rem_minutes ?? sleep.remMinutes ?? null,
  };
}

function main() {
  const now = new Date();
  const todayStr = toLocalDate(now);
  const yesterday = new Date(now);
  yesterday.setDate(yesterday.getDate() - 1);
  const yesterdayStr = toLocalDate(yesterday);

  const today = loadJson(TODAY_FILE, { workouts: [] });
  const oldWeek = loadJson(WEEK_FILE, { sessions: [] });
  const oldPlanHash = hashPlan(oldWeek);

  const state = loadJson(STATE_FILE, {
    seenWorkoutIds: [],
    seenScoreDates: [],
    seenSleepDates: [],
    lastPlanHash: null,
    lastNotifiedAt: null,
  });

  const seen = new Set(state.seenWorkoutIds || []);
  const seenScores = new Set(state.seenScoreDates || []);
  const seenSleep = new Set(state.seenSleepDates || []);

  const todayWorkouts = today.workouts || [];
  const newWorkouts = todayWorkouts.filter((w) => w.id && !seen.has(String(w.id)));
  const newWorkoutIds = newWorkouts.map((w) => String(w.id));
  for (const id of newWorkoutIds) seen.add(id);

  // Scores for today, sleep for last night (localDate = yesterday = night we slept)
  const scores = loadJsonlFiles('scores_');
  const sleepRecords = loadJsonlFiles('sleep_');
  const scoreToday = scores.find((s) => (s.localDate || s.date) === todayStr);
  const sleepLastNight = sleepRecords.find((s) => (s.localDate || s.date) === yesterdayStr);

  const newScores = scoreToday && !seenScores.has(todayStr);
  const newSleep = sleepLastNight && !seenSleep.has(yesterdayStr);
  if (newScores) seenScores.add(todayStr);
  if (newSleep) seenSleep.add(yesterdayStr);

  // Keep state bounded
  const boundedSeen = [...seen].slice(-500);
  const boundedScores = [...seenScores].slice(-60);
  const boundedSleep = [...seenSleep].slice(-60);

  const hasWorkoutNotify = newWorkoutIds.length > 0;
  const hasScoresSleepNotify = newScores || newSleep;

  if (!hasWorkoutNotify && !hasScoresSleepNotify) {
    state.seenWorkoutIds = boundedSeen;
    state.seenScoreDates = boundedScores;
    state.seenSleepDates = boundedSleep;
    state.lastPlanHash = state.lastPlanHash || oldPlanHash;
    saveJson(STATE_FILE, state);
    saveJson(NOTIFICATION_FILE, {
      at: now.toISOString(),
      notify: false,
      reason: 'no_new_data',
      newWorkoutIds: [],
      scoresToday: null,
      sleepLastNight: null,
    });
    console.log('NO_NOTIFY no_new_data');
    return;
  }

  let newWeek = oldWeek;
  let planChanged = false;
  let changes = { added: [], removed: [], addedLines: [], removedLines: [] };
  let latestWorkout = null;
  let feedback = '';
  let workoutAnalysis = null;

  if (hasWorkoutNotify) {
    runPlanGenerator();
    newWeek = loadJson(WEEK_FILE, { sessions: [] });
    const newPlanHash = hashPlan(newWeek);
    planChanged = oldPlanHash !== newPlanHash;
    changes = diffPlan(oldWeek, newWeek);
    changes.addedLines = changes.added.slice(0, 2).map(formatChangeLine);
    changes.removedLines = changes.removed.slice(0, 2).map(formatChangeLine);

    latestWorkout = newWorkouts[newWorkouts.length - 1] || todayWorkouts[todayWorkouts.length - 1] || null;
    feedback = workoutFeedback(latestWorkout);

    const workoutType = latestWorkout?.type || latestWorkout?.title || 'Running';
    const analysis = runWorkoutAnalysis(workoutType);
    const analysisForType = analysis?.byType?.[workoutType];
    const comparison = analysisForType?.comparison;
    const latestMetrics = comparison?.latest || analysisForType?.latest?.[0];
    const deltas = comparison?.deltas || null;
    if (deltas) {
      workoutAnalysis = {
        deltas,
        labels: {
          durationMinutes: 'Dauer (min)',
          distanceKm: 'Distanz (km)',
          paceSecondsPerKm: 'Pace (s/km, negativ = schneller)',
          avgHeartRate: 'Ø Herzfrequenz (bpm)',
          maxHeartRate: 'Max HF (bpm)',
          groundContactTimeS: 'Bodenkontaktzeit (s)',
          strideLengthCm: 'Schrittlänge (cm)',
          powerAvgW: 'Power (W)',
        },
      };
    }
    if (latestWorkout) {
      latestWorkout._distanceKm = latestMetrics?.distanceKm ?? latestWorkout.distanceKm;
      latestWorkout._pacePerKm = latestMetrics?.pacePerKm ?? null;
    }
  }

  const shouldNotify = hasWorkoutNotify || hasScoresSleepNotify;
  let reason = 'no_new_data';
  if (hasWorkoutNotify && hasScoresSleepNotify) reason = 'new_workout_and_daily';
  else if (hasWorkoutNotify) reason = planChanged ? 'new_workout_plan_changed' : 'new_workout_feedback_only';
  else if (hasScoresSleepNotify) reason = newScores && newSleep ? 'scores_and_sleep' : newScores ? 'scores_today' : 'sleep_last_night';

  const notification = {
    at: now.toISOString(),
    notify: shouldNotify,
    reason,
    cooldownHours: COOLDOWN_HOURS,
    newWorkoutIds,
    planChanged: hasWorkoutNotify ? planChanged : false,
    feedback,
    latestWorkout: latestWorkout ? {
      type: latestWorkout.type || latestWorkout.title,
      duration: latestWorkout.duration,
      avgHeartRate: latestWorkout.avgHeartRate,
      maxHeartRate: latestWorkout.maxHeartRate,
      hrZoneHighMinutes: latestWorkout.hrZoneHighMinutes,
      heartRateZones: latestWorkout.heartRateZones || null,
      distanceKm: latestWorkout._distanceKm ?? latestWorkout.distanceKm,
      pacePerKm: latestWorkout._pacePerKm ?? null,
    } : null,
    workoutAnalysis,
    changes,
    scoresToday: newScores ? formatScoresForAgent(scoreToday) : null,
    sleepLastNight: newSleep ? formatSleepForAgent(sleepLastNight) : null,
  };

  saveJson(NOTIFICATION_FILE, notification);

  if (shouldNotify) {
    const pending = loadJson(PENDING_ALERTS_FILE, []);
    pending.push({
      at: now.toISOString(),
      type: hasWorkoutNotify ? 'health_coach_workout_update' : 'health_coach_daily',
      context: {
        feedback: notification.feedback,
        planChanged: notification.planChanged,
        changes: notification.changes,
        latestWorkout: notification.latestWorkout,
        workoutAnalysis: notification.workoutAnalysis,
        scoresToday: notification.scoresToday,
        sleepLastNight: notification.sleepLastNight,
      },
      source: 'health-notifier',
    });
    saveJson(PENDING_ALERTS_FILE, pending.slice(-50));
    state.lastNotifiedAt = now.toISOString();
  }

  state.seenWorkoutIds = boundedSeen;
  state.seenScoreDates = boundedScores;
  state.seenSleepDates = boundedSleep;
  state.lastPlanHash = hashPlan(newWeek);
  saveJson(STATE_FILE, state);

  console.log(`${shouldNotify ? 'NOTIFY' : 'NO_NOTIFY'} ${reason}`);
  if (shouldNotify) console.log('Context ready for agent to compose message');
}


main();
