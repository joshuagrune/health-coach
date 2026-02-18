#!/usr/bin/env node
/**
 * Goal-driven plan generator. Composes endurance, strength, and habit plans.
 * Supports intake v2 (goals[]) and v1 (milestones[]). Output: workout_calendar.json.
 */

const fs = require('fs');
const path = require('path');

const WORKSPACE = process.env.OPENCLAW_WORKSPACE || path.join(process.env.HOME || '/root', '.openclaw/workspace');
const COACH_ROOT = path.join(WORKSPACE, 'health', 'coach');
const CACHE_DIR = path.join(COACH_ROOT, 'salvor_cache');
const INTAKE_FILE = path.join(COACH_ROOT, 'intake.json');
const PROFILE_FILE = path.join(COACH_ROOT, 'profile.json');
const CALENDAR_FILE = path.join(COACH_ROOT, 'workout_calendar.json');
const TZ = 'Europe/Berlin';

const DAY_TO_KEY = { 0: 'su', 1: 'mo', 2: 'tu', 3: 'we', 4: 'th', 5: 'fr', 6: 'sa' };

function ensureDir(dir) {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

function loadJson(filePath) {
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
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

function addDays(dateStr, days) {
  const d = new Date(dateStr + 'T12:00:00');
  d.setDate(d.getDate() + days);
  return d.toLocaleDateString('en-CA', { timeZone: TZ });
}

function getDayKey(dateStr) {
  const d = new Date(dateStr + 'T12:00:00');
  return DAY_TO_KEY[d.getUTCDay()];
}

function toDay2(d) {
  const x = d.toLowerCase().slice(0, 3);
  const m = { mon: 'mo', tue: 'tu', wed: 'we', thu: 'th', fri: 'fr', sat: 'sa', sun: 'su', mo: 'mo', tu: 'tu', we: 'we', th: 'th', fr: 'fr', sa: 'sa', su: 'su' };
  return m[x] || x.slice(0, 2);
}

/** Resolve goals: v2 goals[] or v1 milestones[] */
function resolveGoals(intake) {
  const goals = intake.goals || [];
  const milestones = intake.milestones || [];
  const hasEndurance = milestones.some((m) => m.kind === 'marathon') || goals.some((g) => g.kind === 'endurance' || g.subKind === 'marathon');
  const hasStrength = goals.some((g) => g.kind === 'strength');
  const hasSleep = goals.some((g) => g.kind === 'sleep');
  const hasBodycomp = goals.some((g) => g.kind === 'bodycomp');
  const hasGeneral = goals.some((g) => g.kind === 'general') || (goals.length === 0 && milestones.length === 0);
  const enduranceMilestone = milestones.find((m) => m.kind === 'marathon') || milestones[0];
  return { hasEndurance, hasStrength, hasSleep, hasBodycomp, hasGeneral, enduranceMilestone };
}

/** Generate endurance (marathon) sessions */
function planEndurance(intake, profile, today, constraints) {
  const milestone = intake.milestones?.find((m) => m.kind === 'marathon') || intake.milestones?.[0];
  if (!milestone) return [];

  const daysAvailable = (constraints.daysAvailable || ['mo', 'tu', 'th', 'fr', 'sa']).map(toDay2);
  const restDays = (constraints.preferredRestDays || ['we', 'su']).map(toDay2);
  const maxMinutes = constraints.maxMinutesPerDay || 90;

  const milestoneDate = milestone.dateLocal;
  const totalDays = Math.ceil((new Date(milestoneDate) - new Date(today)) / (24 * 60 * 60 * 1000));
  const totalWeeks = Math.max(1, Math.floor(totalDays / 7));

  const taperWeeks = 2;
  const peakWeeks = 4;
  const buildWeeks = 6;
  const baseWeeks = Math.max(0, totalWeeks - taperWeeks - peakWeeks - buildWeeks);

  const baselineLR = profile?.workouts?.longestRunMinutes || 45;
  const baselineWeekly = profile?.workouts?.totalDurationMinutes || 120;
  const weeklyCap = maxMinutes * (daysAvailable.length || 4);
  const RAMP_CAP = 1.08;
  const LR_RATIO = 0.35;

  const sessions = [];
  let currentLR = baselineLR;
  let currentWeekly = baselineWeekly;

  for (let w = 0; w < totalWeeks; w++) {
    const weekStart = addDays(today, w * 7);
    const phase = w < baseWeeks ? 'base' : w < baseWeeks + buildWeeks ? 'build' : w < baseWeeks + buildWeeks + peakWeeks ? 'peak' : 'taper';

    let weekTarget = currentWeekly;
    if (phase === 'taper') weekTarget = Math.round(currentWeekly * 0.5);
    else if (phase !== 'base') weekTarget = Math.min(Math.round(currentWeekly * RAMP_CAP), weeklyCap);
    currentWeekly = weekTarget;
    if (w > 0 && w % 4 === 3 && phase !== 'taper') {
      weekTarget = Math.round(weekTarget * 0.8);
      currentWeekly = weekTarget;
    }

    const weekDays = [];
    for (let d = 0; d < 7; d++) {
      const dateStr = addDays(weekStart, d);
      const key = getDayKey(dateStr);
      const isRest = restDays.includes(key);
      const isAvail = daysAvailable.includes(key) && !isRest;
      weekDays.push({ dateStr, key, isRest, isAvail });
    }
    const availSlots = weekDays.filter((s) => s.isAvail);
    const usedDates = new Set();
    let hardCount = 0;

    if (phase !== 'taper' && availSlots.length >= 1) {
      const lrSlot = availSlots.find((s) => {
        const prev = addDays(s.dateStr, -1);
        const next = addDays(s.dateStr, 1);
        return !usedDates.has(prev) && !usedDates.has(next);
      }) || availSlots[availSlots.length - 1];
      const lrMin = phase === 'peak' ? Math.min(currentLR + 15, weekTarget * LR_RATIO) : phase === 'build' ? currentLR + 5 : currentLR;
      const lrDuration = Math.min(Math.round(lrMin), maxMinutes);
      sessions.push({
        id: `sess_${milestone.id}_w${w}_lr`,
        programId: milestone.id,
        milestoneId: milestone.id,
        weekIndex: w,
        localDate: lrSlot.dateStr,
        title: phase === 'peak' ? 'Long Run (MP segments)' : 'Long Run',
        kind: 'LR',
        targets: { durationMinutes: lrDuration, distanceMeters: null, intensity: 'easy' },
        status: 'planned',
        actualWorkoutId: null,
        calendar: { khalUid: null },
        ruleRefs: ['RULE_KEY_WORKOUT_PRIORITY', 'RULE_NO_BACK_TO_BACK_HARD'],
      });
      usedDates.add(lrSlot.dateStr);
      hardCount++;
      if (phase !== 'taper') currentLR = lrDuration;
    }

    const lrDate = sessions.filter((s) => s.weekIndex === w && s.kind === 'LR')[0]?.localDate;
    const hardAdjacent = lrDate ? new Set([addDays(lrDate, -1), addDays(lrDate, 1)]) : new Set();
    if (phase !== 'base' && phase !== 'taper' && hardCount < 2) {
      const tempoSlot = availSlots.find((s) => !usedDates.has(s.dateStr) && !hardAdjacent.has(s.dateStr));
      if (tempoSlot) {
        sessions.push({
          id: `sess_${milestone.id}_w${w}_tempo`,
          programId: milestone.id,
          milestoneId: milestone.id,
          weekIndex: w,
          localDate: tempoSlot.dateStr,
          title: phase === 'peak' ? 'Marathon Pace' : 'Tempo',
          kind: 'Tempo',
          targets: { durationMinutes: phase === 'peak' ? 35 : 30, distanceMeters: null, intensity: 'threshold' },
          status: 'planned',
          actualWorkoutId: null,
          calendar: { khalUid: null },
          ruleRefs: ['RULE_MARATHON_PHASE_BUILD'],
        });
        usedDates.add(tempoSlot.dateStr);
        hardCount++;
      }
    }

    const remaining = availSlots.filter((s) => !usedDates.has(s.dateStr));
    const z2PerWeek = phase === 'taper' ? 1 : 2;
    let z2Count = 0;
    for (const slot of remaining) {
      if (z2Count < z2PerWeek) {
        sessions.push({
          id: `sess_${milestone.id}_w${w}_z2_${z2Count}`,
          programId: milestone.id,
          milestoneId: milestone.id,
          weekIndex: w,
          localDate: slot.dateStr,
          title: 'Zone 2',
          kind: 'Z2',
          targets: { durationMinutes: Math.min(50, maxMinutes), distanceMeters: null, intensity: 'Z2' },
          status: 'planned',
          actualWorkoutId: null,
          calendar: { khalUid: null },
          ruleRefs: ['RULE_MARATHON_PHASE_BASE'],
        });
        z2Count++;
      } else {
        sessions.push({
          id: `sess_${milestone.id}_w${w}_str_${z2Count}`,
          programId: milestone.id,
          milestoneId: milestone.id,
          weekIndex: w,
          localDate: slot.dateStr,
          title: 'Full Body',
          kind: 'Strength',
          targets: { durationMinutes: Math.min(60, maxMinutes), setsReps: '3x8-12', intensity: 'moderate' },
          status: 'planned',
          actualWorkoutId: null,
          calendar: { khalUid: null },
          ruleRefs: ['RULE_MARATHON_PHASE_BASE'],
        });
      }
    }
  }
  return sessions;
}

/** Generate strength-only or general plan (4 weeks). No back-to-back Strength days. */
function planStrength(intake, profile, today, constraints) {
  const daysAvailable = (constraints.daysAvailable || ['mo', 'tu', 'th', 'fr', 'sa']).map(toDay2);
  const restDays = (constraints.preferredRestDays || ['we', 'su']).map(toDay2);
  const maxMinutes = constraints.maxMinutesPerDay || 90;
  const strengthPerWeek = profile?.workouts?.strengthCount ? Math.ceil(profile.workouts.strengthCount / 4) : 2;
  const totalWeeks = 4;
  const programId = 'strength_1';

  const sessions = [];
  const usedDates = new Set();

  for (let w = 0; w < totalWeeks; w++) {
    const weekStart = addDays(today, w * 7);
    const weekDays = [];
    for (let d = 0; d < 7; d++) {
      const dateStr = addDays(weekStart, d);
      const key = getDayKey(dateStr);
      const isRest = restDays.includes(key);
      const isAvail = daysAvailable.includes(key) && !isRest;
      weekDays.push({ dateStr, key, isRest, isAvail });
    }
    const availSlots = weekDays.filter((s) => s.isAvail);
    let strCount = 0;
    let z2Count = 0;

    for (const slot of availSlots) {
      const prev = addDays(slot.dateStr, -1);
      const next = addDays(slot.dateStr, 1);
      const adjHasStrength = usedDates.has(prev) || usedDates.has(next);

      if (strCount < strengthPerWeek && !adjHasStrength) {
        sessions.push({
          id: `sess_${programId}_w${w}_str_${strCount}`,
          programId,
          weekIndex: w,
          localDate: slot.dateStr,
          title: strCount === 0 ? 'Full Body A' : 'Full Body B',
          kind: 'Strength',
          targets: { durationMinutes: Math.min(60, maxMinutes), setsReps: '3x8-12', intensity: 'moderate' },
          status: 'planned',
          actualWorkoutId: null,
          calendar: { khalUid: null },
          ruleRefs: ['RULE_STRENGTH_PROGRESSION', 'RULE_NO_BACK_TO_BACK_HARD'],
        });
        usedDates.add(slot.dateStr);
        strCount++;
      } else if (z2Count < 2) {
        sessions.push({
          id: `sess_${programId}_w${w}_z2_${z2Count}`,
          programId,
          weekIndex: w,
          localDate: slot.dateStr,
          title: 'Zone 2',
          kind: 'Z2',
          targets: { durationMinutes: Math.min(45, maxMinutes), intensity: 'Z2' },
          status: 'planned',
          actualWorkoutId: null,
          calendar: { khalUid: null },
          ruleRefs: ['RULE_CARDIO_SUPPORT'],
        });
        z2Count++;
      }
    }
  }
  return sessions;
}

/** Generate habit recommendations for sleep/bodycomp */
function planHabits(goals) {
  const recs = [];
  if (goals.some((g) => g.kind === 'sleep')) {
    recs.push({ kind: 'sleep', title: 'Sleep protocol', text: 'Aim for 7–9h; Deep >50min, REM >100min. Consistent bedtime.' });
  }
  if (goals.some((g) => g.kind === 'bodycomp')) {
    recs.push({ kind: 'bodycomp', title: 'Nutrition', text: 'Protein ~1.8g/kg; carbs around training; avoid late fat.' });
  }
  return recs;
}

function main() {
  ensureDir(COACH_ROOT);

  const intake = loadJson(INTAKE_FILE);
  const profile = loadJson(PROFILE_FILE);
  const workouts = loadJsonlFiles('workouts_');

  if (!intake) {
    console.error('No intake.json. Run onboarding first.');
    process.exit(1);
  }

  const { hasEndurance, hasStrength, hasSleep, hasBodycomp, hasGeneral, enduranceMilestone } = resolveGoals(intake);
  const constraints = intake.constraints || {};
  const today = new Date().toLocaleDateString('en-CA', { timeZone: TZ });

  let sessions = [];
  const recommendations = planHabits(intake.goals || []);

  if (hasEndurance && enduranceMilestone) {
    sessions = planEndurance(intake, profile, today, constraints);
  } else if (hasStrength || hasGeneral) {
    sessions = planStrength(intake, profile, today, constraints);
  } else {
    sessions = planStrength(intake, profile, today, constraints);
  }

  const historyWorkouts = workouts.map((w) => ({
    id: (typeof w.id === 'string' && w.id.startsWith('salvor:')) ? w.id : `salvor:${w.id}`,
    type: w.workout_type || w.workoutType || w.type || 'Workout',
    startTimeUtc: w.startTimeUtc || w.start_time || w.startTime || w.start,
    localDate: w.localDate || w.date,
    durationSeconds: w.duration_seconds ?? w.durationSeconds ?? w.duration ?? 0,
    distanceMeters: w.distance_meters ?? w.distanceMeters ?? null,
    avgHeartRate: w.avg_heart_rate ?? w.avgHeartRate ?? null,
    source: w.source || 'salvor',
  }));

  const calendar = {
    schemaVersion: '1.1',
    timeZone: TZ,
    generatedAt: new Date().toISOString(),
    sources: { salvor: { baseUrl: 'https://api.salvor.eu', lastSyncAt: loadJson(path.join(COACH_ROOT, 'salvor_sync_state.json'))?.lastSuccessfulSyncAt || null } },
    goals: intake.goals || [],
    milestones: intake.milestones || [],
    history: { workouts: historyWorkouts },
    plan: { sessions, recommendations },
    adaptation: { events: [] },
  };

  fs.writeFileSync(CALENDAR_FILE, JSON.stringify(calendar, null, 2), 'utf8');

  const nextWeekSessions = sessions.filter((s) => {
    const d = new Date(s.localDate + 'T12:00:00');
    const t = new Date(today + 'T12:00:00');
    const diff = (d - t) / (24 * 60 * 60 * 1000);
    return diff >= 0 && diff < 7;
  });
  ensureDir(path.join(WORKSPACE, 'current'));
  fs.writeFileSync(
    path.join(WORKSPACE, 'current', 'training_plan_week.json'),
    JSON.stringify({ updatedAt: new Date().toISOString(), weekStart: today, sessions: nextWeekSessions }, null, 2),
    'utf8'
  );

  const milestoneInfo = enduranceMilestone ? enduranceMilestone.dateLocal : 'general';
  console.log('Plan generated. Sessions:', sessions.length, 'Recommendations:', recommendations.length, 'Milestone:', milestoneInfo);
}

main();
