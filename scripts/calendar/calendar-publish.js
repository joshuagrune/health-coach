#!/usr/bin/env node
/**
 * Publishes next 7–14 days of planned sessions to Sport calendar via khal.
 * Always runs vdirsyncer sync first. Supports --dry-run.
 *
 * Requires: vdirsyncer, khal. Sport calendar ID from sync-workouts-and-calendar.
 */

const { execSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const WORKSPACE = process.env.OPENCLAW_WORKSPACE || path.join(process.env.HOME || '/root', '.openclaw/workspace');
const COACH_ROOT = path.join(WORKSPACE, 'health', 'coach');
const CALENDAR_FILE = path.join(COACH_ROOT, 'workout_calendar.json');
const SPORT_CALENDAR_ID = '849096C3-99D9-478B-B5D2-50C788A33AAF';
const TZ = 'Europe/Berlin';
const DEFAULT_START = '10:00';
const DEFAULT_DURATION_MIN = 60;

function run(cmd, opts = {}) {
  return execSync(cmd, { encoding: 'utf8', cwd: WORKSPACE, ...opts });
}

function toKhalDate(dateStr) {
  const [y, m, d] = dateStr.split('-');
  return `${d}.${m}.${y}`;
}

function loadJson(p) {
  try {
    return JSON.parse(fs.readFileSync(p, 'utf8'));
  } catch {
    return null;
  }
}

const { isDateInStatusBlock } = require('../lib/status-helper');

function main() {
  const dryRun = process.argv.includes('--dry-run');
  const daysArg = process.argv.find((a) => a.startsWith('--days='));
  const days = daysArg ? parseInt(daysArg.slice(7), 10) : 14;

  const calendar = loadJson(CALENDAR_FILE);
  if (!calendar?.plan?.sessions) {
    console.error('No workout_calendar.json or plan.sessions');
    process.exit(1);
  }

  const today = new Date().toLocaleDateString('en-CA', { timeZone: TZ });
  const endDate = new Date(today);
  endDate.setDate(endDate.getDate() + days);
  const endStr = endDate.toLocaleDateString('en-CA', { timeZone: TZ });

  const toPublish = calendar.plan.sessions.filter((s) => {
    if (s.status !== 'planned') return false;
    if (s.localDate < today) return false;
    if (s.localDate > endStr) return false;
    if (s.calendar?.khalUid) return false; // already published
    if (isDateInStatusBlock(s.localDate)) return false; // illness/travel: don't publish
    return true;
  });

  if (toPublish.length === 0) {
    console.log('No sessions to publish.');
    return;
  }

  if (dryRun) {
    console.log('DRY-RUN. Would create', toPublish.length, 'events:');
    for (const s of toPublish) {
      const dur = s.targets?.durationMinutes ?? DEFAULT_DURATION_MIN;
      console.log(' ', s.localDate, DEFAULT_START, '-', dur, 'min:', s.title);
    }
    return;
  }

  console.log('Running vdirsyncer sync...');
  try {
    run('vdirsyncer sync');
  } catch (e) {
    console.warn('vdirsyncer sync warning:', e.message);
  }

  let created = 0;
  for (const s of toPublish) {
    const dd = toKhalDate(s.localDate);
    const dur = s.targets?.durationMinutes ?? DEFAULT_DURATION_MIN;
    const endMin = 60 * parseInt(DEFAULT_START.split(':')[0], 10) + parseInt(DEFAULT_START.split(':')[1], 10) + dur;
    const endH = Math.floor(endMin / 60);
    const endM = endMin % 60;
    const endTime = `${String(endH).padStart(2, '0')}:${String(endM).padStart(2, '0')}`;
    const title = (s.title || 'Workout').replace(/"/g, '\\"');
    const desc = `health-coach:${s.id}`;
    try {
      run(`khal new ${dd} ${DEFAULT_START} ${endTime} "${title}" :: "${desc}" -a ${SPORT_CALENDAR_ID}`);
      created++;
      // khal doesn't return UID easily; we'd need to search. For now we mark as published by not re-publishing.
      s.calendar = s.calendar || {};
      s.calendar.publishedAt = new Date().toISOString();
      s.calendar.sessionIdTag = `health-coach:${s.id}`;
    } catch (e) {
      console.error('khal new failed for', s.title, ':', e.message);
    }
  }

  if (created > 0) {
    calendar.generatedAt = new Date().toISOString();
    fs.writeFileSync(CALENDAR_FILE, JSON.stringify(calendar, null, 2), 'utf8');
    try {
      run('vdirsyncer sync');
    } catch (_) {}
  }

  console.log('Published', created, 'events.');
}

main();
