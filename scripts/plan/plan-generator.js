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

/**
 * Count workouts/sessions of given modality in the rolling 7-day window [slotDate-6 .. slotDate].
 * Used for per-slot frequency check — avoids blocking this week's plan with last week's workouts.
 * @see SRC029 Hickson, SRC030 Wilson — interference effect; per-slot window correct for planning.
 */
function countModalityInWindow(slotDate, completedWorkouts, plannedSessions, modality) {
  const windowStart = addDays(slotDate, -6);
  const fromCompleted = completedWorkouts.filter((w) => {
    const d = w.localDate || w.date;
    if (!d || d < windowStart || d > slotDate) return false;
    return workoutModalityClass(w.type || w.workout_type || w.workoutType) === modality;
  }).length;
  const fromPlanned = plannedSessions.filter((s) =>
    s.localDate >= windowStart && s.localDate <= slotDate && s.modality === modality
  ).length;
  return fromCompleted + fromPlanned;
}

/**
 * Count hard sessions/workouts in rolling 7-day window [slotDate-6 .. slotDate].
 * Includes completed workouts and already planned sessions.
 */
function countHardInWindow(slotDate, completedWorkouts, plannedSessions) {
  const windowStart = addDays(slotDate, -6);
  const fromCompleted = completedWorkouts.filter((w) => {
    const d = w.localDate || w.date;
    if (!d || d < windowStart || d > slotDate) return false;
    return isHardWorkout(w);
  }).length;
  const fromPlanned = plannedSessions.filter((s) =>
    s.localDate >= windowStart && s.localDate <= slotDate && isHardKind(s.kind)
  ).length;
  return fromCompleted + fromPlanned;
}

/**
 * For LR spec: prefer weekend slots (sa, su) first. Other specs: chronological order.
 * @see SRC032 Issurin — block/concentration; LR on weekends maximizes recovery window.
 */
function sortSlotsForSpec(slots, spec) {
  const WEEKEND = new Set(['sa', 'su']);
  if (spec.kind === 'LR') {
    return [...slots].sort((a, b) => {
      const aW = WEEKEND.has(a.key) ? 0 : 1;
      const bW = WEEKEND.has(b.key) ? 0 : 1;
      return aW - bW || a.dateStr.localeCompare(b.dateStr);
    });
  }
  // Tempo/Intervals: prefer end of week so middle days stay free for strength (non-adjacent to hard)
  if ((spec.kind === 'Tempo' || spec.kind === 'Intervals') && spec.hardness === 'hard') {
    return [...slots].sort((a, b) => b.dateStr.localeCompare(a.dateStr));
  }
  return slots;
}

/**
 * When placing endurance in hybrid mode, prefer the slot that leaves non-adjacent gaps
 * for strength (so we can place 2+ hard strength sessions without back-to-back).
 * Returns min gap in days between consecutive free slots — higher is better.
 */
