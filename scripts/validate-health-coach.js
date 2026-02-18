#!/usr/bin/env node
/**
 * Validation suite for Health Coach: timezone, matching, guardrails, intake v2.
 * Run: node scripts/validate-health-coach.js
 */

const fs = require('fs');
const path = require('path');

const WORKSPACE = process.env.OPENCLAW_WORKSPACE || path.join(process.env.HOME || '/root', '.openclaw/workspace');
const COACH_ROOT = path.join(WORKSPACE, 'health', 'coach');
const TZ = 'Europe/Berlin';

function loadJson(p) {
  try {
    return JSON.parse(fs.readFileSync(p, 'utf8'));
  } catch {
    return null;
  }
}

function toLocalDate(isoUtc) {
  const d = new Date(isoUtc);
  return d.toLocaleDateString('en-CA', { timeZone: TZ });
}

let passed = 0;
let failed = 0;

function ok(name) {
  console.log('  OK:', name);
  passed++;
}

function fail(name, msg) {
  console.log('  FAIL:', name, '-', msg);
  failed++;
}

// Timezone: DST transition 2026-03-29 (CET→CEST)
function testTimezone() {
  console.log('\n## Timezone');
  const before = '2026-03-29T00:30:00.000Z'; // 01:30 CET
  const after = '2026-03-29T01:30:00.000Z';  // 03:30 CEST
  const d1 = toLocalDate(before);
  const d2 = toLocalDate(after);
  if (d1 === '2026-03-29' && d2 === '2026-03-29') ok('DST transition same-day bucketing');
  else fail('DST transition', `got ${d1}, ${d2}`);
}

// Guardrails: no back-to-back hard (LR, Tempo, Intervals, Strength)
function testGuardrails() {
  console.log('\n## Plan Guardrails');
  const calPath = path.join(COACH_ROOT, 'workout_calendar.json');
  if (!fs.existsSync(calPath)) {
    ok('skip guardrails (no calendar yet)');
    return;
  }
  const cal = loadJson(calPath);
  const sessions = cal?.plan?.sessions || [];
  if (sessions.length === 0) {
    ok('skip guardrails (empty plan)');
    return;
  }
  const hard = ['LR', 'Tempo', 'Intervals', 'Strength'];
  const byDate = {};
  for (const s of sessions) {
    if (!byDate[s.localDate]) byDate[s.localDate] = [];
    byDate[s.localDate].push(s);
  }
  const dates = Object.keys(byDate).sort();
  let backToBack = 0;
  for (let i = 1; i < dates.length; i++) {
    const prev = byDate[dates[i - 1]];
    const curr = byDate[dates[i]];
    const prevHard = prev.some((s) => hard.includes(s.kind));
    const currHard = curr.some((s) => hard.includes(s.kind));
    const dayDiff = (new Date(dates[i]) - new Date(dates[i - 1])) / (24 * 60 * 60 * 1000);
    if (prevHard && currHard && dayDiff === 1) backToBack++;
  }
  if (backToBack === 0) ok('no back-to-back hard days');
  else fail('back-to-back hard', `${backToBack} violations`);
}

// Matching: planned kind vs workout type (includes Strength)
function testMatching() {
  console.log('\n## Matching');
  const kindMap = {
    LR: ['Running', 'Zone 2', 'Walking'],
    Z2: ['Running', 'Zone 2', 'Walking', 'Cycling'],
    Strength: ['Strength Training', 'Full Body', 'Full Body A', 'Full Body B', 'Flexibility', 'Climbing', 'Gym'],
  };
  const match = (p, w) => {
    const types = kindMap[p] || [p];
    const wt = (w.workout_type || w.workoutType || w.type || '').toLowerCase();
    return types.some((t) => wt.includes(t.toLowerCase()));
  };
  if (match('LR', { workout_type: 'Running' })) ok('LR matches Running');
  else fail('LR match', 'expected true');
  if (match('Z2', { workout_type: 'Zone 2' })) ok('Z2 matches Zone 2');
  else fail('Z2 match', 'expected true');
  if (match('Strength', { workout_type: 'Full Body' })) ok('Strength matches Full Body');
  else fail('Strength match', 'expected true');
  if (!match('LR', { workout_type: 'Strength Training' })) ok('LR does not match Strength');
  else fail('LR mismatch', 'expected false');
}

// Intake v2: goals[] and baseline.strengthFrequencyPerWeek
function testIntakeV2() {
  console.log('\n## Intake Schema');
  const intakePath = path.join(COACH_ROOT, 'intake.json');
  if (!fs.existsSync(intakePath)) {
    ok('skip intake v2 (no intake yet)');
    return;
  }
  const intake = loadJson(intakePath);
  if (!intake) {
    fail('intake load', 'could not parse');
    return;
  }
  const hasGoals = Array.isArray(intake.goals);
  const hasMilestones = Array.isArray(intake.milestones);
  const hasBaseline = intake.baseline && typeof intake.baseline === 'object';
  if (hasGoals || hasMilestones) ok('intake has goals or milestones');
  else fail('intake', 'missing goals/milestones');
  if (hasBaseline) ok('intake has baseline');
  else fail('intake', 'missing baseline');
}

function main() {
  console.log('Health Coach Validation');
  testTimezone();
  testGuardrails();
  testMatching();
  testIntakeV2();
  console.log('\n---');
  console.log('Passed:', passed, 'Failed:', failed);
  process.exit(failed > 0 ? 1 : 0);
}

main();
