#!/usr/bin/env node
/**
 * Calendar reconciliation: reads published calendar events (sessionId in DESCRIPTION),
 * detects moved/deleted sessions, writes adaptation events, updates workout_calendar.json
 * and training_plan_week.json.
 *
 * Run vdirsyncer sync first. Reads from vdirsyncer storage (VDIRSYNCER_CALENDAR_PATH
 * or ~/.local/share/vdirsyncer/calendars/).
 */

const fs = require('fs');
const path = require('path');

const WORKSPACE = process.env.OPENCLAW_WORKSPACE || path.join(process.env.HOME || '/root', '.openclaw/workspace');
const COACH_ROOT = path.join(WORKSPACE, 'health', 'coach');
const CALENDAR_FILE = path.join(COACH_ROOT, 'workout_calendar.json');
const ADAPTATION_LOG = path.join(COACH_ROOT, 'adaptation_log.jsonl');
const TZ = 'Europe/Berlin';

/** Sport calendar ID. Set SPORT_CALENDAR_ID in env or workspace/.env. Never hardcode. */
function getSportCalendarId() {
  if (process.env.SPORT_CALENDAR_ID) return process.env.SPORT_CALENDAR_ID.trim().replace(/^["']|["']$/g, '');
  try {
    const envPath = path.join(WORKSPACE, '.env');
    if (fs.existsSync(envPath)) {
      const raw = fs.readFileSync(envPath, 'utf8');
      const m = raw.match(/^\s*SPORT_CALENDAR_ID\s*=\s*(.+)/m);
      if (m) return m[1].trim().replace(/^["']|["']$/g, '');
    }
  } catch (_) {}
  return null;
}

const VDIRSYNCER_BASE = process.env.VDIRSYNCER_CALENDAR_PATH || path.join(process.env.HOME || '/root', '.local/share/vdirsyncer/calendars');

function loadJson(p) {
  try {
    return JSON.parse(fs.readFileSync(p, 'utf8'));
  } catch {
    return null;
  }
}

function appendAdaptation(event) {
  try {
    fs.appendFileSync(ADAPTATION_LOG, JSON.stringify(event) + '\n', 'utf8');
  } catch (_) {}
}

/** Parse ics content, extract events with health-coach:sessionId in DESCRIPTION */
function parseIcsForHealthCoach(icsContent) {
  const events = [];
  const blocks = icsContent.split(/BEGIN:VEVENT/);
  for (let i = 1; i < blocks.length; i++) {
    const block = blocks[i].split(/END:VEVENT/)[0];
    const descMatch = block.match(/DESCRIPTION[^:]*:(.+?)(?:\r?\n[A-Z]|$)/s);
    const desc = descMatch ? descMatch[1].replace(/\\n/g, '\n').trim() : '';
    const sessionIdMatch = desc.match(/health-coach:([^\s]+)/);
    if (!sessionIdMatch) continue;
    const sessionId = sessionIdMatch[1];
    const dtStart = block.match(/DTSTART[^:]*:([^\r\n]+)/);
    if (!dtStart) continue;
    let localDate;
    const dt = dtStart[1];
    if (dt.includes('T')) {
      const d = new Date(dt.replace(/(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})/, '$1-$2-$3T$4:$5:$6'));
      localDate = d.toLocaleDateString('en-CA', { timeZone: TZ });
    } else {
      localDate = dt.replace(/(\d{4})(\d{2})(\d{2})/, '$1-$2-$3');
    }
    events.push({ sessionId, localDate });
  }
  return events;
}

/** Find calendar directory for Sport calendar */
function findCalendarDir() {
  const sportCalendarId = getSportCalendarId();
  if (!sportCalendarId || !fs.existsSync(VDIRSYNCER_BASE)) return null;
  const dirs = fs.readdirSync(VDIRSYNCER_BASE, { withFileTypes: true });
  for (const d of dirs) {
    if (!d.isDirectory()) continue;
    const sub = path.join(VDIRSYNCER_BASE, d.name);
    const subDirs = fs.readdirSync(sub, { withFileTypes: true });
    for (const sd of subDirs) {
      if (sd.isDirectory() && sd.name === sportCalendarId) {
        return path.join(sub, sd.name);
      }
    }
  }
  return null;
}

/** Read all ics files from calendar dir, return { sessionId -> localDate } */
function readCalendarEvents(calDir) {
  const sessionToDate = {};
  if (!calDir || !fs.existsSync(calDir)) return sessionToDate;
  const files = fs.readdirSync(calDir).filter((f) => f.endsWith('.ics'));
  for (const f of files) {
    try {
      const content = fs.readFileSync(path.join(calDir, f), 'utf8');
      const events = parseIcsForHealthCoach(content);
      for (const e of events) {
        sessionToDate[e.sessionId] = e.localDate;
      }
    } catch (_) {}
  }
  return sessionToDate;
}

function main() {
  const calendar = loadJson(CALENDAR_FILE);
  if (!calendar?.plan?.sessions) {
    console.log('No workout_calendar.json or plan.sessions. Skipping reconcile.');
    return;
  }

  const calDir = findCalendarDir();
  if (!getSportCalendarId()) {
    console.log('SPORT_CALENDAR_ID not set. Skipping calendar event reconciliation.');
  }
  const sessionToDate = calDir ? readCalendarEvents(calDir) : {};

  const today = new Date().toLocaleDateString('en-CA', { timeZone: TZ });
  const sessions = calendar.plan.sessions;
  const events = [];
  let changed = 0;

  for (const s of sessions) {
    if (s.localDate < today) continue;
    const published = s.calendar?.publishedAt || s.calendar?.khalUid;
    if (!published) continue;
    if (!calDir) continue; // Can't reconcile without calendar access

    const calDate = sessionToDate[s.id];
    if (!calDate) {
      s.status = 'cancelled';
      s.calendar = s.calendar || {};
      s.calendar.reconciledAt = new Date().toISOString();
      s.calendar.reconcileReason = 'deleted';
      changed++;
      events.push({
        at: new Date().toISOString(),
        reason: 'calendar_deleted',
        sessionId: s.id,
        ruleRefs: ['RULE_CALENDAR_RECONCILE'],
        evidenceRefs: [],
      });
    } else if (calDate !== s.localDate) {
      const fromDate = s.localDate;
      s.localDate = calDate;
      s.calendar = s.calendar || {};
      s.calendar.reconciledAt = new Date().toISOString();
      s.calendar.reconcileReason = 'moved';
      changed++;
      events.push({
        at: new Date().toISOString(),
        reason: 'calendar_moved',
        sessionId: s.id,
        fromDate,
        toDate: calDate,
        ruleRefs: ['RULE_CALENDAR_RECONCILE'],
        evidenceRefs: [],
      });
    }
  }

  if (changed > 0) {
    calendar.generatedAt = new Date().toISOString();
    calendar.adaptation = calendar.adaptation || { events: [] };
    calendar.adaptation.events.push(...events);
    fs.writeFileSync(CALENDAR_FILE, JSON.stringify(calendar, null, 2), 'utf8');
    for (const e of events) appendAdaptation(e);
  }

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

  if (changed > 0) {
    console.log('Calendar reconcile done. Updated', changed, 'sessions. Events:', events.length);
  } else {
    console.log('Calendar reconcile done. No changes.');
  }
}

main();
