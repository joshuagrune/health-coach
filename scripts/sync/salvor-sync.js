#!/usr/bin/env node
/**
 * Long-term Salvor sync for Health Coach.
 * Fetches workouts, sleep, activity, vitals, scores; normalizes to UTC + localDate (Europe/Berlin);
 * appends to monthly JSONL files in workspace/health/coach/salvor_cache/.
 * Idempotent: deduplicates by record ID before append.
 *
 * Requires: SALVOR_API_KEY (injected by OpenClaw or from .env fallback).
 * State: workspace/health/coach/salvor_sync_state.json
 * Env: SALVOR_BOOTSTRAP_DAYS (default 365), SALVOR_INCREMENTAL_DAYS (default 7)
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
const WORKOUT_DETAILS_DAYS = Math.max(0, parseInt(process.env.SALVOR_WORKOUT_DETAILS_DAYS || '21', 10) || 21);
const INCLUDE_HR_SAMPLES = process.env.SALVOR_INCLUDE_HR_SAMPLES === '1';

// Prefer workspace .env over OpenClaw-injected env (avoids key mismatch when agent uses different config)
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

function parseDateLocal(dateStr) {
  return new Date(dateStr + 'T12:00:00');
}

function normalizeZoneLabel(key) {
  const s = String(key).toLowerCase().replace(/[^a-z0-9]/g, '');
  if (s === '1' || s === 'z1' || s === 'zone1') return 'z1';
  if (s === '2' || s === 'z2' || s === 'zone2') return 'z2';
  if (s === '3' || s === 'z3' || s === 'zone3') return 'z3';
  if (s === '4' || s === 'z4' || s === 'zone4') return 'z4';
  if (s === '5' || s === 'z5' || s === 'zone5') return 'z5';
  return null;
}

function summarizeHeartRateZones(zones) {
  if (!zones || typeof zones !== 'object' || Array.isArray(zones)) return null;
  const out = { z1: 0, z2: 0, z3: 0, z4: 0, z5: 0 };

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

  for (const [k, v] of Object.entries(zones)) {
    const label = normalizeZoneLabel(k);
    if (!label) continue;
    const mins = toMinutes(v);
    if (mins != null) out[label] += mins;
  }

  const total = out.z1 + out.z2 + out.z3 + out.z4 + out.z5;
  if (total <= 0) return null;

  const rounded = {
    z1: Math.round(out.z1),
    z2: Math.round(out.z2),
    z3: Math.round(out.z3),
    z4: Math.round(out.z4),
    z5: Math.round(out.z5),
  };

  return {
    zones: rounded,
    highMinutes: rounded.z4 + rounded.z5,
    totalMinutes: rounded.z1 + rounded.z2 + rounded.z3 + rounded.z4 + rounded.z5,
  };
}

function fetchWorkoutDetail(workoutId, downsample = true) {
  if (workoutId == null) return null;
  const url = `${BASE_URL}/health/workouts/${encodeURIComponent(workoutId)}?downsample=${downsample ? 'true' : 'false'}`;
  try {
    const data = curl(url);
    return (data && typeof data === 'object' && !Array.isArray(data)) ? (data.workout || data.data || data) : null;
  } catch (_) {
    return null;
  }
}

function enrichWorkoutsWithDetails(workouts, todayLocal, windowDays) {
  if (!Array.isArray(workouts) || workouts.length === 0 || windowDays <= 0) return workouts;
  const cutoff = new Date(parseDateLocal(todayLocal).getTime());
  cutoff.setDate(cutoff.getDate() - Math.max(0, windowDays - 1));

  return workouts.map((w) => {
    const localDate = w.localDate || (w.start_time ? toLocalDate(w.start_time) : null);
    if (!localDate) return w;
    const d = parseDateLocal(localDate);
    if (d < cutoff) return w;

    const detail = fetchWorkoutDetail(w.id, true);
    if (!detail) return w;

    const merged = { ...w, ...detail };
    if (!INCLUDE_HR_SAMPLES && merged.heart_rate_samples) {
      delete merged.heart_rate_samples;
    }
    if (merged.route_points) delete merged.route_points;
    return merged;
  });
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

function upsertJsonl(filePath, records, idField) {
  ensureDir(path.dirname(filePath));
  const byId = new Map();
  const order = [];

  if (fs.existsSync(filePath)) {
    const lines = fs.readFileSync(filePath, 'utf8').trim().split('\n').filter(Boolean);
    for (const line of lines) {
      try {
        const rec = JSON.parse(line);
        const id = rec[idField] ?? rec.id ?? null;
        if (!id) continue;
        const key = String(id);
        if (!byId.has(key)) order.push(key);
        byId.set(key, rec);
      } catch (_) {}
    }
  }

  let changed = 0;
  for (const rec of records) {
    const id = rec[idField] ?? rec.id ?? null;
    if (!id) continue;
    const key = String(id);
    const prev = byId.get(key);
    if (!prev) {
      order.push(key);
      byId.set(key, rec);
      changed++;
      continue;
    }
    const prevStr = JSON.stringify(prev);
    const nextStr = JSON.stringify(rec);
    if (prevStr !== nextStr) {
      byId.set(key, rec);
      changed++;
    }
  }

  if (changed === 0) return 0;
  const out = order.map((k) => JSON.stringify(byId.get(k))).join('\n') + '\n';
  fs.writeFileSync(filePath, out, 'utf8');
  return changed;
}

/** Normalize workout: add startTimeUtc, endTimeUtc, localDate */
function normalizeWorkout(w) {
  const startIso = w.start_time ?? w.startTime ?? w.start;
  if (!startIso) return null;
  const startDate = new Date(startIso);
  const durationSec = w.duration_seconds ?? w.durationSeconds ?? w.duration ?? 0;
  const endDate = new Date(startDate.getTime() + durationSec * 1000);
  const localDate = toLocalDate(startIso);
  const zoneSummary = summarizeHeartRateZones(w.heart_rate_zones);
  return {
    ...w,
    startTimeUtc: startDate.toISOString(),
    endTimeUtc: endDate.toISOString(),
    localDate,
    ...(zoneSummary ? {
      heart_rate_zones: zoneSummary.zones,
      hr_zone_high_minutes: zoneSummary.highMinutes,
      hr_zone_total_minutes: zoneSummary.totalMinutes,
    } : {}),
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

/** Fetch workouts for a single date range (API limit 100) */
function fetchWorkoutsChunk(startDate, endDate) {
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

/** Split date range into chunks of chunkDays; return [{start, end}, ...] */
function chunkDateRange(startDateStr, endDateStr, chunkDays = 14) {
  const chunks = [];
  const start = new Date(startDateStr + 'T12:00:00');
  const end = new Date(endDateStr + 'T12:00:00');
  let cur = new Date(start.getTime());
  while (cur <= end) {
    const chunkEnd = new Date(cur.getTime());
    chunkEnd.setDate(chunkEnd.getDate() + chunkDays - 1);
    const actualEnd = chunkEnd > end ? end : chunkEnd;
    chunks.push({
      start: cur.toLocaleDateString('en-CA', { timeZone: TZ }),
      end: actualEnd.toLocaleDateString('en-CA', { timeZone: TZ }),
    });
    cur.setDate(cur.getDate() + chunkDays);
  }
  return chunks;
}

/** Fetch all workouts in range via pagination (chunk by 14 days to stay under limit=100) */
function fetchWorkouts(startDate, endDate) {
  const chunks = chunkDateRange(startDate, endDate, 14);
  const seen = new Set();
  const out = [];
  for (const { start, end } of chunks) {
    const list = fetchWorkoutsChunk(start, end);
    for (const w of list) {
      const id = w.id ?? `${w.start_time ?? w.startTime ?? w.start}_${w.workout_type ?? w.workoutType ?? w.type}`;
      if (!seen.has(id)) {
        seen.add(id);
        out.push(w);
      }
    }
    if (list.length >= 100) {
      // Might have more; could sub-chunk, but 14d usually sufficient
    }
  }
  return out;
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

const LIGHT_MODE = process.argv.includes('--light') || process.env.SALVOR_LIGHT_SYNC === '1';

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

  let startDate, endDate;
  let bootstrapDays = 90;
  if (LIGHT_MODE) {
    // Light: nur Workouts + Scores der letzten 2 Tage (für 15-Min-Sync)
    const end = new Date(now);
    const start = new Date(now);
    start.setDate(start.getDate() - 2);
    startDate = start.toLocaleDateString('en-CA', { timeZone: TZ });
    endDate = end.toLocaleDateString('en-CA', { timeZone: TZ });
  } else {
    // Full: bootstrap (365 days) or incremental (7 days)
    bootstrapDays = Math.min(parseInt(process.env.SALVOR_BOOTSTRAP_DAYS || '365', 10) || 365, 730);
    const incrementalDays = parseInt(process.env.SALVOR_INCREMENTAL_DAYS || '7', 10) || 7;
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
  }

  let totalAdded = 0;
  let lastWorkoutStart = state.lastWorkoutStartTimeSeen;

  // Workouts
  const workoutsRaw = fetchWorkouts(startDate, endDate);
  const detailWindowDays = LIGHT_MODE ? Math.min(3, WORKOUT_DETAILS_DAYS) : WORKOUT_DETAILS_DAYS;
  const workouts = enrichWorkoutsWithDetails(workoutsRaw, todayLocal, detailWindowDays);
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
    totalAdded += upsertJsonl(fp, recs, 'id');
  }

  if (LIGHT_MODE) {
    // Light: nur Scores (Strain/Readiness) – 1 API-Call
    const scores = fetchScoresHistory(2, todayLocal);
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
    state.lastSuccessfulSyncAt = now.toISOString();
    state.lastWorkoutStartTimeSeen = lastWorkoutStart;
    saveState(state);
    console.log(`Salvor sync (light) done. Workouts: ${workouts.length}, Scores: ${scores.length}. New: ${totalAdded}.`);
    return;
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

  // Scores (history) — API max 90 days
  const scores = fetchScoresHistory(Math.min(bootstrapDays, 90), todayLocal);
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

try {
  main();
} catch (err) {
  console.error('Salvor sync failed:', err.message);
  if (!process.env.SALVOR_API_KEY) {
    console.error('Hint: Set SALVOR_API_KEY in env or workspace .env');
  }
  process.exit(1);
}