function minGapBetweenFreeSlots(slots, usedDates, chosenDate) {
  const free = slots.filter((s) => !usedDates.has(s.dateStr) && s.dateStr !== chosenDate).map((s) => s.dateStr).sort();
  if (free.length < 2) return 0;
  let minGap = 999;
  for (let i = 0; i < free.length - 1; i++) {
    const gap = diffDays(free[i + 1], free[i]);
    if (gap < minGap) minGap = gap;
  }
  return minGap;
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

/**
 * Expand fixedAppointments to { localDate, title, kind, hardness } for the planning window.
 * Used in training_plan_week.json for full-week visibility (Volleyball, etc.).
 */
function getFixedEventsInWindow(constraints, today, endDate) {
  const fixedList = constraints?.fixedAppointments || [];
  const start = new Date(today + 'T12:00:00');
  const end = new Date((endDate || addDays(today, 6)) + 'T12:00:00');
  const events = [];

  for (const fa of fixedList) {
    const dayKey = toDay2(fa.dayOfWeek || '');
    if (!dayKey) continue;
    const seasonStart = (fa.seasonStart || fa.startDate) ? new Date((fa.seasonStart || fa.startDate) + 'T12:00:00') : null;
    const seasonEnd = (fa.seasonEnd || fa.endDate) ? new Date((fa.seasonEnd || fa.endDate) + 'T12:00:00') : null;
    let cur = new Date(start.getTime());
    while (cur <= end) {
      const dateStr = cur.toLocaleDateString('en-CA', { timeZone: TZ });
      if (getDayKey(dateStr) === dayKey && (!seasonStart || !seasonEnd || (cur >= seasonStart && cur <= seasonEnd))) {
        const name = (fa.name || fa.id || 'Fixed').toLowerCase();
        const hardness = /volleyball|soccer|basketball|handball|hockey|rugby|tennis|squash|boxing|martial/.test(name) ? 'hard' : 'medium';
        events.push({
          localDate: dateStr,
          title: fa.name || fa.id || 'Fixed',
          kind: 'FixedAppointment',
          hardness,
          source: 'intake.fixedAppointments',
        });
      }
      cur.setDate(cur.getDate() + 1);
    }
  }
  return events.sort((a, b) => a.localDate.localeCompare(b.localDate));
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
 * Derive max hard sessions per rolling 7-day window — dynamically modulated.
 *
 * Anchor: perceivedFitness → {low:2, moderate:3, high:4, advanced:5}
 * Modifiers (all additive, result clamped to [1, 6]):
 *   +1 if ACWR < 0.80  → undertrained, can absorb more load (Gabbett 2016)
 *   −1 if ACWR > 1.25  → approaching danger zone
 *   −1 if ≥2 very-hard sessions in last 7d → residual fatigue too high
 *
 * Readiness (today's HRV/sleep score) is intentionally NOT used here:
 * it is a single-day acute signal with no predictive value beyond 24–48h.
 * Readiness modulates only the first planned session via applyReadinessGating().
 *
 * Explicit intake.baseline.maxHardSessionsPerWeek overrides everything (manual override).
 */
function deriveMaxHard(intake, recentSignals = null) {
  if (intake.baseline?.maxHardSessionsPerWeek != null) {
    return intake.baseline.maxHardSessionsPerWeek;
  }
  const base = { low: 2, moderate: 3, high: 4, advanced: 5 }[intake.baseline?.perceivedFitness || 'moderate'] ?? 3;
  if (!recentSignals) return base;

  let cap = base;
  const acwr = recentSignals.acwr;
  if (acwr != null) {
    if (acwr < 0.8)   cap += 1;
    if (acwr > 1.25)  cap -= 1;
  }
  if ((recentSignals.veryHardDates?.size ?? 0) >= 2) cap -= 1;

  return Math.max(1, Math.min(6, cap));
}

/**
 * Compute the current marathon training phase from the race date.
 * Phases scale automatically to available prep time (8 or 32 weeks).
 *
 * - Taper: always last 3 weeks (volume down, intensity maintained)
 * - Peak:  1 week before taper (highest LR)
 * - Build: ~35% of remaining weeks (quality + marathon pace)
 * - Base:  everything earlier (aerobic foundation)
 *
 * When trainingStartDate is provided, weeksIntoBase/weeksIntoBuild are derived
 * from actual elapsed weeks since start (not from weeksToRace). This anchors
 * the preparation and ensures correct progression even when the plan is
 * regenerated multiple times per week.
 */
function getMarathonPhase(raceDateStr, today, trainingStartDate = null) {
  if (!raceDateStr) return null;
  const daysToRace = diffDays(raceDateStr, today);
  if (daysToRace < 0) return { phase: 'post', weeksToRace: 0 };

  const weeksToRace = Math.ceil(daysToRace / 7);
  const TAPER_WEEKS = 3;
  const PEAK_WEEKS  = 1;

  if (weeksToRace <= TAPER_WEEKS) {
    return { phase: 'taper', weeksToRace, taperWeek: TAPER_WEEKS - weeksToRace + 1 };
  }
  if (weeksToRace <= TAPER_WEEKS + PEAK_WEEKS) {
    return { phase: 'peak', weeksToRace };
  }

  const remaining  = weeksToRace - TAPER_WEEKS - PEAK_WEEKS;
  const buildWeeks = Math.max(2, Math.round(remaining * 0.35));
  const baseWeeks  = remaining - buildWeeks;

  // Elapsed weeks since training start (when provided); anchors weeksIntoBase/Build
  const weeksSinceStart = trainingStartDate
    ? Math.max(1, Math.floor(diffDays(today, trainingStartDate) / 7) + 1)
    : null;

  if (weeksToRace <= TAPER_WEEKS + PEAK_WEEKS + buildWeeks) {
    const weeksIntoBuild = weeksSinceStart != null && weeksSinceStart > baseWeeks
      ? Math.min(weeksSinceStart - baseWeeks, buildWeeks)
      : (TAPER_WEEKS + PEAK_WEEKS + buildWeeks) - weeksToRace + 1;
    return { phase: 'build', weeksToRace, weeksIntoBuild, buildWeeks };
  }

  const weeksIntoBase = weeksSinceStart != null
    ? Math.min(weeksSinceStart, baseWeeks)
    : baseWeeks - (weeksToRace - TAPER_WEEKS - PEAK_WEEKS - buildWeeks) + 1;
  return { phase: 'base', weeksToRace, weeksIntoBase, baseWeeks };
}

/**
 * Compute LR duration for the current marathon phase.
 * Progresses linearly Base → Build → Peak, then drops during Taper.
 * Falls back to baseline anchor when no phase info is available.
 */
function computeLRDuration(baseline, maxMinutes, marathonPhase, deload) {
  const startMin = Math.max(30, baseline?.longestRecentRunMinutes ?? 50);
  // Peak LR target: 2.2× starting baseline, min 90 min, capped at maxMinutes
  // (For a 4h marathon goal on 90 min/day constraint, user should raise maxMinutesPerDay for LR days)
  const peakLR = Math.min(maxMinutes, Math.max(90, Math.round(startMin * 2.2)));

  if (!marathonPhase || marathonPhase.phase === 'post') {
    return Math.max(20, Math.min(maxMinutes, Math.round(startMin * (deload ? 0.55 : 1.0))));
  }

  let duration;
  switch (marathonPhase.phase) {
    case 'base': {
      const targetEndBase = Math.round(peakLR * 0.75);
      const p = marathonPhase.baseWeeks > 1
        ? (marathonPhase.weeksIntoBase - 1) / (marathonPhase.baseWeeks - 1) : 1;
      duration = Math.round(startMin + (targetEndBase - startMin) * p);
      break;
    }
    case 'build': {
      const startBuild = Math.round(peakLR * 0.75);
      const p = marathonPhase.buildWeeks > 1
        ? (marathonPhase.weeksIntoBuild - 1) / (marathonPhase.buildWeeks - 1) : 1;
      duration = Math.round(startBuild + (peakLR - startBuild) * p);
      break;
    }
    case 'peak':
      duration = peakLR;
      break;
    case 'taper': {
      // Volume drops 25%/40%/60% over 3 taper weeks (Mujika & Padilla 2003)
      const taperFactors = [0.75, 0.60, 0.40];
      duration = Math.round(peakLR * taperFactors[Math.min(marathonPhase.taperWeek - 1, 2)]);
      break;
    }
    default:
      duration = startMin;
  }

  // ACWR deload stacks on top (but not during taper — taper already cuts volume)
  if (deload && marathonPhase.phase !== 'taper') duration = Math.round(duration * 0.55);
  return Math.max(20, Math.min(maxMinutes, duration));
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

function estimateTargets(intake, profile, mode, recent, marathonPhase = null) {
  const baseStrength = intake.baseline?.strengthFrequencyPerWeek
    ?? (profile?.workouts?.strengthCount != null ? Math.max(1, Math.ceil((profile.workouts.strengthCount || 0) / 4)) : 2);
  const baseEndurance = intake.baseline?.runningFrequencyPerWeek
    ?? (profile?.workouts?.runningCount != null ? Math.max(1, Math.ceil((profile.workouts.runningCount || 0) / 4)) : 3);

  // Deload triggers (Bompa: proactive scheduling + Gabbett: reactive ACWR):
  // 1. ACWR > 1.3 (Gabbett 2016)
  // 2. Volume fallback when ACWR unavailable: >600 min OR (>=4 hard AND >480 min)
  // 3. Proactive: Base phase every 4th week; Build phase every 3rd week (higher intensity)
  const acwrHighLoad = recent.acwr != null ? recent.acwr > 1.3 : false;
  const volumeHighLoad = recent.acwr == null && (recent.totalMinutes > 600 || (recent.hardCount >= 4 && recent.totalMinutes > 480));
  const proactiveDeload = marathonPhase?.phase === 'base' && (marathonPhase.weeksIntoBase || 0) % 4 === 0
    || marathonPhase?.phase === 'build' && (marathonPhase.weeksIntoBuild || 0) % 3 === 0;
  const highLoad = acwrHighLoad || volumeHighLoad || proactiveDeload;
  const deloadReason = acwrHighLoad ? 'acwr' : volumeHighLoad ? 'volume' : proactiveDeload ? 'scheduled' : null;

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
    deloadReason,
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

function buildStrengthSessions({ intake, targets, slots, maxMinutes, avoidHardDates = new Set(), recentHardDates = new Set(), recentVeryHardDates = new Set(), completedWorkouts = [], strengthTarget, maxHardPerWeek = 3, marathonPhase = null, startIndex = 0 }) {
  const split = intake.baseline?.strengthSplitPreference || 'full_body';
  const splitTitles = {
    full_body: ['Full Body A', 'Full Body B'],
    upper_lower: ['Upper', 'Lower'],
    push_pull_legs: ['Push', 'Pull', 'Legs'],
    bro_split: ['Chest/Triceps', 'Back/Biceps', 'Legs', 'Shoulders'],
  };
  const titles = splitTitles[split] || splitTitles.full_body;
  const modalityTarget = strengthTarget ?? targets.strengthPerWeek;

  const chosen = [];
  for (const slot of slots) {
    if (chosen.length >= modalityTarget) break;
    if (countModalityInWindow(slot.dateStr, completedWorkouts, chosen.map((s) => ({ localDate: s.dateStr, modality: 'strength' })), 'strength') >= modalityTarget) continue;
    if (countHardInWindow(slot.dateStr, completedWorkouts, chosen.map((s) => ({ localDate: s.dateStr, kind: 'Strength' }))) >= maxHardPerWeek) continue;
    const localHard = new Set(chosen.map((s) => s.dateStr));
    for (const d of avoidHardDates) localHard.add(d);
    if (!canPlaceHardOnDate(slot.dateStr, localHard, recentHardDates, recentVeryHardDates)) continue;
    const prev = addDays(slot.dateStr, -1);
    const next = addDays(slot.dateStr, 1);
    if (chosen.some((e) => e.dateStr === prev || e.dateStr === next)) continue;
    chosen.push(slot);
  }

  // Phase-dependent strength periodization (Bompa, Issurin):
  // Base: Hypertrophie | Build: Maximalkraft | Peak: Power/Erhalt | Taper: Erhalt, kein neuer Reiz
  // Deload overrides: light, 2×12–15
  const strengthAnchor = intake.baseline?.longestStrengthSessionMinutes ?? 60;
  const strengthBase = Math.max(20, Math.min(strengthAnchor, 90));
  const phase = marathonPhase?.phase ?? null;

  let strengthTargets;
  if (targets.deload) {
    strengthTargets = { durationMinutes: Math.min(Math.round(strengthBase * 0.67), maxMinutes), setsReps: '2x12-15', intensity: 'light' };
  } else if (phase === 'taper' || phase === 'peak') {
    const cap = Math.round(maxMinutes * 0.7);
    strengthTargets = phase === 'taper'
      ? { durationMinutes: Math.min(Math.round(strengthBase * 0.6), cap), setsReps: '2x8-10', intensity: 'light' }
      : { durationMinutes: Math.min(strengthBase, cap), setsReps: '3x3-5', intensity: 'hard' };
  } else if (phase === 'build') {
    strengthTargets = { durationMinutes: Math.min(strengthBase, maxMinutes), setsReps: '4x5-6', intensity: 'hard' };
  } else {
    // base or no marathon phase
    strengthTargets = { durationMinutes: Math.min(strengthBase, maxMinutes), setsReps: '3x10-12', intensity: 'moderate' };
  }

  return chosen.map((slot, i) => createSession({
    id: `sess_strength_1_${slot.dateStr}_str_${startIndex + i}`,
    programId: 'strength_1',
    localDate: slot.dateStr,
    title: titles[(startIndex + i) % titles.length],
    kind: 'Strength',
    hardness: 'hard',
    requiresRecovery: true,
    targets: strengthTargets,
    ruleRefs: ['RULE_STRENGTH_PROGRESSION', 'RULE_NO_BACK_TO_BACK_HARD'],
  }));
}

/**
 * Build ordered list of endurance session specs for the week.
 * Phase-aware for marathon milestones: Base/Build/Peak/Taper each produce
 * a different session mix and LR duration.
 *
 * Base:  LR (short→medium) + Z2 + Tempo only (no Intervals — aerobic foundation first)
 * Build: LR (medium→long) + Z2 + Intervals/Tempo alternating + Marathon Pace
 * Peak:  LR (longest) + Tempo + Intervals (both quality types in one week)
 * Taper: LR (shortened) + one quality session (shorter) — volume down, sharpness up
 */
function buildEnduranceSpecs(enduranceMilestone, weekSeed, deload, baseline, maxMinutes, endurancePerWeek, marathonPhase = null, recentSignals = null) {
  const specs = [];
  const isOddWeek = weekSeed % 2 === 1;
  const phase = marathonPhase?.phase ?? null;
  const isMarathon = enduranceMilestone?.kind === 'marathon' || enduranceMilestone?.subKind === 'marathon';

  // LR duration: phase-progressive for marathon, baseline-anchored otherwise
  const lrAnchorFull = Math.max(30, Math.min(baseline?.longestRecentRunMinutes ?? 70, 150));
  const lrDuration = isMarathon && marathonPhase
    ? computeLRDuration(baseline, maxMinutes, marathonPhase, deload)
    : Math.min(maxMinutes, Math.round(lrAnchorFull * (deload ? 0.55 : 1.0)));

  specs.push({ kind: 'LR', title: 'Long Run', hardness: 'hard', requiresRecovery: true, targets: { durationMinutes: lrDuration, intensity: 'easy' }, ruleRefs: ['RULE_KEY_WORKOUT_PRIORITY'] });

  // Z2 duration per session — lighter deload factor to preserve aerobic stimulus (Bosquet & Mujika 2012)
  // Cap at LR duration: LR is key workout (SRC032 Issurin); Z2 is support, never longer (SRC016/017)
  const Z2_DELOAD_FACTOR = phase === 'taper' ? 0.6 : 0.75;
  const z2Count = Math.max(1, (endurancePerWeek || 2) - 2);
  let z2Duration = Math.min(maxMinutes, Math.round(
    ((baseline?.z2DurationMinutes > 0)
      ? baseline.z2DurationMinutes
      : Math.max(40, Math.min(Math.round(lrAnchorFull * 1.3 / z2Count), 80)))
    * (deload || phase === 'taper' ? Z2_DELOAD_FACTOR : 1.0)
  ));
  z2Duration = Math.min(z2Duration, lrDuration);
  // Minimum 40 min for meaningful aerobic stimulus (Laursen & Buchheit 2019); respect LR cap if LR < 40 (very early training)
  z2Duration = Math.max(z2Duration, Math.min(40, lrDuration));

  if (phase === 'base' && isMarathon) {
    // Base: aerobic foundation — Z2 + Tempo (if allowed).
    // Composite tempo gate (signal-based, not calendar-only):
    //   Hadd/Maffetone: beginners need aerobic base before intensity.
    //   Advanced runners need less base time — gate on fitness + load signals.
    //   ACWR < 0.8 means undertrained → not ready for quality regardless of weeks.
    //   Refs: Hadd 2008, Maffetone 2010, Seiler 2009 (SRC018, SRC021).
    const perceivedFitness = baseline?.perceivedFitness || 'moderate';
    const weeksIntoBase = marathonPhase?.weeksIntoBase ?? 0;
    const longestRun = baseline?.longestRecentRunMinutes ?? 0;
    const acwr = recentSignals?.acwr ?? 1.0;

    // High/advanced: 1+ weeks base + longestRun >= 45min + ACWR >= 0.8
    // Moderate: 3+ weeks base + longestRun >= 60min + ACWR >= 0.8
    // Low: no Tempo in Base phase at all (pure aerobic foundation)
    const tempoAllowed = acwr >= 0.8 && (() => {
      if (perceivedFitness === 'high' || perceivedFitness === 'advanced') {
        return weeksIntoBase >= 1 && longestRun >= 45;
      }
      if (perceivedFitness === 'moderate') {
        return weeksIntoBase >= 3 && longestRun >= 60;
      }
      return false; // low fitness: no tempo in base
    })();

    const z2Note = z2Duration >= 40 ? 'Optional: 4–6 × 20s Strides am Ende (locker ausschütteln, kein Sprint)' : undefined;
    const z2Targets = { durationMinutes: z2Duration, intensity: 'Z2', ...(z2Note ? { note: z2Note } : {}) };

    specs.push({ kind: 'Z2', title: 'Zone 2', hardness: 'easy', requiresRecovery: false, targets: z2Targets, ruleRefs: ['RULE_MARATHON_PHASE_BASE'] });
    if (tempoAllowed) {
      specs.push({ kind: 'Tempo', title: 'Tempo', hardness: 'hard', requiresRecovery: true, targets: { durationMinutes: 30, intensity: 'threshold' }, ruleRefs: ['RULE_MARATHON_PHASE_BASE'] });
    }
    specs.push({ kind: 'Z2', title: 'Zone 2', hardness: 'easy', requiresRecovery: false, targets: z2Targets, ruleRefs: ['RULE_MARATHON_PHASE_BASE'] });
  } else if (phase === 'build' && isMarathon) {
    // Build: introduce quality + Marathon Pace runs
    specs.push({ kind: 'Z2', title: 'Zone 2', hardness: 'easy', requiresRecovery: false, targets: { durationMinutes: z2Duration, intensity: 'Z2' }, ruleRefs: ['RULE_MARATHON_PHASE_BUILD'] });
    if (isOddWeek) {
      specs.push({ kind: 'Intervals', title: 'Intervals (5K pace)', hardness: 'hard', requiresRecovery: true, targets: { durationMinutes: 35, workBouts: '6x1min', recovery: '1min jog', intensity: 'VO2max' }, ruleRefs: ['RULE_HIIT_FREQUENCY'] });
    } else {
      specs.push({ kind: 'Tempo', title: 'Marathon Pace', hardness: 'hard', requiresRecovery: true, targets: { durationMinutes: 40, intensity: 'marathon_pace', note: 'Comfortable hard — target race pace' }, ruleRefs: ['RULE_MARATHON_PHASE_BUILD'] });
    }
    specs.push({ kind: 'Z2', title: 'Zone 2', hardness: 'easy', requiresRecovery: false, targets: { durationMinutes: z2Duration, intensity: 'Z2' }, ruleRefs: ['RULE_MARATHON_PHASE_BUILD'] });
  } else if (phase === 'peak' && isMarathon) {
    // Peak: both quality types in same week, longest LR
    specs.push({ kind: 'Tempo', title: 'Marathon Pace', hardness: 'hard', requiresRecovery: true, targets: { durationMinutes: 45, intensity: 'marathon_pace', note: 'Race simulation effort' }, ruleRefs: ['RULE_MARATHON_PHASE_PEAK'] });
    specs.push({ kind: 'Z2', title: 'Zone 2', hardness: 'easy', requiresRecovery: false, targets: { durationMinutes: z2Duration, intensity: 'Z2' }, ruleRefs: ['RULE_MARATHON_PHASE_PEAK'] });
    specs.push({ kind: 'Intervals', title: 'Intervals (5K pace)', hardness: 'hard', requiresRecovery: true, targets: { durationMinutes: 35, workBouts: '6x1min', recovery: '1min jog', intensity: 'VO2max' }, ruleRefs: ['RULE_HIIT_FREQUENCY'] });
  } else if (phase === 'taper' && isMarathon) {
    // Taper: volume down sharply, keep one quality session short + sharp
    const taperQuality = marathonPhase.taperWeek <= 2
      ? { kind: 'Tempo', title: 'Tempo (short)', hardness: 'hard', requiresRecovery: true, targets: { durationMinutes: Math.min(25, maxMinutes), intensity: 'threshold', note: 'Short and sharp — maintain neuromuscular sharpness' }, ruleRefs: ['RULE_TAPER_QUALITY'] }
      : { kind: 'Z2', title: 'Zone 2 (race week)', hardness: 'easy', requiresRecovery: false, targets: { durationMinutes: Math.min(30, maxMinutes), intensity: 'Z2', note: 'Easy shakeout — legs fresh for race' }, ruleRefs: ['RULE_TAPER_RACE_WEEK'] };
    specs.push(taperQuality);
    if (marathonPhase.taperWeek <= 2) {
      specs.push({ kind: 'Z2', title: 'Zone 2', hardness: 'easy', requiresRecovery: false, targets: { durationMinutes: z2Duration, intensity: 'Z2' }, ruleRefs: ['RULE_MARATHON_PHASE_BASE'] });
    }
  } else {
    // Default (no marathon phase or non-marathon): original alternating logic
    specs.push({ kind: 'Z2', title: 'Zone 2', hardness: 'easy', requiresRecovery: false, targets: { durationMinutes: z2Duration, intensity: 'Z2' }, ruleRefs: ['RULE_MARATHON_PHASE_BASE'] });
    if (isOddWeek) {
      specs.push({ kind: 'Intervals', title: 'Intervals (5K pace)', hardness: 'hard', requiresRecovery: true, targets: { durationMinutes: 35, workBouts: '6x1min', recovery: '1min jog', intensity: 'VO2max' }, ruleRefs: ['RULE_HIIT_FREQUENCY'] });
    } else {
      specs.push({ kind: 'Tempo', title: 'Tempo', hardness: 'hard', requiresRecovery: true, targets: { durationMinutes: 30, intensity: 'threshold' }, ruleRefs: ['RULE_MARATHON_PHASE_BUILD'] });
    }
    specs.push({ kind: 'Z2', title: 'Zone 2', hardness: 'easy', requiresRecovery: false, targets: { durationMinutes: z2Duration, intensity: 'Z2' }, ruleRefs: ['RULE_MARATHON_PHASE_BASE'] });
  }

  if (enduranceMilestone?.subKind && /triathlon|cycling/.test(enduranceMilestone.subKind)) {
    specs[0].title = 'Long Endurance';
  }

  return specs;
}

function buildEnduranceSessions({ enduranceMilestone, targets, slots, recentSignals, maxMinutes, baseline, marathonPhase = null, completedWorkouts = [], enduranceTarget, maxHardPerWeek = 3, strengthTarget = 0 }) {
  const sessions = [];
  const usedDates = new Set();
  const usedHardDates = new Set();
  const weekSeed = Math.floor(new Date(slots[0]?.dateStr || new Date().toISOString().slice(0, 10)).getTime() / (7 * 24 * 60 * 60 * 1000));
  const modalityTarget = enduranceTarget ?? targets.endurancePerWeek;
  const leaveGapsForStrength = strengthTarget >= 2;

  const specs = buildEnduranceSpecs(enduranceMilestone, weekSeed, targets.deload, baseline, maxMinutes, targets.endurancePerWeek, marathonPhase, recentSignals);

  for (const spec of specs) {
    if (sessions.length >= modalityTarget) break;
    const sortedSlots = sortSlotsForSpec(slots, spec);
    let candidates = [];

    for (const slot of sortedSlots) {
      if (usedDates.has(slot.dateStr)) continue;
      if (countModalityInWindow(slot.dateStr, completedWorkouts, sessions, 'endurance') >= modalityTarget) continue;
      if (spec.hardness === 'hard' && countHardInWindow(slot.dateStr, completedWorkouts, sessions) >= maxHardPerWeek) continue;
      if (spec.hardness === 'hard' && !canPlaceHardOnDate(slot.dateStr, usedHardDates, recentSignals.hardDates, recentSignals.veryHardDates)) continue;
      candidates.push(slot);
      if (!leaveGapsForStrength) break;
    }

    if (candidates.length === 0) {
      for (const slot of sortedSlots) {
        if (!usedDates.has(slot.dateStr) && countModalityInWindow(slot.dateStr, completedWorkouts, sessions, 'endurance') < modalityTarget) {
          candidates.push(slot);
          if (!leaveGapsForStrength) break;
        }
      }
    }

    let candidate = null;
    if (leaveGapsForStrength && candidates.length > 1) {
      candidate = candidates.reduce((best, s) => {
        const gapBest = minGapBetweenFreeSlots(slots, usedDates, best.dateStr);
        const gapS = minGapBetweenFreeSlots(slots, usedDates, s.dateStr);
        return gapS > gapBest ? s : best;
      }, candidates[0]);
    } else {
      candidate = candidates[0];
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
  }

  return sessions;
}

/**
 * @param {object[]} sessions - planned sessions to validate
 */
function applyGuardrails(sessions) {
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

  return sessions.filter((s) => !toRemove.has(s.id));
}

/**
 * Downgrade session intensity based on today's readiness score.
 * Only affects the first planned slot when it is today or tomorrow —
 * readiness has no predictive value for sessions 2+ days out.
 * readiness < 50  → Endurance: LR/Tempo/Intervals → Z2. Strength: → light (2×12–15).
 * readiness 50–65 → Endurance: Tempo/Intervals → Z2. Strength: unchanged.
 * readiness > 65  → no change
 * When data quality is insufficient, skip gating entirely.
 */
function applyReadinessGating(sessions, readiness, today) {
  if (!readiness || readiness.dataQuality === 'insufficient') return { sessions, readinessGated: false };
  const score = readiness.score;
  if (score > 65) return { sessions, readinessGated: false };

  const sorted = [...sessions].sort((a, b) => a.localDate.localeCompare(b.localDate));
  if (sorted.length === 0) return { sessions, readinessGated: false };
  const firstDate = sorted[0].localDate;
  const daysUntilFirst = diffDays(firstDate, today);
  if (daysUntilFirst > 1) return { sessions, readinessGated: false }; // session 2+ days away: today's readiness not predictive

  const gated = sessions.map((s) => {
    if (s.localDate !== firstDate) return s;
    const label = readiness.label || 'low';
    if (s.kind === 'Strength') {
      if (score >= 50) return s;
      return {
        ...s,
        title: `${s.title} (readiness ${score})`,
        targets: {
          ...s.targets,
          setsReps: '2x12-15',
          intensity: 'light',
          durationMinutes: Math.min(s.targets.durationMinutes || 60, Math.round((s.targets.durationMinutes || 60) * 0.67)),
          note: `Downgraded to light — readiness ${score} (${label}). Kein Volumen-Stimulus, nur Erhalt.`,
        },
        readinessGated: true,
      };
    }
    const shouldDowngrade = score < 50
      ? ['LR', 'Tempo', 'Intervals'].includes(s.kind)
      : ['Tempo', 'Intervals'].includes(s.kind);
    if (!shouldDowngrade) return s;
    return {
      ...s,
      kind: 'Z2',
      title: `Zone 2 (readiness ${score})`,
      modality: 'endurance',
      hardness: 'easy',
      requiresRecovery: false,
      targets: { ...s.targets, intensity: 'Z2', note: `Downgraded from ${s.kind} — readiness score ${score} (${label})` },
      readinessGated: true,
    };
  });
  const didGate = gated.some((s) => s.readinessGated === true);
  return { sessions: gated, readinessGated: didGate };
}

/**
 * If LR was downgraded to Z2 by readiness, try to place it on a later slot in the same week.
 * Priority: (1) free weekend slots (Sa/So), (2) Z2 swap on weekend, (3) Z2 swap on weekday.
 * LR belongs on weekends for recovery quality and lifestyle alignment (Maffetone 2010).
 * If no suitable slot exists, sets lrCarryoverFailed for recommendation.
 */
function applyLRCarryover(sessions, recentSignals, maxHardPerWeek, enduranceMilestone = null, completedWorkouts = [], allSlots = []) {
  const downgradedLR = sessions.find((s) =>
    s.readinessGated && s.kind === 'Z2' && (s.targets?.note || '').includes('Downgraded from LR')
  );
  if (!downgradedLR || !enduranceMilestone) return { sessions, lrCarryoverFailed: false };

  const lrDuration = downgradedLR.targets?.durationMinutes ?? 60;
  const downgradedDate = downgradedLR.localDate;
  const usedHardDates = new Set(sessions.filter((s) => isHardKind(s.kind)).map((s) => s.localDate));
  const usedDates = new Set(sessions.map((s) => s.localDate));

  function makeCarryoverLR(dateStr) {
    return createSession({
      id: `sess_${enduranceMilestone?.id || 'endurance_1'}_${dateStr}_lr_carryover`,
      programId: enduranceMilestone?.id || 'endurance_1',
      milestoneId: enduranceMilestone?.id || null,
      localDate: dateStr,
      title: 'Long Run (nachgeholt)',
      kind: 'LR',
      hardness: 'hard',
      requiresRecovery: true,
      targets: { durationMinutes: lrDuration, intensity: 'easy', note: 'LR von erstem Tag verschoben wegen Readiness' },
      ruleRefs: ['RULE_KEY_WORKOUT_PRIORITY', 'RULE_LR_CARRYOVER'],
    });
  }

  function isWeekend(dateStr) {
    const dow = new Date(dateStr + 'T12:00:00').getDay();
    return dow === 0 || dow === 6;
  }

  // Option 1: free weekend slot later in the week (no existing session there)
  const freeWeekendSlots = allSlots.filter((slot) => {
    const d = slot.dateStr;
    if (d <= downgradedDate || !isWeekend(d) || usedDates.has(d)) return false;
    if (!canPlaceHardOnDate(d, usedHardDates, recentSignals.hardDates, recentSignals.veryHardDates)) return false;
    const hardCount = countHardInWindow(d, completedWorkouts, sessions);
    return hardCount < maxHardPerWeek;
  }).sort((a, b) => a.dateStr.localeCompare(b.dateStr));

  if (freeWeekendSlots.length > 0) {
    const dateStr = freeWeekendSlots[0].dateStr;
    return { sessions: [...sessions, makeCarryoverLR(dateStr)], lrCarryoverFailed: false };
  }

  // Option 2+3: replace a Z2 session (weekends first, then weekdays)
  const candidateZ2s = sessions
    .filter((s) => s.kind === 'Z2' && s.localDate > downgradedDate && !s.readinessGated)
    .sort((a, b) => {
      const isWeekendA = isWeekend(a.localDate) ? 0 : 1;
      const isWeekendB = isWeekend(b.localDate) ? 0 : 1;
      if (isWeekendA !== isWeekendB) return isWeekendA - isWeekendB; // weekends first
      return a.localDate.localeCompare(b.localDate);
    });

  for (const z2 of candidateZ2s) {
    const dateStr = z2.localDate;
    if (!canPlaceHardOnDate(dateStr, usedHardDates, recentSignals.hardDates, recentSignals.veryHardDates)) continue;
    const hardCount = countHardInWindow(dateStr, completedWorkouts, sessions);
    if (hardCount >= maxHardPerWeek) continue;

    const replacement = sessions.map((s) => (s.id === z2.id ? makeCarryoverLR(dateStr) : s));
    return { sessions: replacement, lrCarryoverFailed: false };
  }

  return { sessions, lrCarryoverFailed: true };
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

function buildRecommendations(goals, targets, readiness = null, readinessGated = false, marathonPhase = null, polarizedRatioExceeded = false, lrCarryoverFailed = false, strengthShortfall = false) {
  const recs = [];
  if (polarizedRatioExceeded) {
    recs.push({ kind: 'polarized', title: '80/20 Endurance-Ratio', text: 'Anteil harter Endurance-Sessions >25% (Seiler 2009). Optimal: ~80% easy, ~20% hard. Erwäge eine Qualitätseinheit durch Z2 zu ersetzen.' });
  }
  if (lrCarryoverFailed) {
    recs.push({ kind: 'lr_carryover', title: 'Long Run nachholen', text: 'LR wurde wegen Readiness downgedgradet; kein passender Slot in dieser Woche. Long Run in der nächsten Woche priorisieren.' });
  }
  if (strengthShortfall) {
    recs.push({ kind: 'strength_shortfall', title: 'Kraft-Soll unterschritten', text: 'Ziel: 2+ Strength-Sessions. Begrenzt durch Hard-Budget, Restdays oder blockierte Tage. Zwei-a-days oder zusätzliche Tage prüfen.' });
  }
  if ((goals || []).some((g) => g.kind === 'sleep')) {
    recs.push({ kind: 'sleep', title: 'Sleep protocol', text: 'Aim for 7-9h sleep. Keep bedtime and wake time consistent.' });
  }
  if ((goals || []).some((g) => g.kind === 'bodycomp')) {
    recs.push({ kind: 'bodycomp', title: 'Nutrition', text: 'Prioritize protein and place carbs around training sessions.' });
  }
  recs.push({ kind: 'planning', title: 'Rolling plan', text: 'Only next 7 days are fixed. Replan weekly from recent execution and recovery.' });
  if (readinessGated && readiness != null && readiness.score <= 65 && readiness.dataQuality !== 'insufficient') {
    const label = readiness.label || 'low';
    const score = readiness.score;
    const msg = score < 50
      ? `Readiness today is ${score} (${label}). First planned session downgraded (Z2 or light Strength). Consider extra rest.`
      : `Readiness today is ${score} (${label}). Intervals/Tempo downgraded to Z2 on first planned day.`;
    recs.push({ kind: 'readiness', title: 'Readiness gate', text: msg });
  }
  if (targets.deload) {
    const acwrNote = targets.acwr != null ? ` (ACWR ${targets.acwr})` : '';
    recs.push({ kind: 'recovery', title: 'Deload signal', text: `Acute:Chronic load ratio is elevated${acwrNote}. Volume reduced ~45% this week. Intensity stays — only tonnage drops.` });
  }
  if (marathonPhase) {
    const phaseLabels = { base: 'Base', build: 'Build', peak: 'Peak', taper: 'Taper', post: 'Post-race' };
    const phaseLabel = phaseLabels[marathonPhase.phase] || marathonPhase.phase;
    const weeksNote = marathonPhase.weeksToRace ? ` (${marathonPhase.weeksToRace} weeks to race)` : '';
    const phaseTexts = {
      base:  'Focus: aerobic foundation. Easy runs dominate. Tempo keeps the engine sharp but no hard intervals yet.',
      build: 'Focus: race-specific quality. Marathon Pace runs + Intervals alternate. LR getting longer.',
      peak:  'Focus: sharpest week. Longest LR + both quality sessions. Trust the training — back off next week.',
      taper: `Focus: freshness. Volume drops ${['25%', '40%', '60%'][Math.min((marathonPhase.taperWeek || 1) - 1, 2)]}, intensity maintained. Don't add extra sessions.`,
      post:  'Race complete. Easy recovery only — no hard sessions for at least 2 weeks.',
    };
    recs.push({
      kind: 'marathon_phase',
      title: `Marathon phase: ${phaseLabel}${weeksNote}`,
      text: phaseTexts[marathonPhase.phase] || `Current phase: ${phaseLabel}.`,
    });
  }
  return recs;
}

function orchestrate(intake, profile, workouts, today, constraints, scores = null) {
  const { hasEndurance, hasStrength, hasGeneral, enduranceMilestone } = resolveGoals(intake);
  const mode = hasEndurance && hasStrength ? 'hybrid'
    : hasEndurance ? 'endurance_only'
      : (hasStrength || hasGeneral) ? 'strength_only'
        : 'strength_only';

  const baseMax = constraints.maxMinutesPerDay || 120;
  const recentSignals = collectRecentSignals(workouts, today, scores);
  const maxHardPerWeek = deriveMaxHard(intake, recentSignals);
  const slots = buildRollingSlots(today, constraints).filter((s) => !recentSignals.completedDates.has(s.dateStr));

  // Marathon phase — computed before targets (needed for proactive deload, strength periodization)
  const marathonMilestone = intake.milestones?.find((m) => m.kind === 'marathon')
    || intake.goals?.find((g) => g.subKind === 'marathon' && g.dateLocal);
  const trainingStartDate = intake.trainingStartDate ?? marathonMilestone?.trainingStartDate ?? null;
  const marathonPhase = getMarathonPhase(marathonMilestone?.dateLocal ?? null, today, trainingStartDate);

  const targets = estimateTargets(intake, profile, mode, recentSignals, marathonPhase);

  // Marathon prep: bump cap so LR can reach 2h+ at peak — use at least 150 min (user constraint respected if higher)
  const MARATHON_LR_MIN_MINUTES = 150;
  const maxMinutes = (marathonPhase && marathonPhase.phase !== 'taper' && marathonPhase.phase !== 'post')
    ? Math.max(baseMax, MARATHON_LR_MIN_MINUTES)
    : baseMax;

  // During taper: reduce endurance frequency (volume down, intensity maintained).
  let enduranceTarget = targets.endurancePerWeek;
  if (marathonPhase?.phase === 'taper') {
    const taperFreqFactors = [1.0, 0.7, 0.4]; // taper weeks 1/2/3
    enduranceTarget = Math.max(1, Math.round(enduranceTarget * taperFreqFactors[Math.min(marathonPhase.taperWeek - 1, 2)]));
  }
  const adjustedTargets = { ...targets, endurancePerWeek: enduranceTarget, strengthPerWeek: targets.strengthPerWeek };

  const hardDatesForPlanning = new Set(recentSignals.hardDates);
  if (recentSignals.trainedToday) hardDatesForPlanning.add(today);
  const planningSignals = { ...recentSignals, hardDates: hardDatesForPlanning };

  const normalizedWorkouts = (workouts || []).map(normalizeWorkout).filter((w) => !!w.localDate);

  let sessions = [];
  let strengthShortfall = false;

  const baseline = intake.baseline || {};

  if (mode === 'strength_only') {
    sessions = buildStrengthSessions({
      intake,
      targets: adjustedTargets,
      slots,
      maxMinutes,
      recentHardDates: planningSignals.hardDates,
      recentVeryHardDates: planningSignals.veryHardDates,
      completedWorkouts: normalizedWorkouts,
      strengthTarget: targets.strengthPerWeek,
      maxHardPerWeek,
      marathonPhase,
    });
  } else if (mode === 'endurance_only') {
    sessions = buildEnduranceSessions({
      enduranceMilestone,
      targets: adjustedTargets,
      slots,
      recentSignals: planningSignals,
      maxMinutes,
      baseline,
      marathonPhase,
      completedWorkouts: normalizedWorkouts,
      enduranceTarget,
      maxHardPerWeek,
    });
  } else {
    // Hybrid mode:
    // 1. Endurance gets priority when marathon is the primary goal. Otherwise interleaved.
    // 2. Before endurance placement, reserve a guaranteed minimum for strength
    //    (min(2, strengthTarget) slots) so they are never crowded out.
    // 3. Two-a-days: only activated as FALLBACK when strength target cannot be met with
    //    single sessions on free days. allowTwoADays in intake = "permitted if needed",
    //    not "always use two-a-days". Fyfe et al. 2016: two-a-days only when necessary,
    //    with ≥3h separation (strength morning, endurance evening).
    // Per-slot rolling window prevents last week's workouts blocking this week. SRC029–SRC032.

    const twoADaysPermitted = intake.constraints?.allowTwoADays === true;
    // allowTwoADays is now derived dynamically in Step 4 (only if quota can't be met)
    const allowTwoADays = twoADaysPermitted;
    const hasMarathonGoal = !!marathonMilestone;
    const strTarget = targets.strengthPerWeek;
    const minStrengthGuarantee = strTarget >= 1 ? Math.min(strTarget, 2) : 0;

    // Step 1: Pre-reserve strength slots (guaranteed minimum)
    // We run a dry-run of strength placement to claim the best slots first.
    const reservedStrSessions = minStrengthGuarantee > 0
      ? buildStrengthSessions({
          intake,
          targets: adjustedTargets,
          slots,
          maxMinutes,
          recentHardDates: planningSignals.hardDates,
          recentVeryHardDates: planningSignals.veryHardDates,
          completedWorkouts: normalizedWorkouts,
          strengthTarget: minStrengthGuarantee,
          maxHardPerWeek,
          marathonPhase,
        })
      : [];
    const reservedStrDates = new Set(reservedStrSessions.map((s) => s.localDate));

    // Step 2: Endurance planning on all slots; when marathon goal → skip reserved str slots
    // (unless two-a-days enabled, in which case reserved slots are still available for endurance).
    const enduranceSlots = (hasMarathonGoal && !allowTwoADays)
      ? slots.filter((s) => !reservedStrDates.has(s.dateStr))
      : slots;

    const enduranceSessions = buildEnduranceSessions({
      enduranceMilestone,
      targets: adjustedTargets,
      slots: enduranceSlots,
      recentSignals: planningSignals,
      maxMinutes,
      baseline,
      marathonPhase,
      completedWorkouts: normalizedWorkouts,
      enduranceTarget,
      maxHardPerWeek,
      strengthTarget: strTarget,
    });
    const enduranceDates = new Set(enduranceSessions.map((s) => s.localDate));

    // Step 3: Full strength placement on non-endurance slots
    // (guaranteed slots + any additional free slots).
    // LR buffer: day before LR is protected — no hard session the day before the key workout.
    // Maffetone 2010: LR quality depends on arriving fresh. Already partially enforced by
    // bidirectional adjacency in canPlaceHardOnDate, but made explicit here for clarity.
    const lrSession = enduranceSessions.find((s) => s.kind === 'LR');
    const lrBufferDate = lrSession ? addDays(lrSession.localDate, -1) : null;
    const enduranceHardDates = new Set(enduranceSessions.filter((s) => isHardKind(s.kind)).map((s) => s.localDate));
    if (lrBufferDate) enduranceHardDates.add(lrBufferDate); // explicitly protect day before LR

    // If readiness will gate today's LR (score < 50), LR will need carryover — protect Saturday
    // so strength doesn't claim it. This gives the carryover a free weekend landing spot.
    const readinessScore = recentSignals.readiness?.score ?? 100;
    const todayHasLR = enduranceSessions.some((s) => s.kind === 'LR' && s.localDate === today);
    const lrWillBeGated = readinessScore < 50 && todayHasLR;
    const saturdayDate = addDays(today, 6);
    const saturdayDow = new Date(saturdayDate + 'T12:00:00').getDay();
    const saturdayStr = saturdayDow === 6 ? saturdayDate : null; // only if it's actually a Saturday

    // Strength slot sorting: prefer weekdays over Saturday (keep Saturday free for LR carryover).
    // When LR will be gated: also exclude Saturday from strength slots entirely.
    const strengthSlots = slots
      .filter((s) => {
        if (enduranceDates.has(s.dateStr)) return false;
        if (lrWillBeGated && saturdayStr && s.dateStr === saturdayStr) return false;
        return true;
      })
      .sort((a, b) => {
        // Prefer weekdays (Mon–Fri) over Saturday to keep weekend free for LR
        const dowA = new Date(a.dateStr + 'T12:00:00').getDay();
        const dowB = new Date(b.dateStr + 'T12:00:00').getDay();
        const isSatA = dowA === 6 ? 1 : 0;
        const isSatB = dowB === 6 ? 1 : 0;
        return isSatA - isSatB;
      });

    const strengthSessions = buildStrengthSessions({
      intake,
      targets: adjustedTargets,
      slots: strengthSlots,
      maxMinutes,
      avoidHardDates: enduranceHardDates,
      recentHardDates: planningSignals.hardDates,
      recentVeryHardDates: planningSignals.veryHardDates,
      completedWorkouts: normalizedWorkouts,
      strengthTarget: strTarget,
      maxHardPerWeek,
      marathonPhase,
    });

    // Step 4: Two-a-days — FALLBACK ONLY when strength quota cannot be met on free days.
    // Only activates when: (a) user permits it AND (b) single-session placement came up short.
    // Preferred sequencing: strength morning, endurance evening (Fyfe et al. 2016, SRC030).
    let twoADaySessions = [];
    if (twoADaysPermitted && strengthSessions.length < strTarget) {
      const alreadyStrDates = new Set(strengthSessions.map((s) => s.localDate));
      const easyEnduranceDays = enduranceSessions
        .filter((s) => s.hardness === 'easy' && !alreadyStrDates.has(s.localDate) && s.localDate !== lrBufferDate)
        .sort((a, b) => a.localDate.localeCompare(b.localDate));

      const twoADaySlots = easyEnduranceDays
        .map((s) => slots.find((sl) => sl.dateStr === s.localDate))
        .filter(Boolean);

      const remaining = strTarget - strengthSessions.length;
      const extraStr = buildStrengthSessions({
        intake,
        targets: adjustedTargets,
        slots: twoADaySlots,
        maxMinutes,
        avoidHardDates: enduranceHardDates, // includes LR date + lrBufferDate
        recentHardDates: planningSignals.hardDates,
        recentVeryHardDates: planningSignals.veryHardDates,
        completedWorkouts: normalizedWorkouts,
        strengthTarget: remaining,
        maxHardPerWeek,
        marathonPhase,
        startIndex: strengthSessions.length, // continue naming from where regular strength left off
      });
      // Tag two-a-day sessions with timing recommendation
      twoADaySessions = extraStr.map((s) => ({
        ...s,
        id: s.id + '_2ad',
        twoADay: true,
        note: 'Two-a-day: Kraft morgens (≥3h vor Ausdauer). Kein HIIT/Intervals am gleichen Tag (Interferenz-Effekt).',
      }));
    }

    // Combine and re-index strength sessions by calendar order (A = earliest, B = next...)
    // so naming reflects the actual training week sequence, not placement order.
    const allStrengthSessions = [...strengthSessions, ...twoADaySessions]
      .sort((a, b) => a.localDate.localeCompare(b.localDate));
    const split = intake.baseline?.strengthSplitPreference || 'full_body';
    const splitTitles = { full_body: ['Full Body A', 'Full Body B'], upper_lower: ['Upper', 'Lower'], push_pull_legs: ['Push', 'Pull', 'Legs'], bro_split: ['Chest/Triceps', 'Back/Biceps', 'Legs', 'Shoulders'] };
    const strTitles = splitTitles[split] || splitTitles.full_body;
    const reindexedStrength = allStrengthSessions.map((s, i) => ({ ...s, title: strTitles[i % strTitles.length] }));

    sessions = [...enduranceSessions, ...reindexedStrength];
    if (!allowTwoADays) sessions = enforceNoMixedModalityPerDay(sessions);

    const totalStrength = sessions.filter((s) => s.modality === 'strength').length;
    strengthShortfall = strTarget >= 2 && totalStrength < 2;
  }

  sessions = applyGuardrails(sessions);
  const { sessions: readinessGatedSessions, readinessGated } = applyReadinessGating(sessions, recentSignals.readiness, today);
  sessions = readinessGatedSessions.sort((a, b) => a.localDate.localeCompare(b.localDate));

  let lrCarryoverFailed = false;
  if (mode !== 'strength_only' && enduranceMilestone) {
    const carryover = applyLRCarryover(sessions, planningSignals, maxHardPerWeek, enduranceMilestone, normalizedWorkouts, slots);
    sessions = carryover.sessions.sort((a, b) => a.localDate.localeCompare(b.localDate));
    lrCarryoverFailed = carryover.lrCarryoverFailed;
  }

  // 80/20 polarized ratio (Seiler 2009): endurance-only — target ≤25% hard within endurance
  // Strength and fixedEvents are NOT counted; they follow separate rules (Hard-Budget, Recovery).
  const enduranceSessions = sessions.filter((s) => isEnduranceKind(s.kind));
  const enduranceHard = enduranceSessions.filter((s) => isHardKind(s.kind)).length;
  const enduranceEasy = enduranceSessions.filter((s) => !isHardKind(s.kind)).length;
  const enduranceTotal = enduranceHard + enduranceEasy;
  const hardRatio = enduranceTotal > 0 ? enduranceHard / enduranceTotal : 0;
  const polarizedRatioOk = hardRatio <= 0.25;

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
      deloadReason: targets.deloadReason ?? null,
      acwr: targets.acwr,
      strengthShortfall: strengthShortfall || null,
    },
    polarizedRatio: {
      scope: 'endurance_only',
      hard: Math.round(hardRatio * 100) / 100,
      target: 0.2,
      ok: polarizedRatioOk,
      hardCount: enduranceHard,
      easyCount: enduranceEasy,
      totalCount: enduranceTotal,
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
    marathonPhase: marathonPhase ?? null,
  };

  return {
    sessions,
    recommendations: buildRecommendations(intake.goals || [], targets, recentSignals.readiness, readinessGated, marathonPhase, !polarizedRatioOk, lrCarryoverFailed, strengthShortfall),
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

  // Auto-update longestRecentRunMinutes from completed endurance workouts (last 14 days)
  const longestCompletedEndurance = workoutsRaw
    .filter((w) => {
      const d = w.localDate || w.date;
      if (!d || diffDays(today, d) > 14 || diffDays(today, d) < 0) return false;
      return workoutModalityClass(w.type || w.workout_type || w.workoutType) === 'endurance';
    })
    .reduce((max, w) => {
      const min = Math.round((w.duration_seconds ?? w.durationSeconds ?? w.duration ?? 0) / 60);
      return Math.max(max, min);
    }, 0);
  const currentBaseline = intake.baseline?.longestRecentRunMinutes ?? 0;
  if (longestCompletedEndurance > currentBaseline && intake.baseline) {
    intake.baseline.longestRecentRunMinutes = longestCompletedEndurance;
    fs.writeFileSync(INTAKE_FILE, JSON.stringify(intake, null, 2), 'utf8');
  }

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
  const fixedEvents = getFixedEventsInWindow(constraints, today, addDays(today, 6));
  ensureDir(path.join(WORKSPACE, 'current'));
  fs.writeFileSync(
    path.join(WORKSPACE, 'current', 'training_plan_week.json'),
    JSON.stringify({
      updatedAt: new Date().toISOString(),
      weekStart: today,
      sessions: nextWeekSessions,
      fixedEvents,
      status: currentStatus ? { status: currentStatus.status, until: currentStatus.until, note: currentStatus.note } : null,
      blueprint,
    }, null, 2),
    'utf8'
  );

  console.log('Plan generated. Sessions:', sessions.length, 'Mode:', blueprint.mode, 'Deload:', blueprint.targets.deload);
}

main();
