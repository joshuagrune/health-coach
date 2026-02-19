#!/usr/bin/env node
/**
 * Reconciles planned sessions with actual Salvor workouts. Applies adaptation rules.
 * Supports all session types: LR, Tempo, Intervals, Z2, Strength, Cycling, Swim, Bike, Brick.
 * Missed/swap/drop rules per type. Writes to adaptation_log.jsonl and workout_calendar.json.
 *
 * Rules:
 * - LR: missed → swap or shorten (RULE_LR_MISSED_SWAP_OR_SHORTEN)
 * - Tempo: missed → swap within 48–72h (RULE_TEMPO_MISSED_SWAP)
 * - Intervals: missed → drop (RULE_INTERVALS_MISSED_DROP)
 * - Strength: missed → safe swap next slot (RULE_STRENGTH_MISSED_SWAP)
 * - Z2: missed → skipped (low priority)
 * - Cycling: missed → swap or skip (RULE_CYCLING_MISSED_SWAP)
 * - Swim/Bike/Brick: missed → swap (RULE_TRIATHLON_MISSED_SWAP)
 */

const fs = require('fs');
const path = require('path');

const WORKSPACE = process.env.OPENCLAW_WORKSPACE || path.join(process.env.HOME || '/root', '.openclaw/workspace');
const COACH_ROOT = path.join(WORKSPACE, 'health', 'coach');
const CACHE_DIR = path.join(COACH_ROOT, 'salvor_cache');
const CALENDAR_FILE = path.join(COACH_ROOT, 'workout_calendar.json');
const ADAPTATION_LOG = path.join(COACH_ROOT, 'adaptation_log.jsonl');
const TZ = 'Europe/Berlin';

const KIND_MAP = {
  'Long Run': 'LR', 'Long Run (MP segments)': 'LR', 'Zone 2': 'Z2', 'Tempo': 'Tempo', 'Marathon Pace': 'Tempo',
  'Intervals': 'Intervals', 'Full Body': 'Strength', 'Full Body A': 'Strength', 'Full Body B': 'Strength',
  'Upper': 'Strength', 'Lower': 'Strength', 'Push': 'Strength', 'Pull': 'Strength', 'Legs': 'Strength',
  'Strength Training': 'Strength', 'Flexibility': 'Strength', 'Running': 'Z2', 'Walking': 'Z2',
  'Climbing': 'Strength', 'Cycling': 'Cycling', 'Mind and Body': 'Strength',
  'Swim': 'Swim', 'Swimming': 'Swim', 'Bike': 'Bike', 'Brick': 'Brick',
};

const MISSED_RULES = {
  LR: { status: 'missed', ruleRefs: ['RULE_LR_MISSED_SWAP_OR_SHORTEN'], evidenceRefs: ['SRC003'] },
  Tempo: { status: 'missed', ruleRefs: ['RULE_TEMPO_MISSED_SWAP'], evidenceRefs: ['SRC003'] },
  Intervals: { status: 'missed', ruleRefs: ['RULE_INTERVALS_MISSED_DROP'], evidenceRefs: ['SRC003'] },
  Strength: { status: 'missed', ruleRefs: ['RULE_STRENGTH_MISSED_SWAP'], evidenceRefs: ['SRC003'] },
  Z2: { status: 'skipped', ruleRefs: ['RULE_Z2_MISSED_SKIP'], evidenceRefs: ['SRC003'] },
  Cycling: { status: 'missed', ruleRefs: ['RULE_CYCLING_MISSED_SWAP'], evidenceRefs: ['SRC003'] },
  Swim: { status: 'missed', ruleRefs: ['RULE_TRIATHLON_MISSED_SWAP'], evidenceRefs: ['SRC003'] },
  Bike: { status: 'missed', ruleRefs: ['RULE_TRIATHLON_MISSED_SWAP'], evidenceRefs: ['SRC003'] },
  Brick: { status: 'missed', ruleRefs: ['RULE_TRIATHLON_MISSED_SWAP'], evidenceRefs: ['SRC003'] },
};

function loadJson(p) {
  try {
    return JSON.parse(fs.readFileSync(p, 'utf8'));
  } catch {
    return null;
  }
}

const { isDateInStatusBlock } = require('../lib/status-helper');

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

function appendAdaptation(event) {
  fs.appendFileSync(ADAPTATION_LOG, JSON.stringify(event) + '\n', 'utf8');
}

function normalizeTitle(t) {
  return (t || '').toLowerCase().replace(/\s*\([^)]+\)\s*$/, '').trim();
}

function kindMatch(plannedKind, workoutType) {
  const p = (KIND_MAP[plannedKind] || plannedKind || '').toLowerCase();
  const wt = (workoutType || '').toLowerCase();
  const w = (KIND_MAP[workoutType] || workoutType || '').toLowerCase();
  if (p === w) return true;
  if (p === 'lr' && /run|zone|walking/i.test(wt)) return true;
  if (p === 'z2' && /run|zone|walking|cycling|cardio|jog/i.test(wt)) return true;
  if (p === 'strength' && /strength|full body|upper|lower|push|pull|legs|flexibility|climbing|gym|hypertrophy|mind and body/i.test(wt)) return true;
  if (p === 'tempo' && /run|interval|tempo/i.test(wt)) return true;
  if (p === 'intervals' && /interval|run|hiit/i.test(wt)) return true;
  if (p === 'cycling' && /cycling|bike|indoor cycling|outdoor cycling/i.test(wt)) return true;
  if (p === 'swim' && /swim|swimming/i.test(wt)) return true;
  if (p === 'bike' && /cycling|bike|indoor cycling|outdoor cycling/i.test(wt)) return true;
  if (p === 'brick' && /brick|bike.*run|run.*bike|multisport/i.test(wt)) return true;
  return false;
}

