#!/usr/bin/env node
/**
 * Scenario tests: run plan-generator with different intake configs.
 * Uses temp workspace. Run: node scripts/run-scenario-tests.js
 */

const { execFileSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const os = require('os');

const SKILL_DIR = path.join(__dirname, '..', '..');
const TEMP_BASE = path.join(os.tmpdir(), 'health-coach-scenarios');

function run(env = {}) {
  return execFileSync(process.execPath, ['scripts/plan/plan-generator.js'], {
    encoding: 'utf8',
    env: { ...process.env, OPENCLAW_WORKSPACE: TEMP_BASE, ...env },
    cwd: SKILL_DIR,
  });
}

function setupWorkspace(name) {
  const ws = path.join(TEMP_BASE, name);
  fs.mkdirSync(path.join(ws, 'health', 'coach'), { recursive: true });
  return ws;
}

function writeIntake(ws, intake) {
  fs.writeFileSync(
    path.join(ws, 'health', 'coach', 'intake.json'),
    JSON.stringify(intake, null, 2),
    'utf8'
  );
}

const scenarios = [
  {
    name: 'endurance-only',
    intake: {
      version: 3,
      goals: [{ id: 'm1', kind: 'endurance', subKind: 'marathon', dateLocal: '2026-10-11', priority: 'finish' }],
      milestones: [{ id: 'm1', kind: 'marathon', dateLocal: '2026-10-11', priority: 'finish' }],
      constraints: { daysAvailable: ['mo', 'tu', 'th', 'fr', 'sa'], preferredRestDays: ['wed', 'sun'], maxMinutesPerDay: 90 },
      baseline: { runningFrequencyPerWeek: 2, longestRecentRunMinutes: 60, strengthFrequencyPerWeek: 1 },
    },
  },
  {
    name: 'strength-only',
    intake: {
      version: 3,
      goals: [{ id: 's1', kind: 'strength', priority: 'moderate' }],
      milestones: [],
      constraints: { daysAvailable: ['mo', 'wed', 'fr'], preferredRestDays: ['sun'], maxMinutesPerDay: 90 },
      baseline: { strengthFrequencyPerWeek: 3, strengthSplitPreference: 'upper_lower' },
    },
  },
  {
    name: 'endurance-plus-strength',
    intake: {
      version: 3,
      goals: [
        { id: 'm1', kind: 'endurance', subKind: 'half', dateLocal: '2026-05-15', priority: 'finish' },
        { id: 's1', kind: 'strength', priority: 'moderate' },
      ],
      milestones: [],
      constraints: { daysAvailable: ['mo', 'tu', 'th', 'fr', 'sa'], preferredRestDays: ['wed', 'sun'], maxSessionsPerWeek: 5 },
      baseline: { runningFrequencyPerWeek: 3, strengthFrequencyPerWeek: 2, strengthSplitPreference: 'full_body' },
    },
  },
  {
    name: 'fixed-appointments',
    intake: {
      version: 3,
      goals: [{ id: 's1', kind: 'strength', priority: 'moderate' }],
      milestones: [],
      constraints: {
        daysAvailable: ['mo', 'tu', 'wed', 'th', 'fr', 'sa'],
        preferredRestDays: ['sun'],
        fixedAppointments: [
          { id: 'vb1', name: 'Volleyball', dayOfWeek: 'wed', startTime: '18:00', durationMinutes: 90, frequency: 'weekly', seasonStart: '2026-03-01', seasonEnd: '2026-10-31' },
        ],
      },
      baseline: { strengthFrequencyPerWeek: 2 },
    },
  },
];

function assertScenario(name, sessions) {
  const enduranceKinds = new Set(['LR', 'Tempo', 'Intervals', 'Z2', 'Cycling', 'Swim', 'Bike', 'Brick']);
  if (name === 'strength-only') {
    const strengthCount = sessions.filter((s) => s.kind === 'Strength').length;
    const enduranceCount = sessions.filter((s) => enduranceKinds.has(s.kind)).length;
    if (strengthCount === 0) return 'strength-only: expected at least one Strength session';
    if (enduranceCount !== 0) return `strength-only: expected zero endurance sessions, got ${enduranceCount}`;
    if (!sessions.every((s) => s.modality === 'strength')) return 'strength-only: expected all modalities to be "strength"';
  }

  if (name === 'endurance-only') {
    if (!sessions.every((s) => s.modality === 'endurance')) return 'endurance-only: expected all modalities to be "endurance"';
  }

  if (name === 'endurance-plus-strength') {
    const hasStrength = sessions.some((s) => s.kind === 'Strength');
    const hasEndurance = sessions.some((s) => enduranceKinds.has(s.kind));
    if (!hasStrength || !hasEndurance) return 'hybrid: expected both strength and endurance sessions';
    const byDate = {};
    for (const s of sessions) {
      if (!byDate[s.localDate]) byDate[s.localDate] = new Set();
      byDate[s.localDate].add(s.modality);
    }
    const mixedDates = Object.values(byDate).filter((mods) => mods.size > 1).length;
    if (mixedDates > 0) return `hybrid: expected no mixed-modality dates, got ${mixedDates}`;
  }

  return null;
}

let passed = 0;
let failed = 0;

console.log('Health Coach Scenario Tests\n');

for (const sc of scenarios) {
  const ws = setupWorkspace(sc.name);
  writeIntake(ws, sc.intake);
  try {
    run({ OPENCLAW_WORKSPACE: ws });
    const cal = JSON.parse(fs.readFileSync(path.join(ws, 'health', 'coach', 'workout_calendar.json'), 'utf8'));
    const sessions = cal?.plan?.sessions || [];
    const assertionError = assertScenario(sc.name, sessions);
    if (sessions.length > 0 && !assertionError) {
      console.log('  OK:', sc.name, '-', sessions.length, 'sessions');
      passed++;
    } else {
      console.log('  FAIL:', sc.name, '-', assertionError || 'no sessions generated');
      failed++;
    }
  } catch (e) {
    console.log('  FAIL:', sc.name, '-', e.message.split('\n')[0]);
    failed++;
  }
}

console.log('\n---');
console.log('Passed:', passed, 'Failed:', failed);
process.exit(failed > 0 ? 1 : 0);
