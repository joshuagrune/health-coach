#!/usr/bin/env node
/**
 * Long-term Salvor sync for Health Coach.
 * Fetches workouts, sleep, activity, vitals, scores; normalizes to UTC + localDate (Europe/Berlin);
 * appends to monthly JSONL files in workspace/health/coach/salvor_cache/.
 *
 * Requires: SALVOR_API_KEY (injected by OpenClaw or from .env fallback).
 * State: workspace/health/coach/salvor_sync_state.json
 */

const { execSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const WORKSPACE = process.env.OPENCLAW_WORKSPACE || path.join(process.env.HOME || '/root', '.openclaw/workspace');
const COACH_ROOT = path.join(WORKSPACE, 'health', 'coach');
const CACHE_DIR = path.join(COACH_ROOT, 'salvor_cache');
const STATE_FILE = path.join(COACH_ROOT, 'salvor_sync_state.json');
const TZ = 'Europe/Berlin';
const BASE_URL = 'https://api.salvor.eu';

// Env fallback (manual run)
if (!process.env.SALVOR_API_KEY) {
  const envPaths = [
    path.join(WORKSPACE, '.env'),
    path.join(WORKSPACE, '..', '.env'),
  ];
  for (const p of envPaths) {
    try {
      if (!fs.existsSync(p)) continue;
      const raw = fs.readFileSync(p, 'utf8');
      const m = raw.match(/^\s*SALVOR_API_KEY\s*=\s*(.+)/m);
      if (m) {
        process.env.SALVOR_API_KEY = m[1].trim().replace(/^["']|["']$/g, '');
        break;
      }
    } catch (_) {}
  }
}

function ensureDir(dir) {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

function curl(url) {
  const key = process.env.SALVOR_API_KEY;
  if (!key) {
    throw new Error('SALVOR_API_KEY not set');
  }
  const out = execSync(
    `curl -s -H "Authorization: Bearer ${key}" "${url}"`,
    { encoding: 'utf8', maxBuffer: 4 * 1024 * 1024 }
  );
  return JSON.parse(out || '{}');
}

/** ISO date in Europe/Berlin for a UTC timestamp */
function toLocalDate(isoUtc) {
  const d = new Date(isoUtc);
  return d.toLocaleDateString('en-CA', { timeZone: TZ });
}

/** YYYY-MM for monthly file */
function toMonthKey(localDate) {
  return localDate.slice(0, 7);
}

function loadState() {
  try {
    const raw = fs.readFileSync(STATE_FILE, 'utf8');
    return JSON.parse(raw);
  } catch {
    return {
      lastSuccessfulSyncAt: null,
      lastWorkoutStartTimeSeen: null,
      lastDateSyncedLocal: null,
      bootstrapDone: false,
    };
  }
}

function saveState(state) {
  ensureDir(COACH_ROOT);
  fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2), 'utf8');
}

/** Get existing record IDs in a monthly file to avoid duplicates */
function getExistingIds(filePath, idField) {
  if (!fs.existsSync(filePath)) return new Set();
  const ids = new Set();
  for (const line of fs.readFileSync(filePath, 'utf8').trim().split('\n').filter(Boolean)) {
    try {
      const rec = JSON.parse(line);
      const id = rec[idField] ?? rec.id ?? (rec.start_time && rec.workout_type ? `${rec.start_time}|${rec.workout_type}` : null);
      if (id) ids.add(String(id));
    } catch (_) {}
  }
  return ids;
}

function appendJsonl(filePath, records, idField) {
  ensureDir(path.dirname(filePath));
  const existing = getExistingIds(filePath, idField);
  const toAppend = records.filter((r) => {
    const id = r[idField] ?? r.id ?? (r.start_time && r.workout_type ? `${r.start_time}|${r.workout_type}` : null);
    return id && !existing.has(String(id));
  });
  if (toAppend.length === 0) return 0;
  const lines = toAppend.map((r) => JSON.stringify(r)).join('\n') + '\n';
  fs.appendFileSync(filePath, lines, 'utf8');
  return toAppend.length;
}

/** Normalize workout: add startTimeUtc, endTimeUtc, localDate */
function normalizeWorkout(w) {
  const startIso = w.start_time ?? w.startTime ?? w.start;
  if (!startIso) return null;
  const startDate = new Date(startIso);
  const durationSec = w.duration_seconds ?? w.durationSeconds ?? w.duration ?? 0;
  const endDate = new Date(startDate.getTime() + durationSec * 1000);
  const localDate = toLocalDate(startIso);
  return {
    ...w,
    startTimeUtc: startDate.toISOString(),
    endTimeUtc: endDate.toISOString(),
    localDate,
    id: w.id != null ? `salvor:${w.id}` : `salvor:${w.start_time ?? w.startTime ?? w.start}_${(w.workout_type ?? w.workoutType ?? w.type ?? 'unknown').replace(/\s/g, '_')}`,
  };
}

/** Normalize sleep record */
function normalizeSleep(s) {
  const date = s.date ?? (s.start_time ? toLocalDate(s.start_time) : null);
  if (!date) return null;
  return {
    ...s,
    localDate: date,
    id: s.id ?? `sleep:${date}`,
  };
}

/** Normalize activity record */
function normalizeActivity(a) {
  const date = a.date ?? (a.start_time ? toLocalDate(a.start_time) : null);
  if (!date) return null;
  return {
    ...a,
    localDate: date,
    id: a.id ?? `activity:${date}`,
  };
}

/** Normalize vitals record */
function normalizeVitals(v) {
  const date = v.date ?? (v.start_time ? toLocalDate(v.start_time) : null);
  if (!date) return null;
  return {
    ...v,
    localDate: date,
    id: v.id ?? `vitals:${date}`,
  };
}

/** Normalize scores (daily) */
function normalizeScores(s) {
  const date = s.date ?? (s.target_date ? s.target_date : null);
  if (!date) return null;
  return {
    ...s,
    localDate: date,
    id: s.id ?? `scores:${date}`,
  };
}

function fetchWorkouts(startDate, endDate) {
  const url = `${BASE_URL}/health/workouts?start_date=${startDate}&end_date=${endDate}&limit=100`;
  try {
    const data = curl(url);
    const list = Array.isArray(data) ? data : (data.workouts ?? data.data ?? []);
    return list;
  } catch (e) {
    console.error('Workouts fetch error:', e.message);
    return [];
  }
}

function fetchSleep(startDate, endDate) {
  const url = `${BASE_URL}/health/sleep?start_date=${startDate}&end_date=${endDate}`;
  try {
    const data = curl(url);
    const list = Array.isArray(data) ? data : (data.sleep ?? data.data ?? data.records ?? []);
    return list;
  } catch (e) {
    console.error('Sleep fetch error:', e.message);
    return [];
  }
}

function fetchActivity(startDate, endDate) {
  const url = `${BASE_URL}/health/activity?start_date=${startDate}&end_date=${endDate}`;
  try {
    const data = curl(url);
    const list = Array.isArray(data) ? data : (data.activity ?? data.data ?? data.records ?? []);
    return list;
  } catch (e) {
    console.error('Activity fetch error:', e.message);
    return [];
  }
}

function fetchVitals(startDate, endDate) {
  const url = `${BASE_URL}/health/vitals?start_date=${startDate}&end_date=${endDate}`;
  try {
    const data = curl(url);
    const list = Array.isArray(data) ? data : (data.vitals ?? data.data ?? data.records ?? []);
    return list;
  } catch (e) {
    console.error('Vitals fetch error:', e.message);
    return [];
  }
}

function fetchScoresHistory(days, anchorDate) {
  const url = `${BASE_URL}/scores/history?days=${days}${anchorDate ? `&anchor_date=${anchorDate}` : ''}`;
  try {
    const data = curl(url);
    const list = data.scores ?? data.data ?? (Array.isArray(data) ? data : []);
    return Array.isArray(list) ? list : [];
  } catch (e) {
    console.error('Scores history fetch error:', e.message);
    return [];
  }
}

function main() {
  const key = process.env.SALVOR_API_KEY;
  if (!key) {
    console.error('SALVOR_API_KEY not set');
    process.exit(1);
  }

  ensureDir(COACH_ROOT);
  ensureDir(CACHE_DIR);

  const state = loadState();
  const now = new Date();
  const todayLocal = now.toLocaleDateString('en-CA', { timeZone: TZ });

  // Decide range: bootstrap (90 days) or incremental (7 days)
  const bootstrapDays = parseInt(process.env.SALVOR_BOOTSTRAP_DAYS || '90', 10) || 90;
  const incrementalDays = parseInt(process.env.SALVOR_INCREMENTAL_DAYS || '7', 10) || 7;

  let startDate, endDate;
  if (!state.bootstrapDone) {
    const end = new Date(now);
    const start = new Date(now);
    start.setDate(start.getDate() - bootstrapDays);
    startDate = start.toLocaleDateString('en-CA', { timeZone: TZ });
    endDate = end.toLocaleDateString('en-CA', { timeZone: TZ });
  } else {
    const end = new Date(now);
    const start = new Date(now);
    start.setDate(start.getDate() - incrementalDays);
    startDate = start.toLocaleDateString('en-CA', { timeZone: TZ });
    endDate = end.toLocaleDateString('en-CA', { timeZone: TZ });
  }

  let totalAdded = 0;
  let lastWorkoutStart = state.lastWorkoutStartTimeSeen;

  // Workouts
  const workouts = fetchWorkouts(startDate, endDate);
  const byMonth = {};
  for (const w of workouts) {
    const n = normalizeWorkout(w);
    if (!n) continue;
    const month = toMonthKey(n.localDate);
    if (!byMonth[month]) byMonth[month] = [];
    byMonth[month].push(n);
    if (n.startTimeUtc && (!lastWorkoutStart || n.startTimeUtc > lastWorkoutStart)) {
      lastWorkoutStart = n.startTimeUtc;
    }
  }
  for (const [month, recs] of Object.entries(byMonth)) {
    const fp = path.join(CACHE_DIR, `workouts_${month}.jsonl`);
    totalAdded += appendJsonl(fp, recs, 'id');
  }

  // Sleep
  const sleep = fetchSleep(startDate, endDate);
  const sleepByMonth = {};
  for (const s of sleep) {
    const n = normalizeSleep(s);
    if (!n) continue;
    const month = toMonthKey(n.localDate);
    if (!sleepByMonth[month]) sleepByMonth[month] = [];
    sleepByMonth[month].push(n);
  }
  for (const [month, recs] of Object.entries(sleepByMonth)) {
    const fp = path.join(CACHE_DIR, `sleep_${month}.jsonl`);
    totalAdded += appendJsonl(fp, recs, 'id');
  }

  // Activity
  const activity = fetchActivity(startDate, endDate);
  const actByMonth = {};
  for (const a of activity) {
    const n = normalizeActivity(a);
    if (!n) continue;
    const month = toMonthKey(n.localDate);
    if (!actByMonth[month]) actByMonth[month] = [];
    actByMonth[month].push(n);
  }
  for (const [month, recs] of Object.entries(actByMonth)) {
    const fp = path.join(CACHE_DIR, `activity_${month}.jsonl`);
    totalAdded += appendJsonl(fp, recs, 'id');
  }

  // Vitals
  const vitals = fetchVitals(startDate, endDate);
  const vitByMonth = {};
  for (const v of vitals) {
    const n = normalizeVitals(v);
    if (!n) continue;
    const month = toMonthKey(n.localDate);
    if (!vitByMonth[month]) vitByMonth[month] = [];
    vitByMonth[month].push(n);
  }
  for (const [month, recs] of Object.entries(vitByMonth)) {
    const fp = path.join(CACHE_DIR, `vitals_${month}.jsonl`);
    totalAdded += appendJsonl(fp, recs, 'id');
  }

  // Scores (history)
  const scores = fetchScoresHistory(Math.min(bootstrapDays, 30), todayLocal);
  const scByMonth = {};
  for (const s of scores) {
    const n = normalizeScores(s);
    if (!n) continue;
    const month = toMonthKey(n.localDate);
    if (!scByMonth[month]) scByMonth[month] = [];
    scByMonth[month].push(n);
  }
  for (const [month, recs] of Object.entries(scByMonth)) {
    const fp = path.join(CACHE_DIR, `scores_${month}.jsonl`);
    totalAdded += appendJsonl(fp, recs, 'id');
  }

  // Update state
  state.lastSuccessfulSyncAt = now.toISOString();
  state.lastWorkoutStartTimeSeen = lastWorkoutStart;
  state.lastDateSyncedLocal = todayLocal;
  state.bootstrapDone = true;
  saveState(state);

  console.log(`Salvor sync done. Range: ${startDate}–${endDate}. New records: ${totalAdded}. Workouts: ${workouts.length}, Sleep: ${sleep.length}, Activity: ${activity.length}, Vitals: ${vitals.length}, Scores: ${scores.length}.`);
}

main();
