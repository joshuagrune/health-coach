#!/usr/bin/env node
/**
 * Pre-populate intake.json from health/goals.md (if intake.json missing).
 * Schema v2: goals[], broad baseline. Parses dates and goal keywords.
 * Always writes a complete template; goals.md enriches it when present.
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

/** Extract YYYY-MM-DD from text. Handles: 11.10.2026, 2026-10-11, Oct 11 2026, etc. */
function parseDate(raw) {
  // 2026-10-11 or 2026/10/11
  const iso = raw.match(/\b(20\d{2})[-/](\d{1,2})[-/](\d{1,2})\b/);
  if (iso) return `${iso[1]}-${iso[2].padStart(2, '0')}-${iso[3].padStart(2, '0')}`;
  // 11.10.2026 or 11/10/2026 (DD.MM.YYYY)
  const eu = raw.match(/\b(\d{1,2})[./](\d{1,2})[./](20\d{2})\b/);
  if (eu) return `${eu[3]}-${eu[2].padStart(2, '0')}-${eu[1].padStart(2, '0')}`;
  return null;
}

/** Default intake template (goal-agnostic) */
function defaultIntake() {
  return {
    goals: [],
    milestones: [], // legacy: endurance events
    constraints: {
      daysAvailable: ['mo', 'tu', 'th', 'fr', 'sa'],
      maxMinutesPerDay: 90,
      gymAccess: true,
      otherSports: [],
      preferredRestDays: ['wed', 'sun'],
    },
    baseline: {
      runningFrequencyPerWeek: 2,
      longestRecentRunMinutes: 60,
      strengthFrequencyPerWeek: 2,
      longestStrengthSessionMinutes: 60,
      injuryHistory: [],
      perceivedFitness: 'moderate',
      perceivedStrength: 'moderate',
    },
    intensityCalibration: {
      recentRaceTimeSeconds: null,
      thresholdPaceSecondsPerKm: null,
      fallbackZones: 'rpe',
    },
    preferences: { planStyle: 'minimal', language: 'en', notificationCadence: 'weekly' },
    safetyGates: {
      painStopRule: 'Stop and rest if pain > 4/10 or persists next day',
      illnessRule: 'If fever or flu: no training until 48h symptom-free',
    },
  };
}

function parseGoals() {
  const intake = defaultIntake();
  if (!fs.existsSync(GOALS_PATH)) return intake;

  const raw = fs.readFileSync(GOALS_PATH, 'utf8');
  const dayMap = { Mo: 'mo', Di: 'tu', Mi: 'wed', Do: 'th', Fr: 'fr', Sa: 'sa', So: 'sun' };

  // Parse endurance events (marathon, half, 10k)
  const marathonDate = parseDate(raw) || (raw.includes('Marathon') && raw.includes('2026') ? '2026-12-31' : null);
  if (marathonDate && (raw.includes('Marathon') || raw.includes('marathon'))) {
    const goal = {
      id: 'marathon_2026',
      kind: 'endurance',
      subKind: 'marathon',
      dateLocal: marathonDate,
      priority: raw.includes('Sub-4') || raw.includes('sub-4') || raw.includes('unter 4') ? 'target_time' : 'finish',
      targetTimeSeconds: raw.includes('Sub-4') || raw.includes('14400') ? 14400 : null,
    };
    intake.goals.push(goal);
    intake.milestones.push({ id: goal.id, kind: 'marathon', dateLocal: goal.dateLocal, priority: goal.priority, targetTimeSeconds: goal.targetTimeSeconds });
  }

  // Parse other goal keywords
  if (/strength|kraft|gym|hypertrophy|full body/i.test(raw) && !intake.goals.some((g) => g.kind === 'strength')) {
    intake.goals.push({ id: 'strength_1', kind: 'strength', priority: 'moderate' });
  }
  if (/körperfett|bodycomp|gewicht|lean|fat loss/i.test(raw) && !intake.goals.some((g) => g.kind === 'bodycomp')) {
    intake.goals.push({ id: 'bodycomp_1', kind: 'bodycomp', priority: 'moderate' });
  }
  if (/schlaf|sleep|rem|deep sleep/i.test(raw) && !intake.goals.some((g) => g.kind === 'sleep')) {
    intake.goals.push({ id: 'sleep_1', kind: 'sleep', priority: 'moderate' });
  }
  if (/fitness|gesund|general/i.test(raw) && intake.goals.length === 0) {
    intake.goals.push({ id: 'general_1', kind: 'general', priority: 'moderate' });
  }

  // Weekly schedule from table
  const restDays = [];
  const availDays = [];
  for (const [label, key] of Object.entries(dayMap)) {
    if (raw.includes(`${label} | Rest`) || raw.includes(`${label}|Rest`)) restDays.push(key);
    else if (raw.includes(label)) availDays.push(key);
  }
  if (availDays.length) intake.constraints.daysAvailable = availDays;
  if (restDays.length) intake.constraints.preferredRestDays = restDays;
  if (raw.includes('Volleyball')) intake.constraints.otherSports = ['volleyball'];

  return intake;
}

function main() {
  ensureDir(COACH_ROOT);
  let payload;
  if (fs.existsSync(INTAKE_FILE)) {
    const existing = JSON.parse(fs.readFileSync(INTAKE_FILE, 'utf8'));
    const hasGoals = (existing.goals?.length ?? 0) > 0 || (existing.milestones?.length ?? 0) > 0;
    if (hasGoals) {
      console.log('intake.json already has goals, skipping');
      return;
    }
    if (!fs.existsSync(GOALS_PATH)) {
      console.log('intake.json exists, goals empty, no goals.md — skipping');
      return;
    }
    const parsed = parseGoals();
    payload = {
      ...existing,
      goals: parsed.goals,
      milestones: parsed.milestones,
      updatedAt: new Date().toISOString(),
    };
    console.log('Merged goals from goals.md into existing intake');
  } else {
    const data = parseGoals();
    payload = { version: 2, updatedAt: new Date().toISOString(), ...data };
  }
  fs.writeFileSync(INTAKE_FILE, JSON.stringify(payload, null, 2), 'utf8');
  console.log('Wrote', INTAKE_FILE);
}

main();
