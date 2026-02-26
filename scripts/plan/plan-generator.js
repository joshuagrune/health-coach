#!/usr/bin/env node
/**
 * Rolling plan generator (simple version).
 *
 * - Plans exact dates for next 7 days only.
 * - Uses last 7 days of workout history to adapt intensity/load.
 * - Keeps one calendar output with modality-tagged sessions.
 */

const fs = require('fs');
const path = require('path');
const { validateIntakeV3 } = require('../lib/intake-validation');
const { getWorkspace, getCoachRoot, loadJson, loadJsonlFiles } = require('../lib/cache-io');
const { shouldExcludeFromLoad, computeACWR, workoutModalityClass } = require('../lib/workout-utils');

const WORKSPACE = getWorkspace();
const COACH_ROOT = getCoachRoot();
const INTAKE_FILE = path.join(COACH_ROOT, 'intake.json');
const PROFILE_FILE = path.join(COACH_ROOT, 'profile.json');
const CALENDAR_FILE = path.join(COACH_ROOT, 'workout_calendar.json');
const TZ = 'Europe/Berlin';

const DAY_TO_KEY = { 0: 'su', 1: 'mo', 2: 'tu', 3: 'we', 4: 'th', 5: 'fr', 6: 'sa' };
const HARD_KINDS = new Set(['LR', 'Tempo', 'Intervals', 'Strength']);
const ENDURANCE_KINDS = new Set(['LR', 'Tempo', 'Intervals', 'Z2', 'Cycling', 'Swim', 'Bike', 'Brick']);