function timeMatch(plannedDate, plannedTitle, workout) {
  const wDate = workout.localDate || (workout.start_time ? new Date(workout.start_time).toLocaleDateString('en-CA', { timeZone: TZ }) : null);
  if (wDate !== plannedDate) return false;
  const wStart = workout.start_time || workout.startTime || workout.start;
  if (!wStart) return true; // date match only
  const wh = new Date(wStart).getUTCHours();
  const wm = new Date(wStart).getUTCMinutes();
  // Assume planned default 10:00 local - we don't have planned time, so match by date + type
  return true;
}

/** Duration match: planned vs actual within ±30% (e.g. 60min planned, 42–78min actual) */
function durationMatch(plannedMin, workout) {
  if (!plannedMin || plannedMin <= 0) return true;
  const actualSec = workout.duration_seconds ?? workout.durationSeconds ?? workout.duration ?? 0;
  const actualMin = actualSec / 60;
  if (actualMin <= 0) return true;
  const ratio = actualMin / plannedMin;
  return ratio >= 0.7 && ratio <= 1.3;
}

function matchSessionToWorkout(session, workouts) {
  const date = session.localDate;
  const kind = session.kind || session.title;
  const plannedMin = session.targets?.durationMinutes ?? null;
  for (const w of workouts) {
    const wDate = w.localDate || (w.startTimeUtc ? new Date(w.startTimeUtc).toLocaleDateString('en-CA', { timeZone: TZ }) : null);
    if (wDate !== date) continue;
    if (!kindMatch(kind, w.workout_type || w.workoutType || w.type)) continue;
    if (!durationMatch(plannedMin, w)) continue;
    return w;
  }
  return null;
}

/** Normalize Salvor workout ID to consistent salvor: prefix */
function normalizeWorkoutId(match) {
  const raw = match.id;
  if (!raw) return null;
  const s = String(raw);
  return s.startsWith('salvor:') ? s : `salvor:${s}`;
}

function main() {
  const calendar = loadJson(CALENDAR_FILE);
  if (!calendar?.plan?.sessions) {
    console.error('No workout_calendar.json or plan.sessions');
    process.exit(1);
  }

  const workouts = loadJsonlFiles('workouts_');
  const today = new Date().toLocaleDateString('en-CA', { timeZone: TZ });

  const sessions = calendar.plan.sessions;
  const usedWorkoutIds = new Set();
  let changed = 0;
  const events = [];

  for (const s of sessions) {
    if (s.localDate > today) continue; // only reconcile past
    if (s.status === 'completed') continue;

    const match = matchSessionToWorkout(s, workouts);
    if (match) {
      const wid = normalizeWorkoutId(match);
      if (!wid || usedWorkoutIds.has(wid)) continue;
      usedWorkoutIds.add(wid);
      s.status = 'completed';
      s.actualWorkoutId = wid;
      changed++;
      events.push({ at: new Date().toISOString(), reason: 'matched', sessionId: s.id, actualWorkoutId: wid, evidenceRefs: ['SRC010'] });
    } else {
      const kind = s.kind || KIND_MAP[s.title] || 'Z2';
      const inStatusBlock = isDateInStatusBlock(s.localDate);
      const rule = MISSED_RULES[kind] || MISSED_RULES.Z2;
      s.status = inStatusBlock ? 'skipped' : rule.status;
      changed++;
      events.push({
        at: new Date().toISOString(),
        reason: inStatusBlock ? 'status_illness_or_travel' : `missed_${kind.toLowerCase()}`,
        sessionId: s.id,
        ruleRefs: inStatusBlock ? ['RULE_DISRUPTION_DELOAD'] : rule.ruleRefs,
        evidenceRefs: rule.evidenceRefs,
      });
    }
  }

  if (changed > 0) {
    calendar.generatedAt = new Date().toISOString();
    calendar.adaptation.events.push(...events);
    fs.writeFileSync(CALENDAR_FILE, JSON.stringify(calendar, null, 2), 'utf8');
    for (const e of events) {
      appendAdaptation(e);
    }
  }

  // Update training_plan_week.json
  const nextWeekSessions = sessions.filter((s) => {
    const d = new Date(s.localDate + 'T12:00:00');
    const t = new Date(today + 'T12:00:00');
    const diff = (d - t) / (24 * 60 * 60 * 1000);
    return diff >= 0 && diff < 7;
  });
  const { getStatus } = require('../lib/status-helper');
  const currentStatus = getStatus();
  const currentDir = path.join(WORKSPACE, 'current');
  if (fs.existsSync(currentDir)) {
    fs.writeFileSync(
      path.join(currentDir, 'training_plan_week.json'),
      JSON.stringify({
        updatedAt: new Date().toISOString(),
        weekStart: today,
        sessions: nextWeekSessions,
        status: currentStatus ? { status: currentStatus.status, until: currentStatus.until, note: currentStatus.note } : null,
      }, null, 2),
      'utf8'
    );
  }

  console.log('Adaptive replan done. Updated', changed, 'sessions. Events:', events.length);
}

main();
