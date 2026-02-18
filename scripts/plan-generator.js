#!/usr/bin/env node
/**
 * Multi-program plan generator. Orchestrates endurance, strength, habit planners
 * with global guardrails. Supports intake v3 (goals[], fixedAppointments, strengthSplitPreference).
 * Output: workout_calendar.json.
 */

const fs = require('fs');
const path = require('path');
const { validateIntakeV3 } = require('./intake-validation');

const WORKSPACE = process.env.OPENCLAW_WORKSPACE || path.join(process.env.HOME || '/root', '.openclaw/workspace');
const COACH_ROOT = path.join(WORKSPACE, 'health', 'coach');
const CACHE_DIR = path.join(COACH_ROOT, 'salvor_cache');
const INTAKE_FILE = path.join(COACH_ROOT, 'intake.json');
const PROFILE_FILE = path.join(COACH_ROOT, 'profile.json');
const CALENDAR_FILE = path.join(COACH_ROOT, 'workout_calendar.json');
const TZ = 'Europe/Berlin';

const DAY_TO_KEY = { 0: 'su', 1: 'mo', 2: 'tu', 3: 'we', 4: 'th', 5: 'fr', 6: 'sa' };
const HARD_KINDS = ['LR', 'Tempo', 'Intervals', 'Strength'];
const MAX_HARD_PER_WEEK = 3;
const RAMP_CAP_WEEKLY = 1.08;

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
  const x = String(d).toLowerCase().slice(0, 3);
  const m = { mon: 'mo', tue: 'tu', wed: 'we', thu: 'th', fri: 'fr', sat: 'sa', sun: 'su', mo: 'mo', tu: 'tu', we: 'we', th: 'th', fr: 'fr', sa: 'sa', su: 'su' };
  return m[x] || x.slice(0, 2);
}

/** Resolve goals and primary endurance milestone */
function resolveGoals(intake) {
  const goals = intake.goals || [];
  const milestones = intake.milestones || [];
  const enduranceGoals = goals.filter((g) => g.kind === 'endurance');
  const hasEndurance = milestones.some((m) => m.kind === 'marathon') || enduranceGoals.length > 0;
  const hasStrength = goals.some((g) => g.kind === 'strength');
  const hasSleep = goals.some((g) => g.kind === 'sleep');
  const hasBodycomp = goals.some((g) => g.kind === 'bodycomp');
  const hasGeneral = goals.some((g) => g.kind === 'general') || (goals.length === 0 && milestones.length === 0);
  const enduranceMilestone = milestones.find((m) => m.kind === 'marathon') || milestones[0]
    || enduranceGoals.find((g) => g.dateLocal) || enduranceGoals[0];
  return { hasEndurance, hasStrength, hasSleep, hasBodycomp, hasGeneral, enduranceMilestone, enduranceGoals };
}

/** Fixed appointments: return Set of blocked date strings for a date range */
function getFixedAppointmentSlots(constraints, startDate, endDate) {
  const blocked = new Set();
  const fixed = constraints.fixedAppointments || [];
  const today = new Date(startDate + 'T12:00:00');
  const end = new Date(endDate + 'T12:00:00');
  for (const fa of fixed) {
    const dayKey = toDay2(fa.dayOfWeek || '');
    if (!dayKey) continue;
    const seasonStart = (fa.seasonStart || fa.startDate) ? new Date((fa.seasonStart || fa.startDate) + 'T12:00:00') : null;
    const seasonEnd = (fa.seasonEnd || fa.endDate) ? new Date((fa.seasonEnd || fa.endDate) + 'T12:00:00') : null;
    let cur = new Date(today.getTime());
    while (cur <= end) {
      const dateStr = cur.toLocaleDateString('en-CA', { timeZone: TZ });
      const dk = getDayKey(dateStr);
      if (dk === dayKey) {
        if (!seasonStart || !seasonEnd || (cur >= seasonStart && cur <= seasonEnd)) {
          blocked.add(dateStr);
        }
      }
      cur.setDate(cur.getDate() + 1);
    }
  }
  return blocked;
}

