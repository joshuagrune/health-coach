#!/usr/bin/env node
/**
 * Pre-populate intake.json from health/goals.md (if intake.json missing).
 * Parses goals.md for marathon date, weekly schedule, etc. Agent can refine via Q&A.
 */

const fs = require('fs');
const path = require('path');

const WORKSPACE = process.env.OPENCLAW_WORKSPACE || path.join(process.env.HOME || '/root', '.openclaw/workspace');
const GOALS_PATH = path.join(WORKSPACE, 'health', 'goals.md');
const COACH_ROOT = path.join(WORKSPACE, 'health', 'coach');
const INTAKE_FILE = path.join(COACH_ROOT, 'intake.json');

function ensureDir(dir) {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

function parseGoals() {
  if (!fs.existsSync(GOALS_PATH)) return null;
  const raw = fs.readFileSync(GOALS_PATH, 'utf8');
  const intake = {
    milestones: [],
    constraints: { daysAvailable: [], maxMinutesPerDay: 90, gymAccess: true, otherSports: [], preferredRestDays: [] },
    baseline: { runningFrequencyPerWeek: 2, longestRecentRunMinutes: 60, injuryHistory: [], perceivedFitness: 'moderate' },
    intensityCalibration: { recentRaceTimeSeconds: null, thresholdPaceSecondsPerKm: null, fallbackZones: 'rpe' },
    preferences: { planStyle: 'minimal', language: 'de', notificationCadence: 'weekly' },
    safetyGates: { painStopRule: 'Stop and rest if pain > 4/10 or persists next day', illnessRule: 'If fever or flu: no training until 48h symptom-free' },
  };

  // Marathon 2026
  if (raw.includes('Marathon') && raw.includes('2026')) {
    intake.milestones.push({ id: 'marathon_2026', kind: 'marathon', dateLocal: '2026-12-31', priority: 'finish', targetTimeSeconds: null });
  }

  // Weekly schedule from table: Mo Volleyball, Di Full Body, Mi Rest, Do Zone 2, Fr Intervals, Sa Full Body, So Rest
  const dayMap = { Mo: 'mo', Di: 'tu', Mi: 'wed', Do: 'th', Fr: 'fr', Sa: 'sa', So: 'sun' };
  const restDays = [];
  const availDays = [];
  for (const [label, key] of Object.entries(dayMap)) {
    if (raw.includes(`${label} | Rest`)) restDays.push(key);
    else if (raw.includes(label)) availDays.push(key);
  }
  intake.constraints.daysAvailable = availDays.length ? availDays : ['mo', 'tu', 'th', 'fr', 'sa'];
  intake.constraints.preferredRestDays = restDays.length ? restDays : ['wed', 'sun'];
  if (raw.includes('Volleyball')) intake.constraints.otherSports = ['volleyball'];

  return intake;
}

function main() {
  if (fs.existsSync(INTAKE_FILE)) {
    console.log('intake.json already exists, skipping');
    return;
  }
  const data = parseGoals();
  if (!data) {
    console.log('No goals.md or could not parse, creating minimal template');
  }
  ensureDir(COACH_ROOT);
  const payload = { version: 1, updatedAt: new Date().toISOString(), ...(data || {}) };
  fs.writeFileSync(INTAKE_FILE, JSON.stringify(payload, null, 2), 'utf8');
  console.log('Wrote', INTAKE_FILE);
}

main();
