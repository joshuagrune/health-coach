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

/** Default intake template (goal-agnostic). No defaults for daysAvailable/preferredRestDays — Agent must ask. */
function defaultIntake() {
  return {
    goals: [],
    milestones: [], // legacy: endurance events
    constraints: {
      daysAvailable: [], // Must be set by Agent; plan-generator fails with clear error if empty
      preferredRestDays: [], // Rest days; daysAvailable - preferredRestDays = trainable slots
      maxMinutesPerDay: 90,
      gymAccess: true,
      otherSports: [],
      maxSessionsPerWeek: null, // Optional: cap sessions (e.g. 3) even if more days available
      fixedAppointments: [], // e.g. volleyball, frequency, season window
    },
    baseline: {
      runningFrequencyPerWeek: 2,
      longestRecentRunMinutes: 60,
      strengthFrequencyPerWeek: 2,
      longestStrengthSessionMinutes: 60,
      strengthSplitPreference: 'full_body', // full_body | upper_lower | push_pull_legs | bro_split
      injuryHistory: [],
      perceivedFitness: 'moderate',
      perceivedStrength: 'moderate',
      trainingHistoryByModality: {}, // e.g. { running: { sessionsLast4Weeks, totalMinutesLast4Weeks } }
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

  // Parse endurance events (marathon, half, 10k, 5k, cycling, triathlon)
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
  if (parseDate(raw) && (/half|halbmarathon|21k|21\.1/i.test(raw)) && !intake.goals.some((g) => g.subKind === 'half')) {
    const d = parseDate(raw);
    intake.goals.push({ id: 'half_1', kind: 'endurance', subKind: 'half', dateLocal: d, priority: 'finish' });
  }
  if (/10k|10\.?k/i.test(raw) && !intake.goals.some((g) => g.subKind === '10k')) {
    intake.goals.push({ id: '10k_1', kind: 'endurance', subKind: '10k', dateLocal: parseDate(raw) || '2026-12-31', priority: 'finish' });
  }
  if (/5k|5\.?k/i.test(raw) && !intake.goals.some((g) => g.subKind === '5k')) {
    intake.goals.push({ id: '5k_1', kind: 'endurance', subKind: '5k', dateLocal: parseDate(raw) || '2026-12-31', priority: 'finish' });
  }
  if (/cycling|rad|radfahren|triathlon|ironman|70\.3|olympic|sprint/i.test(raw) && !intake.goals.some((g) => g.kind === 'endurance' && (g.subKind === 'cycling' || g.subKind?.startsWith('triathlon')))) {
    if (/ironman|iron man|140\.6/i.test(raw)) {
      intake.goals.push({ id: 'tri_im_1', kind: 'endurance', subKind: 'triathlon_ironman', dateLocal: parseDate(raw) || '2026-12-31', priority: 'finish' });
    } else if (/70\.3|half iron|halbtri/i.test(raw)) {
      intake.goals.push({ id: 'tri_703_1', kind: 'endurance', subKind: 'triathlon_70.3', dateLocal: parseDate(raw) || '2026-12-31', priority: 'finish' });
    } else if (/olympic|olympisch/i.test(raw)) {
      intake.goals.push({ id: 'tri_oly_1', kind: 'endurance', subKind: 'triathlon_olympic', dateLocal: parseDate(raw) || '2026-12-31', priority: 'finish' });
    } else if (/sprint/i.test(raw)) {
      intake.goals.push({ id: 'tri_sprint_1', kind: 'endurance', subKind: 'triathlon_sprint', dateLocal: parseDate(raw) || '2026-12-31', priority: 'finish' });
    } else if (/cycling|rad|radfahren/i.test(raw)) {
      intake.goals.push({ id: 'cycling_1', kind: 'endurance', subKind: 'cycling', dateLocal: parseDate(raw) || '2026-12-31', priority: 'moderate' });
    }
  }

  // Parse other goal keywords
  if (/strength|kraft|gym|hypertrophy|full body|upper.?lower|push.?pull|ppl|bro.?split/i.test(raw) && !intake.goals.some((g) => g.kind === 'strength')) {
    let split = 'full_body';
    if (/upper.?lower|upper lower/i.test(raw)) split = 'upper_lower';
    else if (/push.?pull|ppl|push pull/i.test(raw)) split = 'push_pull_legs';
    else if (/bro.?split|bro split/i.test(raw)) split = 'bro_split';
    intake.goals.push({ id: 'strength_1', kind: 'strength', priority: 'moderate' });
    intake.baseline.strengthSplitPreference = split;
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
  if (raw.includes('Volleyball')) {
    intake.constraints.otherSports = ['volleyball'];
    intake.constraints.fixedAppointments = intake.constraints.fixedAppointments || [];
    if (!intake.constraints.fixedAppointments.some((fa) => fa.name && fa.name.toLowerCase().includes('volleyball'))) {
      intake.constraints.fixedAppointments.push({
        id: 'volleyball_1',
        name: 'Volleyball',
        dayOfWeek: 'wed',
        startTime: '18:00',
        durationMinutes: 90,
        frequency: 'weekly',
      });
    }
  }

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
    payload = { version: 3, updatedAt: new Date().toISOString(), ...data };
  }
  fs.writeFileSync(INTAKE_FILE, JSON.stringify(payload, null, 2), 'utf8');
  console.log('Wrote', INTAKE_FILE);
}

main();