/** Build week slots: available days minus rest and fixed appointments */
function buildWeekSlots(weekStart, daysAvailable, restDays, blockedDates) {
  const weekDays = [];
  for (let d = 0; d < 7; d++) {
    const dateStr = addDays(weekStart, d);
    const key = getDayKey(dateStr);
    const isRest = restDays.includes(key);
    const isBlocked = blockedDates.has(dateStr);
    const isAvail = daysAvailable.includes(key) && !isRest && !isBlocked;
    weekDays.push({ dateStr, key, isRest, isBlocked, isAvail });
  }
  return weekDays.filter((s) => s.isAvail);
}

/** Endurance planner: marathon, half, 10k, 5k, cycling, triathlon. When hasStrength, reserves Strength slots not adjacent to LR/Tempo. */
function planEndurance(intake, profile, today, constraints, blockedDates, hasStrength = false) {
  const goals = intake.goals || [];
  const milestones = intake.milestones || [];
  const enduranceGoal = goals.find((g) => g.kind === 'endurance') || milestones[0];
  if (!enduranceGoal?.dateLocal) return [];

  const subKind = enduranceGoal.subKind || 'marathon';
  const daysAvailable = (constraints.daysAvailable || []).map(toDay2);
  const restDays = (constraints.preferredRestDays || []).map(toDay2);
  const maxMinutes = constraints.maxMinutesPerDay || 90;
  const maxSessionsPerWeek = constraints.maxSessionsPerWeek;

  const milestoneDate = enduranceGoal.dateLocal;
  const totalDays = Math.ceil((new Date(milestoneDate) - new Date(today)) / (24 * 60 * 60 * 1000));
  const totalWeeks = Math.max(1, Math.floor(totalDays / 7));

  const phaseLengths = {
    marathon: { taper: 2, peak: 4, build: 6 },
    half: { taper: 1, peak: 3, build: 5 },
    '10k': { taper: 1, peak: 2, build: 4 },
    '5k': { taper: 1, peak: 2, build: 3 },
    cycling: { taper: 1, peak: 3, build: 6 },
    triathlon_sprint: { taper: 1, peak: 2, build: 4 },
    triathlon_olympic: { taper: 1, peak: 3, build: 6 },
    triathlon_703: { taper: 2, peak: 4, build: 8 },
    triathlon_ironman: { taper: 2, peak: 4, build: 10 },
  };
  const phases = phaseLengths[subKind === 'triathlon_70.3' ? 'triathlon_703' : subKind] || phaseLengths.marathon;
  const baseWeeks = Math.max(0, totalWeeks - phases.taper - phases.peak - phases.build);

  const baselineLR = Math.max(45, intake.baseline?.longestRecentRunMinutes ?? profile?.workouts?.longestRunMinutes ?? 45);
  const baselineWeekly = profile?.workouts?.totalDurationMinutes || 120;
  const weeklyCap = maxMinutes * (daysAvailable.length || 4);
  const LR_RATIO = 0.35;
  const LR_PEAK_TARGET = 150;
  const LR_END_BASE = 90;

  const baseWeeksEffective = Math.max(1, baseWeeks);
  const buildWeeksEffective = Math.max(1, phases.build);
  const baseGainPerWeek = baseWeeks > 0 ? Math.min(5, Math.max(0, (LR_END_BASE - baselineLR) / baseWeeksEffective)) : 0;
  const buildStartLR = baseWeeks > 0 ? LR_END_BASE : baselineLR;
  const buildGainPerWeek = Math.min(15, Math.max(5, (LR_PEAK_TARGET - buildStartLR) / buildWeeksEffective));

  const sessions = [];
  let currentLR = baselineLR;
  let currentWeekly = baselineWeekly;
  const programId = enduranceGoal.id || 'endurance_1';

  for (let w = 0; w < totalWeeks; w++) {
    const weekStart = addDays(today, w * 7);
    const weekEnd = addDays(weekStart, 6);
    const blocked = getFixedAppointmentSlots(constraints, weekStart, weekEnd);
    const availSlots = buildWeekSlots(weekStart, daysAvailable, restDays, blocked);

    const phase = w < baseWeeks ? 'base' : w < baseWeeks + phases.build ? 'build' : w < baseWeeks + phases.build + phases.peak ? 'peak' : 'taper';

    let weekTarget = currentWeekly;
    if (phase === 'taper') weekTarget = Math.round(currentWeekly * 0.5);
    else if (phase !== 'base') weekTarget = Math.min(Math.round(currentWeekly * RAMP_CAP_WEEKLY), weeklyCap);
    currentWeekly = weekTarget;
    if (w > 0 && w % 4 === 3 && phase !== 'taper') {
      weekTarget = Math.round(weekTarget * 0.8);
      currentWeekly = weekTarget;
    }

    let usedDates = new Set();
    let hardCount = 0;
    let remaining = [...availSlots];
    if (maxSessionsPerWeek != null) remaining = remaining.slice(0, maxSessionsPerWeek);

    if (phase !== 'taper' && remaining.length >= 1) {
      const lrSlot = remaining.find((s) => {
        const prev = addDays(s.dateStr, -1);
        const next = addDays(s.dateStr, 1);
        return !usedDates.has(prev) && !usedDates.has(next);
      }) || remaining[remaining.length - 1];
      let lrMin = currentLR;
      if (phase === 'base') {
        lrMin = baselineLR + (w + 1) * baseGainPerWeek;
      } else if (phase === 'build') {
        const buildWeekIndex = w - baseWeeks;
        lrMin = buildStartLR + (buildWeekIndex + 1) * buildGainPerWeek;
      } else if (phase === 'peak') {
        lrMin = Math.min(currentLR + 2, LR_PEAK_TARGET);
      }
      const isCutback = w > 0 && w % 4 === 3 && phase !== 'taper';
      const lrCap = Math.min(LR_PEAK_TARGET, 180, (maxMinutes || 90) * 2);
      const lrDuration = Math.min(Math.round(isCutback ? lrMin * 0.8 : lrMin), lrCap);
      sessions.push({
        id: `sess_${programId}_w${w}_lr`,
        programId,
        milestoneId: enduranceGoal.id,
        weekIndex: w,
        localDate: lrSlot.dateStr,
        title: phase === 'peak' ? 'Long Run (MP segments)' : 'Long Run',
        kind: 'LR',
        hardness: 'hard',
        requiresRecovery: true,
        targets: { durationMinutes: lrDuration, distanceMeters: null, intensity: 'easy' },
        status: 'planned',
        actualWorkoutId: null,
        calendar: { khalUid: null },
        ruleRefs: ['RULE_KEY_WORKOUT_PRIORITY', 'RULE_NO_BACK_TO_BACK_HARD'],
      });
      usedDates.add(lrSlot.dateStr);
      hardCount++;
      if (phase !== 'taper') currentLR = isCutback ? lrMin : lrDuration;
    }

    const lrDate = sessions.filter((s) => s.weekIndex === w && s.kind === 'LR')[0]?.localDate;
    const hardAdjacent = lrDate ? new Set([addDays(lrDate, -1), addDays(lrDate, 1)]) : new Set();
    if (phase !== 'base' && phase !== 'taper' && hardCount < 2) {
      const tempoSlot = remaining.find((s) => !usedDates.has(s.dateStr) && !hardAdjacent.has(s.dateStr));
      if (tempoSlot && hardCount < MAX_HARD_PER_WEEK) {
        sessions.push({
          id: `sess_${programId}_w${w}_tempo`,
          programId,
          milestoneId: enduranceGoal.id,
          weekIndex: w,
          localDate: tempoSlot.dateStr,
          title: phase === 'peak' ? 'Marathon Pace' : 'Tempo',
          kind: 'Tempo',
          hardness: 'hard',
          requiresRecovery: true,
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

    const tempoDate = sessions.filter((s) => s.weekIndex === w && s.kind === 'Tempo')[0]?.localDate;
    if (tempoDate) {
      hardAdjacent.add(addDays(tempoDate, -1));
      hardAdjacent.add(addDays(tempoDate, 1));
    }

    if (phase !== 'base' && phase !== 'taper' && hardCount < MAX_HARD_PER_WEEK && w % 2 === 1) {
      const intervalSlot = remaining.find((s) => !usedDates.has(s.dateStr) && !hardAdjacent.has(s.dateStr));
      if (intervalSlot) {
        sessions.push({
          id: `sess_${programId}_w${w}_intervals`,
          programId,
          milestoneId: enduranceGoal.id,
          weekIndex: w,
          localDate: intervalSlot.dateStr,
          title: 'Intervals (5K pace)',
          kind: 'Intervals',
          hardness: 'hard',
          requiresRecovery: true,
          targets: { durationMinutes: 35, workBouts: '6x1min', recovery: '1min jog', intensity: 'VO2max' },
          status: 'planned',
          actualWorkoutId: null,
          calendar: { khalUid: null },
          ruleRefs: ['RULE_MARATHON_PHASE_BUILD', 'RULE_HIIT_FREQUENCY', 'RULE_KEY_WORKOUT_PRIORITY'],
        });
        usedDates.add(intervalSlot.dateStr);
        hardCount++;
        hardAdjacent.add(addDays(intervalSlot.dateStr, -1));
        hardAdjacent.add(addDays(intervalSlot.dateStr, 1));
      }
    }

    remaining = remaining.filter((s) => !usedDates.has(s.dateStr));
    if (maxSessionsPerWeek != null) {
      const cap = Math.max(0, maxSessionsPerWeek - usedDates.size);
      remaining = remaining.slice(0, cap);
    }

    const strengthPerWeek = hasStrength ? (intake.baseline?.strengthFrequencyPerWeek ?? profile?.workouts?.strengthCount ? Math.ceil(profile.workouts.strengthCount / 4) : 2) : 0;
    const strengthCandidates = remaining.filter((s) => !hardAdjacent.has(s.dateStr));
    const strengthSlots = [];
    for (const slot of strengthCandidates) {
      if (strengthSlots.length >= strengthPerWeek) break;
      const adj = [addDays(slot.dateStr, -1), addDays(slot.dateStr, 1)];
      const hasAdjacentStrength = strengthSlots.some((ss) => adj.includes(ss.dateStr));
      if (!hasAdjacentStrength) strengthSlots.push(slot);
    }
    const z2Slots = remaining.filter((s) => !strengthSlots.some((ss) => ss.dateStr === s.dateStr));
    const z2PerWeek = phase === 'taper' ? 1 : 2;

    for (const slot of strengthSlots) {
      const split = intake.baseline?.strengthSplitPreference || 'full_body';
      const splitTitles = { full_body: ['Full Body A', 'Full Body B'], upper_lower: ['Upper', 'Lower'], push_pull_legs: ['Push', 'Pull', 'Legs'], bro_split: ['Chest/Triceps', 'Back/Biceps', 'Legs', 'Shoulders'] };
      const titles = splitTitles[split] || splitTitles.full_body;
      const strIdx = sessions.filter((x) => x.weekIndex === w && x.kind === 'Strength').length;
      sessions.push({
        id: `sess_${programId}_w${w}_str_${strIdx}`,
        programId,
        milestoneId: enduranceGoal.id,
        weekIndex: w,
        localDate: slot.dateStr,
        title: titles[strIdx % titles.length],
        kind: 'Strength',
        hardness: 'hard',
        requiresRecovery: true,
        targets: { durationMinutes: Math.min(60, maxMinutes), setsReps: '3x8-12', intensity: 'moderate' },
        status: 'planned',
        actualWorkoutId: null,
        calendar: { khalUid: null },
        ruleRefs: ['RULE_STRENGTH_PROGRESSION', 'RULE_NO_BACK_TO_BACK_HARD'],
      });
    }

    let z2Count = 0;
    for (const slot of z2Slots) {
      if (z2Count < z2PerWeek) {
        sessions.push({
          id: `sess_${programId}_w${w}_z2_${z2Count}`,
          programId,
          milestoneId: enduranceGoal.id,
          weekIndex: w,
          localDate: slot.dateStr,
          title: 'Zone 2',
          kind: 'Z2',
          hardness: 'easy',
          requiresRecovery: false,
          targets: { durationMinutes: Math.min(50, maxMinutes), distanceMeters: null, intensity: 'Z2' },
          status: 'planned',
          actualWorkoutId: null,
          calendar: { khalUid: null },
          ruleRefs: ['RULE_MARATHON_PHASE_BASE'],
        });
        z2Count++;
      }
    }
  }
  return sessions;
}

/** Strength planner: split-aware (full_body, upper_lower, push_pull_legs, bro_split) */
function planStrength(intake, profile, today, constraints, blockedDates) {
  const daysAvailable = (constraints.daysAvailable || []).map(toDay2);
  const restDays = (constraints.preferredRestDays || []).map(toDay2);
  const maxSessionsPerWeek = constraints.maxSessionsPerWeek;
  const maxMinutes = constraints.maxMinutesPerDay || 90;
  const strengthPerWeek = profile?.workouts?.strengthCount ? Math.ceil(profile.workouts.strengthCount / 4) : 2;
  const split = intake.baseline?.strengthSplitPreference || 'full_body';
  const totalWeeks = 4;
  const programId = 'strength_1';

  const splitTitles = {
    full_body: ['Full Body A', 'Full Body B'],
    upper_lower: ['Upper', 'Lower'],
    push_pull_legs: ['Push', 'Pull', 'Legs'],
    bro_split: ['Chest/Triceps', 'Back/Biceps', 'Legs', 'Shoulders'],
  };
  const titles = splitTitles[split] || splitTitles.full_body;

  const sessions = [];
  const usedDates = new Set();

  for (let w = 0; w < totalWeeks; w++) {
    const weekStart = addDays(today, w * 7);
    const weekEnd = addDays(weekStart, 6);
    const blocked = getFixedAppointmentSlots(constraints, weekStart, weekEnd);
    let availSlots = buildWeekSlots(weekStart, daysAvailable, restDays, blocked);
    if (maxSessionsPerWeek != null) availSlots = availSlots.slice(0, maxSessionsPerWeek);
    let strCount = 0;
    let z2Count = 0;

    for (const slot of availSlots) {
      const prev = addDays(slot.dateStr, -1);
      const next = addDays(slot.dateStr, 1);
      const adjHasStrength = usedDates.has(prev) || usedDates.has(next);

      if (strCount < strengthPerWeek && !adjHasStrength) {
        const title = titles[strCount % titles.length];
        sessions.push({
          id: `sess_${programId}_w${w}_str_${strCount}`,
          programId,
          weekIndex: w,
          localDate: slot.dateStr,
          title,
          kind: 'Strength',
          hardness: 'hard',
          requiresRecovery: true,
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
          hardness: 'easy',
          requiresRecovery: false,
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

/** Habit planner: sleep/bodycomp protocols */
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

/** Global guardrails: no back-to-back hard days, enforce max hard per week */
function applyGuardrails(sessions) {
  const byDate = {};
  for (const s of sessions) {
    if (!byDate[s.localDate]) byDate[s.localDate] = [];
    byDate[s.localDate].push(s);
  }
  const dates = Object.keys(byDate).sort();
  const toRemove = new Set();

  for (let i = 1; i < dates.length; i++) {
    const prev = byDate[dates[i - 1]];
    const curr = byDate[dates[i]];
    const prevHard = prev.some((s) => HARD_KINDS.includes(s.kind));
    const currHard = curr.some((s) => HARD_KINDS.includes(s.kind));
    const dayDiff = (new Date(dates[i]) - new Date(dates[i - 1])) / (24 * 60 * 60 * 1000);
    if (prevHard && currHard && dayDiff === 1) {
      const currSessions = curr.filter((s) => HARD_KINDS.includes(s.kind));
      for (const s of currSessions) toRemove.add(s.id);
    }
  }

  const byWeek = {};
  for (const s of sessions) {
    const w = s.weekIndex;
    if (!byWeek[w]) byWeek[w] = [];
    byWeek[w].push(s);
  }
  for (const weekSessions of Object.values(byWeek)) {
    const hard = weekSessions.filter((s) => HARD_KINDS.includes(s.kind));
    if (hard.length > MAX_HARD_PER_WEEK) {
      for (const s of hard.slice(MAX_HARD_PER_WEEK)) toRemove.add(s.id);
    }
  }

  return sessions.filter((s) => !toRemove.has(s.id));
}

/** Multi-program orchestrator */
function orchestrate(intake, profile, today, constraints) {
  const endDate = addDays(today, 365);
  const blockedDates = getFixedAppointmentSlots(constraints, today, endDate);

  const { hasEndurance, hasStrength, hasSleep, hasBodycomp, hasGeneral, enduranceMilestone } = resolveGoals(intake);
  const recommendations = planHabits(intake.goals || []);

  let sessions = [];
  if (hasEndurance && enduranceMilestone) {
    sessions = planEndurance(intake, profile, today, constraints, blockedDates, hasStrength);
  } else if (hasStrength || hasGeneral) {
    sessions = planStrength(intake, profile, today, constraints, blockedDates);
  } else {
    sessions = planStrength(intake, profile, today, constraints, blockedDates);
  }

  sessions = applyGuardrails(sessions);
  return { sessions, recommendations };
}

function main() {
  ensureDir(COACH_ROOT);

  const intake = loadJson(INTAKE_FILE);
  const profile = loadJson(PROFILE_FILE);
  const workouts = loadJsonlFiles('workouts_');

  if (!intake) {
    console.error('INTAKE: intake.json missing. Run onboarding first.');
    process.exit(1);
  }

  const { valid, errors } = validateIntakeV3(intake);
  if (!valid) {
    console.error('INTAKE VALIDATION FAILED:');
    errors.forEach((e) => console.error('  -', e));
    process.exit(1);
  }

  const constraints = intake.constraints || {};
  const today = new Date().toLocaleDateString('en-CA', { timeZone: TZ });
  const { sessions, recommendations } = orchestrate(intake, profile, today, constraints);

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
    schemaVersion: '1.2',
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
  const { getStatus } = require('./status-helper');
  const currentStatus = getStatus();
  ensureDir(path.join(WORKSPACE, 'current'));
  fs.writeFileSync(
    path.join(WORKSPACE, 'current', 'training_plan_week.json'),
    JSON.stringify({
      updatedAt: new Date().toISOString(),
      weekStart: today,
      sessions: nextWeekSessions,
      status: currentStatus ? { status: currentStatus.status, until: currentStatus.until, note: currentStatus.note } : null,
    }, null, 2),
    'utf8'
  );

  const { enduranceMilestone } = resolveGoals(intake);
  const milestoneInfo = enduranceMilestone ? enduranceMilestone.dateLocal : 'general';
  console.log('Plan generated. Sessions:', sessions.length, 'Recommendations:', recommendations.length, 'Milestone:', milestoneInfo);
}

main();
