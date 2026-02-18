#!/usr/bin/env node
/**
 * Reconciles planned sessions with actual Salvor workouts. Applies adaptation rules.
 * Writes to adaptation_log.jsonl and updates workout_calendar.json session statuses.
 * ruleRefs: RULE_NEVER_CRAM, RULE_LR_MISSED_SWAP_OR_SHORTEN, RULE_TEMPO_MISSED_SWAP, etc.
 */

const fs = require('fs');
const path = require('path');

const WORKSPACE = process.env.OPENCLAW_WORKSPACE || path.join(process.env.HOME || '/root', '.openclaw/workspace');
const COACH_ROOT = path.join(WORKSPACE, 'health', 'coach');
const CACHE_DIR = path.join(COACH_ROOT, 'salvor_cache');
const CALENDAR_FILE = path.join(COACH_ROOT, 'workout_calendar.json');
const ADAPTATION_LOG = path.join(COACH_ROOT, 'adaptation_log.jsonl');
const TZ = 'Europe/Berlin';

const TIME_WINDOW_MIN = 30; // ±30 min match
const KIND_MAP = {
  'Long Run': 'LR', 'Long Run (MP segments)': 'LR', 'Zone 2': 'Z2', 'Tempo': 'Tempo', 'Marathon Pace': 'Tempo',
  'Intervals': 'Intervals', 'Full Body': 'Strength', 'Strength Training': 'Strength', 'Flexibility': 'Flexibility',
  'Running': 'Z2', 'Walking': 'Z2', 'Climbing': 'Strength', 'Cycling': 'Z2',
};

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

function appendAdaptation(event) {
  fs.appendFileSync(ADAPTATION_LOG, JSON.stringify(event) + '\n', 'utf8');
}

function normalizeTitle(t) {
  return (t || '').toLowerCase().replace(/\s*\([^)]+\)\s*$/, '').trim();
}

function kindMatch(plannedKind, workoutType) {
  const p = (KIND_MAP[plannedKind] || plannedKind || '').toLowerCase();
  const w = (KIND_MAP[workoutType] || workoutType || '').toLowerCase();
  if (p === w) return true;
  if (p === 'lr' && /run|zone|walking/i.test(workoutType)) return true;
  if (p === 'z2' && /run|zone|walking|cycling/i.test(workoutType)) return true;
  if (p === 'strength' && /strength|full body|flexibility|climbing/i.test(workoutType)) return true;
  if (p === 'tempo' && /run|interval/i.test(workoutType)) return true;
  if (p === 'intervals' && /interval|run/i.test(workoutType)) return true;
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

function matchSessionToWorkout(session, workouts) {
  const date = session.localDate;
  const kind = session.kind || session.title;
  for (const w of workouts) {
    const wDate = w.localDate || (w.startTimeUtc ? new Date(w.startTimeUtc).toLocaleDateString('en-CA', { timeZone: TZ }) : null);
    if (wDate !== date) continue;
    if (!kindMatch(kind, w.workout_type || w.workoutType || w.type)) continue;
    return w;
  }
  return null;
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
      const wid = match.id || `salvor:${match.id}`;
      if (usedWorkoutIds.has(wid)) continue;
      usedWorkoutIds.add(wid);
      s.status = 'completed';
      s.actualWorkoutId = wid;
      changed++;
      events.push({ at: new Date().toISOString(), reason: 'matched', sessionId: s.id, actualWorkoutId: wid, evidenceRefs: ['SRC010'] });
    } else {
      if (s.kind === 'LR' || s.kind === 'Tempo' || s.kind === 'Intervals') {
        s.status = 'missed';
        changed++;
        const rule = s.kind === 'LR' ? 'RULE_LR_MISSED_SWAP_OR_SHORTEN' : s.kind === 'Tempo' ? 'RULE_TEMPO_MISSED_SWAP' : 'RULE_INTERVALS_MISSED_DROP';
        events.push({ at: new Date().toISOString(), reason: `missed_${s.kind.toLowerCase()}`, sessionId: s.id, ruleRefs: [rule], evidenceRefs: ['SRC003'] });
      } else {
        s.status = 'skipped';
        changed++;
      }
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
  const currentDir = path.join(WORKSPACE, 'current');
  if (fs.existsSync(currentDir)) {
    fs.writeFileSync(
      path.join(currentDir, 'training_plan_week.json'),
      JSON.stringify({ updatedAt: new Date().toISOString(), weekStart: today, sessions: nextWeekSessions }, null, 2),
      'utf8'
    );
  }

  console.log('Adaptive replan done. Updated', changed, 'sessions. Events:', events.length);
}

main();