function ensureDir(dir) {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

function addDays(dateStr, days) {
  const d = new Date(dateStr + 'T12:00:00');
  d.setDate(d.getDate() + days);
  return d.toLocaleDateString('en-CA', { timeZone: TZ });
}

function diffDays(a, b) {
  return Math.round((new Date(a + 'T12:00:00') - new Date(b + 'T12:00:00')) / (24 * 60 * 60 * 1000));
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

function modalityFromKind(kind) {
  return kind === 'Strength' ? 'strength' : 'endurance';
}

function isHardKind(kind) {
  return HARD_KINDS.has(kind);
}

function isEnduranceKind(kind) {
  return ENDURANCE_KINDS.has(kind);
}


function resolveGoals(intake) {
  const goals = intake.goals || [];
  const milestones = intake.milestones || [];
  const enduranceGoals = goals.filter((g) => g.kind === 'endurance');
  const hasEndurance = milestones.some((m) => m.kind === 'marathon') || enduranceGoals.length > 0;
  const hasStrength = goals.some((g) => g.kind === 'strength');
  const hasGeneral = goals.some((g) => g.kind === 'general') || (goals.length === 0 && milestones.length === 0);
  const enduranceMilestone = milestones.find((m) => m.kind === 'marathon') || milestones[0]
    || enduranceGoals.find((g) => g.dateLocal) || enduranceGoals[0] || null;
  return { hasEndurance, hasStrength, hasGeneral, enduranceMilestone };
}

function getFixedAppointmentSlots(constraints, startDate, endDate) {
  const blocked = new Set();
  const fixed = constraints.fixedAppointments || [];
  const start = new Date(startDate + 'T12:00:00');
  const end = new Date(endDate + 'T12:00:00');

  for (const fa of fixed) {
    const dayKey = toDay2(fa.dayOfWeek || '');
    if (!dayKey) continue;

    const seasonStart = (fa.seasonStart || fa.startDate) ? new Date((fa.seasonStart || fa.startDate) + 'T12:00:00') : null;
    const seasonEnd = (fa.seasonEnd || fa.endDate) ? new Date((fa.seasonEnd || fa.endDate) + 'T12:00:00') : null;

    let cur = new Date(start.getTime());
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

function buildRollingSlots(today, constraints) {
  const daysAvailable = (constraints.daysAvailable || []).map(toDay2);
  const restDays = (constraints.preferredRestDays || []).map(toDay2);
  const weekEnd = addDays(today, 6);
  const blockedDates = getFixedAppointmentSlots(constraints, today, weekEnd);

  const slots = [];
  for (let d = 0; d < 7; d++) {
    const dateStr = addDays(today, d);
    const key = getDayKey(dateStr);
    const isRest = restDays.includes(key);
    const isBlocked = blockedDates.has(dateStr);
    const isAvail = daysAvailable.includes(key) && !isRest && !isBlocked;
    if (isAvail) slots.push({ dateStr, key });
  }

  const maxSessionsPerWeek = constraints.maxSessionsPerWeek;
  return maxSessionsPerWeek != null ? slots.slice(0, Math.max(0, maxSessionsPerWeek)) : slots;
}

function normalizeWorkout(raw) {
  const zones = raw.heart_rate_zones || raw.heartRateZones || null;
  const hrHigh = raw.hr_zone_high_minutes ?? raw.hrZoneHighMinutes ?? extractHighZoneMinutes(zones);
  const effort = raw.effort_score ?? raw.effortScore;
  return {
    type: (raw.workout_type || raw.workoutType || raw.type || 'Workout').toLowerCase(),
    localDate: raw.localDate || raw.date || (raw.startTimeUtc ? new Date(raw.startTimeUtc).toLocaleDateString('en-CA', { timeZone: TZ }) : null),
    durationMinutes: Math.round((raw.duration_seconds ?? raw.durationSeconds ?? raw.duration ?? 0) / 60),
    hrHighMinutes: Number.isFinite(Number(hrHigh)) ? Number(hrHigh) : null,
    effortScore: Number.isFinite(Number(effort)) ? Number(effort) : null,
    classification: (raw.classification || '').toLowerCase(),
  };
}

function extractHighZoneMinutes(zones) {
  if (!zones || typeof zones !== 'object') return null;
  const keys = ['z4', 'zone4', '4', 'z5', 'zone5', '5'];
  let total = 0;
  let found = false;

  const toMinutes = (val) => {
    if (val == null) return null;
    if (typeof val === 'number') return val >= 0 ? val : null;
    if (typeof val === 'object' && val.duration_seconds != null) {
      const s = Number(val.duration_seconds);
      return Number.isFinite(s) && s >= 0 ? (s / 60) : null;
    }
    const n = Number(val);
    return Number.isFinite(n) && n >= 0 ? n : null;
  };

  for (const k of keys) {
    const mins = toMinutes(zones[k]);
    if (mins != null) {
      total += mins;
      found = true;
    }
  }
  return found ? Math.round(total) : null;
}

/**
 * Hard workout = requires 1 day recovery.
 * Data-driven: effort (RPE), classification, HR zones, duration. Type only as fallback when no vitals.
 */
function isHardWorkout(w) {
  if (!w || !w.type) return false;
  const dur = w.durationMinutes || 0;
  const effort = w.effortScore;
  const hrHigh = w.hrHighMinutes;
  const hasVitals = effort != null || hrHigh != null || (w.classification || '').trim().length > 0;

  // 1. Effort (RPE 7+ = hard)
  if (effort != null && effort >= 7) return true;

  // 2. Classification (auto or user-set)
  if (/tempo|interval|zone4|zone5|mixed|threshold|vo2max/.test(w.classification || '')) return true;

  // 3. HR zones — type-agnostic; long sessions use ratio to avoid "16 min Z4+Z5 in 170 min" = hard
  if (hrHigh != null) {
    if (dur > 90) {
      const ratio = hrHigh / dur;
      if (ratio >= 0.15) return true;   // 15%+ of time in Z4+Z5
      if (hrHigh >= 20) return true;    // or 20+ min absolute
      if (effort != null && effort >= 6) return true;  // user said moderate-hard
      return false;
    }
    if (hrHigh >= 8) return true;
    if (hrHigh >= 5 && dur >= 30) return true;
  }

  // 4. Fallback: only when NO vitals — guess from type (conservative)
  if (!hasVitals) {
    if (/tempo|interval|hiit|crossfit|volleyball|soccer|basketball|handball|martial|boxing|kickbox/.test(w.type)) return true;
    if (/strength|functional|gym|climbing/.test(w.type)) return true;
    if (/running|cycling|bike/.test(w.type) && dur >= 50) return true;
  }
  return false;
}

/**
 * Very hard = requires 2 days recovery instead of 1.
 * Criteria: RPE 8+, Z4+Z5 dominant (>20 min), long hard effort (>80 min).
 */
function isVeryHardWorkout(w) {
  if (!w) return false;
  if (w.effortScore != null && w.effortScore >= 8) return true;
  if (w.hrHighMinutes != null && w.hrHighMinutes >= 20) return true;
  if (w.durationMinutes >= 80 && isHardWorkout(w)) return true;
  return false;
}

/**
 * Derive max hard sessions per rolling 7-day window.
 * Explicit intake setting overrides fitness-based default.
 * Fitness levels: low=2, moderate=3, high=4, advanced=5.
 */
function deriveMaxHard(intake) {
  if (intake.baseline?.maxHardSessionsPerWeek != null) {
    return intake.baseline.maxHardSessionsPerWeek;
  }
  return { low: 2, moderate: 3, high: 4, advanced: 5 }[intake.baseline?.perceivedFitness || 'moderate'] ?? 3;
}

function collectRecentSignals(workouts, today, scores = null) {
  const normalized = workouts.map(normalizeWorkout).filter((w) => !!w.localDate);
  const recent = normalized.filter((w) => {
    const delta = diffDays(today, w.localDate);
    return delta >= 0 && delta <= 6;
  });

  const hardDates = new Set();
  const veryHardDates = new Set();
  const completedDates = new Set();
  let totalMinutes = 0;
  let hardCount = 0;
  let completedEndurance = 0;
  let completedStrength = 0;

  for (const w of recent) {
    completedDates.add(w.localDate);
    if (!shouldExcludeFromLoad(w)) totalMinutes += Math.max(0, w.durationMinutes || 0);
    if (isHardWorkout(w)) {
      hardCount++;
      hardDates.add(w.localDate);
      if (isVeryHardWorkout(w)) veryHardDates.add(w.localDate);
    }
    const mc = workoutModalityClass(w.type);
    if (mc === 'endurance') completedEndurance++;
    else if (mc === 'strength') completedStrength++;
  }

  const yesterday = addDays(today, -1);
  const yesterdayHard = hardDates.has(yesterday);
  const trainedToday = completedDates.has(today);

  // Prefer Salvor EWMA ratio when available (Williams et al. 2017: more sensitive than rolling avg)
  let acwr = null;
  let acwrSource = null;
  if (scores && scores.length > 0) {
    const byDate = scores
      .filter((s) => (s.localDate || s.date) <= today)
      .sort((a, b) => (b.localDate || b.date).localeCompare(a.localDate || a.date));
    const latest = byDate.find((s) => s.training_load?.ratio != null);
    if (latest?.training_load?.ratio != null) {
      acwr = latest.training_load.ratio;
      acwrSource = latest.training_load.method === 'ewma' ? 'salvor_ewma' : 'salvor';
    }
  }
  if (acwr == null) acwr = computeACWR(workouts, today);

  // Today's readiness from Salvor scores (morning HRV, RHR, sleep, load composite)
  let readiness = null;
  if (scores && scores.length > 0) {
    const todayScore = scores.find((s) => (s.localDate || s.date) === today);
    if (todayScore?.readiness?.score != null) {
      readiness = {
        score: todayScore.readiness.score,
        label: todayScore.readiness.label || null,
        recovery: todayScore.recovery?.score ?? null,
        sleep: todayScore.sleep?.score ?? null,
        dataQuality: todayScore.data_quality || null,
      };
    }
  }

  return {
    acwrSource: acwrSource || 'computed',
    totalMinutes,
    hardCount,
    hardDates,
    veryHardDates,
    completedDates,
    completedEndurance,
    completedStrength,
    yesterdayHard,
    trainedToday,
    acwr,
    readiness,
  };
}

function estimateTargets(intake, profile, mode, recent) {
  const baseStrength = intake.baseline?.strengthFrequencyPerWeek
    ?? (profile?.workouts?.strengthCount != null ? Math.max(1, Math.ceil((profile.workouts.strengthCount || 0) / 4)) : 2);
  const baseEndurance = intake.baseline?.runningFrequencyPerWeek
    ?? (profile?.workouts?.runningCount != null ? Math.max(1, Math.ceil((profile.workouts.runningCount || 0) / 4)) : 3);

  // Deload when ACWR > 1.3 (Gabbett 2016 conservative threshold) OR blunt
  // volume/frequency signal as fallback when ACWR data is unavailable (<28d history).
  // Thresholds: >600 min/week is high even for recreational athletes; >=4 hard
  // sessions AND >480 min avoids false positives from high-frequency easy work.
  const acwrHighLoad = recent.acwr != null ? recent.acwr > 1.3 : false;
  const volumeHighLoad = recent.acwr == null && (recent.totalMinutes > 600 || (recent.hardCount >= 4 && recent.totalMinutes > 480));
  const highLoad = acwrHighLoad || volumeHighLoad;
  // True deload: ~45% volume reduction (SRC013 Deload Delphi consensus)
  const deloadFactor = highLoad ? 0.55 : 1;

  const strengthPerWeek = mode === 'strength_only' ? Math.max(1, Math.round(baseStrength * deloadFactor))
    : mode === 'hybrid' ? Math.max(1, Math.round(baseStrength * deloadFactor))
      : 0;

  const endurancePerWeek = mode === 'endurance_only' ? Math.max(2, Math.round(baseEndurance * deloadFactor))
    : mode === 'hybrid' ? Math.max(2, Math.round(baseEndurance * deloadFactor))
      : 0;

  return {
    strengthPerWeek,
    endurancePerWeek,
    deload: highLoad,
    acwr: recent.acwr,
  };
}

function createSession({ id, programId, milestoneId = null, weekIndex = 0, localDate, title, kind, hardness, requiresRecovery, targets, ruleRefs }) {
  return {
    id,
    programId,
    milestoneId,
    weekIndex,
    localDate,
    title,
    kind,
    modality: modalityFromKind(kind),
    hardness,
    requiresRecovery,
    targets,
    status: 'planned',
    actualWorkoutId: null,
    calendar: { khalUid: null },
    ruleRefs,
  };
}

/**
 * Can we place a hard session on dateStr?
 * Rules:
 *  - No hard session on adjacent planned days (prev/next)
 *  - No hard session the day after a completed hard session
 *  - No hard session within 2 days after a completed VERY hard session
 */
function canPlaceHardOnDate(dateStr, usedHardDates, recentHardDates, recentVeryHardDates = new Set()) {
  const prev = addDays(dateStr, -1);
  const prev2 = addDays(dateStr, -2);
  const next = addDays(dateStr, 1);
  if (usedHardDates.has(prev) || usedHardDates.has(next)) return false;
  if (recentHardDates.has(prev)) return false;
  if (recentVeryHardDates.has(prev2)) return false;
  return true;
}

function pickSlots(slots, count, predicate) {
  const chosen = [];
  for (const slot of slots) {
    if (chosen.length >= count) break;
    if (predicate(slot, chosen)) chosen.push(slot);
  }
  return chosen;
}

function buildStrengthSessions({ intake, targets, slots, maxMinutes, avoidHardDates = new Set(), recentHardDates = new Set(), recentVeryHardDates = new Set() }) {
  const split = intake.baseline?.strengthSplitPreference || 'full_body';
  const splitTitles = {
    full_body: ['Full Body A', 'Full Body B'],
    upper_lower: ['Upper', 'Lower'],
    push_pull_legs: ['Push', 'Pull', 'Legs'],
    bro_split: ['Chest/Triceps', 'Back/Biceps', 'Legs', 'Shoulders'],
  };
  const titles = splitTitles[split] || splitTitles.full_body;

  const chosen = pickSlots(slots, targets.strengthPerWeek, (slot, existing) => {
    const prev = addDays(slot.dateStr, -1);
    const next = addDays(slot.dateStr, 1);
    const localHard = new Set(existing.map((e) => e.dateStr));
    for (const d of avoidHardDates) localHard.add(d);
    if (!canPlaceHardOnDate(slot.dateStr, localHard, recentHardDates, recentVeryHardDates)) return false;
    return !existing.some((e) => e.dateStr === prev || e.dateStr === next);
  });

  // Strength session duration scales with baseline, capped at maxMinutes.
  // During deload: reduce volume (fewer sets, higher rep range at lower load)
  // rather than skipping strength entirely — maintains neuromuscular stimulus.
  const strengthAnchor = intake.baseline?.longestStrengthSessionMinutes ?? 60;
  const strengthBase   = Math.max(20, Math.min(strengthAnchor, 90));
  const strengthTargets = targets.deload
    ? { durationMinutes: Math.min(Math.round(strengthBase * 0.67), maxMinutes), setsReps: '2x12-15', intensity: 'light' }
    : { durationMinutes: Math.min(strengthBase, maxMinutes), setsReps: '3x8-12', intensity: 'moderate' };

  return chosen.map((slot, i) => createSession({
    id: `sess_strength_1_${slot.dateStr}_str_${i}`,
    programId: 'strength_1',
    localDate: slot.dateStr,
    title: titles[i % titles.length],
    kind: 'Strength',
    hardness: 'hard',
    requiresRecovery: true,
    targets: strengthTargets,
    ruleRefs: ['RULE_STRENGTH_PROGRESSION', 'RULE_NO_BACK_TO_BACK_HARD'],
  }));
}

function buildEnduranceSpecs(enduranceMilestone, weekSeed, deload, baseline, maxMinutes, endurancePerWeek) {
  const specs = [];
  const isOddWeek = weekSeed % 2 === 1;

  // LR duration anchored to baseline, capped at maxMinutes.
  // Deload applies the same 0.55 factor as other hard sessions.
  const lrAnchorFull = Math.max(30, Math.min(baseline?.longestRecentRunMinutes ?? 70, 150));
  const lrDuration = Math.min(maxMinutes, Math.round(lrAnchorFull * (deload ? 0.55 : 1.0)));
  specs.push({ kind: 'LR', title: 'Long Run', hardness: 'hard', requiresRecovery: true, targets: { durationMinutes: lrDuration, intensity: 'easy' }, ruleRefs: ['RULE_KEY_WORKOUT_PRIORITY'] });

  // Z2 duration per session scales with weekly volume and training frequency.
  // More Z2 sessions per week → shorter each (total volume stays proportional).
  // All Z2 sessions get the same duration — no arbitrary primary/secondary split.
  // Explicit baseline.z2DurationMinutes overrides the formula.
  // Z2 uses a lighter deload factor (0.75) than hard sessions (0.55) — preserving
  // aerobic stimulus during deload (Bosquet & Mujika 2012).
  const Z2_DELOAD_FACTOR = 0.75;
  // z2Count = planned endurance sessions minus LR and quality session
  const z2Count = Math.max(1, (endurancePerWeek || 2) - 2);
  const z2Duration = Math.min(maxMinutes, Math.round(
    ((baseline?.z2DurationMinutes > 0)
      ? baseline.z2DurationMinutes
      : Math.max(20, Math.min(Math.round(lrAnchorFull * 1.3 / z2Count), 80)))
    * (deload ? Z2_DELOAD_FACTOR : 1.0)
  ));

  specs.push({ kind: 'Z2', title: 'Zone 2', hardness: 'easy', requiresRecovery: false, targets: { durationMinutes: z2Duration, intensity: 'Z2' }, ruleRefs: ['RULE_MARATHON_PHASE_BASE'] });
  if (isOddWeek) {
    specs.push({ kind: 'Intervals', title: 'Intervals (5K pace)', hardness: 'hard', requiresRecovery: true, targets: { durationMinutes: 35, workBouts: '6x1min', recovery: '1min jog', intensity: 'VO2max' }, ruleRefs: ['RULE_HIIT_FREQUENCY'] });
  } else {
    specs.push({ kind: 'Tempo', title: 'Tempo', hardness: 'hard', requiresRecovery: true, targets: { durationMinutes: 30, intensity: 'threshold' }, ruleRefs: ['RULE_MARATHON_PHASE_BUILD'] });
  }
  specs.push({ kind: 'Z2', title: 'Zone 2', hardness: 'easy', requiresRecovery: false, targets: { durationMinutes: z2Duration, intensity: 'Z2' }, ruleRefs: ['RULE_MARATHON_PHASE_BASE'] });

  if (enduranceMilestone?.subKind && /triathlon|cycling/.test(enduranceMilestone.subKind)) {
    specs[0].title = 'Long Endurance';
  }

  return specs;
}

function buildEnduranceSessions({ enduranceMilestone, targets, slots, recentSignals, maxMinutes, baseline }) {
  const sessions = [];
  const usedDates = new Set();
  const usedHardDates = new Set();
  const weekSeed = Math.floor(new Date(slots[0]?.dateStr || new Date().toISOString().slice(0, 10)).getTime() / (7 * 24 * 60 * 60 * 1000));

  const specs = buildEnduranceSpecs(enduranceMilestone, weekSeed, targets.deload, baseline, maxMinutes, targets.endurancePerWeek);
  const desired = Math.min(targets.endurancePerWeek, slots.length);
  let created = 0;

  for (const spec of specs) {
    if (created >= desired) break;

    let candidate = null;
    for (const slot of slots) {
      if (usedDates.has(slot.dateStr)) continue;
      if (spec.hardness === 'hard' && !canPlaceHardOnDate(slot.dateStr, usedHardDates, recentSignals.hardDates, recentSignals.veryHardDates)) continue;
      candidate = slot;
      break;
    }

    if (!candidate) {
      for (const slot of slots) {
        if (!usedDates.has(slot.dateStr)) {
          candidate = slot;
          break;
        }
      }
    }

    if (!candidate) break;

    const idx = sessions.length;
    sessions.push(createSession({
      id: `sess_${enduranceMilestone?.id || 'endurance_1'}_${candidate.dateStr}_${spec.kind.toLowerCase()}_${idx}`,
      programId: enduranceMilestone?.id || 'endurance_1',
      milestoneId: enduranceMilestone?.id || null,
      localDate: candidate.dateStr,
      title: spec.title,
      kind: spec.kind,
      hardness: spec.hardness,
      requiresRecovery: spec.requiresRecovery,
      targets: { ...spec.targets, durationMinutes: Math.min(maxMinutes, spec.targets.durationMinutes) },
      ruleRefs: spec.ruleRefs,
    }));

    usedDates.add(candidate.dateStr);
    if (spec.hardness === 'hard') usedHardDates.add(candidate.dateStr);
    created++;
  }

  return sessions;
}

/**
 * @param {object[]} sessions - planned sessions to validate
 * @param {number} recentHardCount - hard sessions already completed in the rolling window
 * @param {number} maxHardPerWeek - max hard sessions allowed in any rolling 7-day window
 */
function applyGuardrails(sessions, recentHardCount = 0, maxHardPerWeek = 3) {
  const byDate = {};
  for (const s of sessions) {
    if (!byDate[s.localDate]) byDate[s.localDate] = [];
    byDate[s.localDate].push(s);
  }

  const toRemove = new Set();
  const dates = Object.keys(byDate).sort();

  // No back-to-back hard days in the planned window
  for (let i = 1; i < dates.length; i++) {
    const prev = byDate[dates[i - 1]];
    const curr = byDate[dates[i]];
    const prevHard = prev.some((s) => isHardKind(s.kind));
    const currHard = curr.some((s) => isHardKind(s.kind));
    const dayDiff = diffDays(dates[i], dates[i - 1]);
    if (prevHard && currHard && dayDiff === 1) {
      for (const s of curr.filter((x) => isHardKind(x.kind))) toRemove.add(s.id);
    }
  }

  // Cap total hard sessions: completed (unplanned or otherwise) + planned <= maxHardPerWeek
  const plannedHard = sessions.filter((s) => isHardKind(s.kind) && !toRemove.has(s.id));
  const remainingHardBudget = Math.max(0, maxHardPerWeek - recentHardCount);
  if (plannedHard.length > remainingHardBudget) {
    for (const s of plannedHard.slice(remainingHardBudget)) toRemove.add(s.id);
  }

  return sessions.filter((s) => !toRemove.has(s.id));
}

/**
 * Downgrade session intensity based on today's readiness score.
 * Only affects the first planned slot (nearest future date).
 * readiness < 50  → downgrade Intervals/Tempo/LR to Z2 on first slot
 * readiness 50–65 → downgrade only Intervals/Tempo to Z2 on first slot
 * readiness > 65  → no change
 * When data quality is insufficient, skip gating entirely.
 */
function applyReadinessGating(sessions, readiness) {
  if (!readiness || readiness.dataQuality === 'insufficient') return sessions;
  const score = readiness.score;
  if (score > 65) return sessions;

  const sorted = [...sessions].sort((a, b) => a.localDate.localeCompare(b.localDate));
  if (sorted.length === 0) return sessions;
  const firstDate = sorted[0].localDate;

  return sessions.map((s) => {
    if (s.localDate !== firstDate) return s;
    const shouldDowngrade = score < 50
      ? ['LR', 'Tempo', 'Intervals'].includes(s.kind)
      : ['Tempo', 'Intervals'].includes(s.kind); // 50–65: leave Strength, LR alone
    if (!shouldDowngrade) return s;
    return {
      ...s,
      kind: 'Z2',
      title: `Zone 2 (readiness ${score})`,
      modality: 'endurance',
      targets: { ...s.targets, intensity: 'Z2', note: `Downgraded from ${s.kind} — readiness score ${score} (${readiness.label || 'low'})` },
      readinessGated: true,
    };
  });
}

function enforceNoMixedModalityPerDay(sessions) {
  const byDate = {};
  for (const s of sessions) {
    if (!byDate[s.localDate]) byDate[s.localDate] = [];
    byDate[s.localDate].push(s);
  }

  const toRemove = new Set();
  for (const daySessions of Object.values(byDate)) {
    const modalities = new Set(daySessions.map((s) => s.modality));
    if (modalities.size <= 1) continue;

    const score = (s) => {
      if (s.kind === 'LR') return 100;
      if (s.kind === 'Tempo') return 90;
      if (s.kind === 'Intervals') return 80;
      if (s.kind === 'Strength') return 70;
      if (s.kind === 'Z2') return 60;
      return 50;
    };

    let keep = daySessions[0];
    for (const s of daySessions.slice(1)) {
      if (score(s) > score(keep)) keep = s;
    }
    for (const s of daySessions) {
      if (s.id !== keep.id) toRemove.add(s.id);
    }
  }

  return sessions.filter((s) => !toRemove.has(s.id));
}

function buildRecommendations(goals, targets, readiness = null) {
  const recs = [];
  if ((goals || []).some((g) => g.kind === 'sleep')) {
    recs.push({ kind: 'sleep', title: 'Sleep protocol', text: 'Aim for 7-9h sleep. Keep bedtime and wake time consistent.' });
  }
  if ((goals || []).some((g) => g.kind === 'bodycomp')) {
    recs.push({ kind: 'bodycomp', title: 'Nutrition', text: 'Prioritize protein and place carbs around training sessions.' });
  }
  recs.push({ kind: 'planning', title: 'Rolling plan', text: 'Only next 7 days are fixed. Replan weekly from recent execution and recovery.' });
  if (readiness != null && readiness.score <= 65 && readiness.dataQuality !== 'insufficient') {
    const label = readiness.label || 'low';
    const score = readiness.score;
    const msg = score < 50
      ? `Readiness today is ${score} (${label}). First planned session downgraded to Z2. Consider extra rest.`
      : `Readiness today is ${score} (${label}). Intervals/Tempo downgraded to Z2 on first planned day.`;
    recs.push({ kind: 'readiness', title: 'Readiness gate', text: msg });
  }
  if (targets.deload) {
    const acwrNote = targets.acwr != null ? ` (ACWR ${targets.acwr})` : '';
    recs.push({ kind: 'recovery', title: 'Deload signal', text: `Acute:Chronic load ratio is elevated${acwrNote}. Volume reduced ~45% this week. Intensity stays — only tonnage drops.` });
  }
  return recs;
}

function orchestrate(intake, profile, workouts, today, constraints, scores = null) {
  const { hasEndurance, hasStrength, hasGeneral, enduranceMilestone } = resolveGoals(intake);
  const mode = hasEndurance && hasStrength ? 'hybrid'
    : hasEndurance ? 'endurance_only'
      : (hasStrength || hasGeneral) ? 'strength_only'
        : 'strength_only';

  const maxMinutes = constraints.maxMinutesPerDay || 90;
  const maxHardPerWeek = deriveMaxHard(intake);
  const recentSignals = collectRecentSignals(workouts, today, scores);
  const slots = buildRollingSlots(today, constraints).filter((s) => !recentSignals.completedDates.has(s.dateStr));
  const targets = estimateTargets(intake, profile, mode, recentSignals);

  // Subtract already-completed sessions from this week's remaining targets.
  // This prevents the generator from stacking more endurance on top of sessions already done.
  const remainingEndurance = Math.max(0, targets.endurancePerWeek - recentSignals.completedEndurance);
  const remainingStrength = Math.max(0, targets.strengthPerWeek - recentSignals.completedStrength);
  const adjustedTargets = { ...targets, endurancePerWeek: remainingEndurance, strengthPerWeek: remainingStrength };

  const hardDatesForPlanning = new Set(recentSignals.hardDates);
  if (recentSignals.trainedToday) hardDatesForPlanning.add(today);
  const planningSignals = { ...recentSignals, hardDates: hardDatesForPlanning };

  let sessions = [];

  const baseline = intake.baseline || {};

  if (mode === 'strength_only') {
    sessions = buildStrengthSessions({ intake, targets: adjustedTargets, slots, maxMinutes, recentHardDates: planningSignals.hardDates });
  } else if (mode === 'endurance_only') {
    sessions = buildEnduranceSessions({ enduranceMilestone, targets: adjustedTargets, slots, recentSignals: planningSignals, maxMinutes, baseline });
  } else {
    const enduranceSlots = slots.filter((s, i) => i % 2 === 0);
    const strengthSlots = slots.filter((s, i) => i % 2 === 1);

    const enduranceSessions = remainingEndurance > 0 ? buildEnduranceSessions({
      enduranceMilestone,
      targets: { ...adjustedTargets, endurancePerWeek: Math.min(remainingEndurance, enduranceSlots.length || slots.length) },
      slots: enduranceSlots.length ? enduranceSlots : slots,
      recentSignals: planningSignals,
      maxMinutes,
      baseline,
    }) : [];
    const strengthSessions = remainingStrength > 0 ? buildStrengthSessions({
      intake,
      targets: { ...adjustedTargets, strengthPerWeek: Math.min(remainingStrength, strengthSlots.length || slots.length) },
      slots: strengthSlots.length ? strengthSlots : slots,
      maxMinutes,
      avoidHardDates: new Set(enduranceSessions.filter((s) => isHardKind(s.kind)).map((s) => s.localDate)),
      recentHardDates: planningSignals.hardDates,
      recentVeryHardDates: planningSignals.veryHardDates,
    }) : [];
    sessions = [...enduranceSessions, ...strengthSessions];
    sessions = enforceNoMixedModalityPerDay(sessions);
  }

  sessions = applyGuardrails(sessions, recentSignals.hardCount, maxHardPerWeek);
  sessions = applyReadinessGating(sessions, recentSignals.readiness);
  sessions = sessions.sort((a, b) => a.localDate.localeCompare(b.localDate));

  const blueprint = {
    mode,
    windowDays: 7,
    weekOf: today,
    targets: {
      strengthPerWeek: targets.strengthPerWeek,
      endurancePerWeek: targets.endurancePerWeek,
      strengthRemaining: adjustedTargets.strengthPerWeek,
      enduranceRemaining: adjustedTargets.endurancePerWeek,
      maxHardPerWeek,
      hardRemaining: Math.max(0, maxHardPerWeek - recentSignals.hardCount),
      deload: targets.deload,
      acwr: targets.acwr,
    },
    recent7d: {
      totalMinutes: recentSignals.totalMinutes,
      hardSessions: recentSignals.hardCount,
      veryHardSessions: recentSignals.veryHardDates.size,
      completedEndurance: recentSignals.completedEndurance,
      completedStrength: recentSignals.completedStrength,
      yesterdayHard: recentSignals.yesterdayHard,
      acwr: recentSignals.acwr,
      acwrSource: recentSignals.acwrSource,
    },
    readiness: recentSignals.readiness ?? null,
  };

  return {
    sessions,
    recommendations: buildRecommendations(intake.goals || [], targets, recentSignals.readiness),
    blueprint,
  };
}

function main() {
  ensureDir(COACH_ROOT);

  const intake = loadJson(INTAKE_FILE);
  const profile = loadJson(PROFILE_FILE);
  const workoutsRaw = loadJsonlFiles('workouts_');
  const scoresRaw = loadJsonlFiles('scores_');

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
  const { sessions, recommendations, blueprint } = orchestrate(intake, profile, workoutsRaw, today, constraints, scoresRaw);

  const historyWorkouts = workoutsRaw.map((w) => ({
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
    schemaVersion: '1.3',
    timeZone: TZ,
    generatedAt: new Date().toISOString(),
    sources: { salvor: { baseUrl: 'https://api.salvor.eu', lastSyncAt: loadJson(path.join(COACH_ROOT, 'salvor_sync_state.json'))?.lastSuccessfulSyncAt || null } },
    goals: intake.goals || [],
    milestones: intake.milestones || [],
    history: { workouts: historyWorkouts },
    plan: { sessions, recommendations, blueprint },
    adaptation: { events: [] },
  };

  fs.writeFileSync(CALENDAR_FILE, JSON.stringify(calendar, null, 2), 'utf8');

  const nextWeekSessions = sessions.filter((s) => {
    const d = new Date(s.localDate + 'T12:00:00');
    const t = new Date(today + 'T12:00:00');
    const diff = (d - t) / (24 * 60 * 60 * 1000);
    return diff >= 0 && diff < 7;
  });

  const { getStatus } = require('../lib/status-helper');
  const currentStatus = getStatus();
  ensureDir(path.join(WORKSPACE, 'current'));
  fs.writeFileSync(
    path.join(WORKSPACE, 'current', 'training_plan_week.json'),
    JSON.stringify({
      updatedAt: new Date().toISOString(),
      weekStart: today,
      sessions: nextWeekSessions,
      status: currentStatus ? { status: currentStatus.status, until: currentStatus.until, note: currentStatus.note } : null,
      blueprint,
    }, null, 2),
    'utf8'
  );

  console.log('Plan generated. Sessions:', sessions.length, 'Mode:', blueprint.mode, 'Deload:', blueprint.targets.deload);
}

main();
