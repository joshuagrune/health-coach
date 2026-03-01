#!/usr/bin/env node
/**
 * Intake schema v3 validation. Used by intake-writer and plan-generator.
 * Validates required fields, goal-type-specific fields, fixed appointments consistency.
 */

const VALID_DAY_KEYS = ['mo', 'tu', 'we', 'wed', 'th', 'fr', 'sa', 'su', 'sun'];
const VALID_GOAL_KINDS = ['endurance', 'strength', 'bodycomp', 'sleep', 'vo2max', 'general'];
const VALID_ENDURANCE_SUBKINDS = ['marathon', 'half', '10k', '5k', 'cycling', 'triathlon_sprint', 'triathlon_olympic', 'triathlon_70.3', 'triathlon_ironman'];
const VALID_STRENGTH_SPLITS = ['full_body', 'upper_lower', 'push_pull_legs', 'bro_split'];
const VALID_BODYCOMP_DIRECTIONS = ['lose', 'gain'];

/**
 * Validate intake payload. Throws with clear message or exits(1) if invalid.
 * @param {object} payload - Intake object
 * @param {object} opts - { exitOnError: true } to process.exit(1) on failure
 * @returns {{ valid: boolean, errors: string[] }}
 */
function validateIntakeV3(payload, opts = {}) {
  const errors = [];

  if (!payload || typeof payload !== 'object') {
    errors.push('Intake payload is required and must be an object.');
    return finish(errors, opts);
  }

  const constraints = payload.constraints || {};
  const daysAvailable = constraints.daysAvailable || [];
  const fixedAppointments = constraints.fixedAppointments || [];
  const baseline = payload.baseline || {};
  const goals = payload.goals || [];
  const milestones = payload.milestones || [];

  // Required: daysAvailable non-empty
  if (!Array.isArray(daysAvailable) || daysAvailable.length === 0) {
    errors.push('daysAvailable is required and must be non-empty. Ask user: "Which days can you train?"');
  } else {
    const invalid = daysAvailable.filter((d) => !VALID_DAY_KEYS.includes(String(d).toLowerCase()));
    if (invalid.length) {
      errors.push(`Invalid day keys in daysAvailable: ${invalid.join(', ')}. Use: mo, tu, wed, th, fr, sa, sun`);
    }
  }

  // Goal-type-specific: endurance goals need dateLocal for race subKinds
  for (const g of goals) {
    if (g.kind === 'endurance' && g.subKind && VALID_ENDURANCE_SUBKINDS.includes(g.subKind)) {
      if (!g.dateLocal) {
        errors.push(`Endurance goal "${g.id || g.subKind}" requires dateLocal (YYYY-MM-DD) for race planning.`);
      }
    }
    if (g.kind && !VALID_GOAL_KINDS.includes(g.kind)) {
      errors.push(`Unknown goal kind: ${g.kind}. Valid: ${VALID_GOAL_KINDS.join(', ')}`);
    }
    if (g.kind === 'bodycomp') {
      if (g.targetWeightKg != null) {
        const n = Number(g.targetWeightKg);
        if (isNaN(n) || n < 35 || n > 250) {
          errors.push(`Bodycomp goal "${g.id || 'bodycomp'}" targetWeightKg must be 35–250.`);
        }
      }
      if (g.direction != null && !VALID_BODYCOMP_DIRECTIONS.includes(g.direction)) {
        errors.push(`Bodycomp goal "${g.id || 'bodycomp'}" direction must be "lose" or "gain".`);
      }
    }
    if (g.kind === 'sleep' && g.targetTotalMinutes != null) {
      const n = Number(g.targetTotalMinutes);
      if (isNaN(n) || n < 240 || n > 600) {
        errors.push(`Sleep goal "${g.id || 'sleep'}" targetTotalMinutes must be 240–600 (4–10h).`);
      }
    }
    if (g.kind === 'vo2max' && g.targetVo2max != null) {
      const n = Number(g.targetVo2max);
      if (isNaN(n) || n < 25 || n > 90) {
        errors.push(`VO2max goal "${g.id || 'vo2max'}" targetVo2max must be 25–90.`);
      }
    }
  }

  // Fixed appointments: dayOfWeek must be in daysAvailable or at least valid
  for (const fa of fixedAppointments) {
    if (!fa.id || !fa.name) {
      errors.push('Each fixedAppointment must have id and name.');
    }
    if (fa.dayOfWeek && !VALID_DAY_KEYS.includes(String(fa.dayOfWeek).toLowerCase())) {
      errors.push(`Invalid dayOfWeek in fixedAppointment "${fa.id}": ${fa.dayOfWeek}`);
    }
    if (fa.seasonStart && fa.seasonEnd) {
      const start = new Date(fa.seasonStart);
      const end = new Date(fa.seasonEnd);
      if (isNaN(start.getTime()) || isNaN(end.getTime())) {
        errors.push(`fixedAppointment "${fa.id}": seasonStart/seasonEnd must be valid dates (YYYY-MM-DD).`);
      }
      if (start > end) {
        errors.push(`fixedAppointment "${fa.id}": seasonStart must be before seasonEnd.`);
      }
    }
  }

  // strengthSplitPreference if present must be valid
  if (baseline.strengthSplitPreference && !VALID_STRENGTH_SPLITS.includes(baseline.strengthSplitPreference)) {
    errors.push(`Invalid strengthSplitPreference: ${baseline.strengthSplitPreference}. Valid: ${VALID_STRENGTH_SPLITS.join(', ')}`);
  }

  // perceivedFitness: used for Tempo-Gate, Hard-Cap (low, moderate, high, advanced)
  const VALID_FITNESS = ['low', 'moderate', 'high', 'advanced'];
  if (baseline.perceivedFitness != null && !VALID_FITNESS.includes(String(baseline.perceivedFitness).toLowerCase())) {
    errors.push(`Invalid perceivedFitness: ${baseline.perceivedFitness}. Valid: ${VALID_FITNESS.join(', ')}`);
  }

  // maxHardSessionsPerWeek: optional override (1–6)
  if (baseline.maxHardSessionsPerWeek != null) {
    const n = Number(baseline.maxHardSessionsPerWeek);
    if (isNaN(n) || n < 1 || n > 6) {
      errors.push('baseline.maxHardSessionsPerWeek must be between 1 and 6.');
    }
  }

  // allowTwoADays: optional boolean, allows strength + endurance on the same day
  if (constraints.allowTwoADays != null && typeof constraints.allowTwoADays !== 'boolean') {
    errors.push('constraints.allowTwoADays must be a boolean (true/false).');
  }

  // trainingStartDate: optional YYYY-MM-DD for marathon phase anchoring
  if (payload.trainingStartDate != null) {
    const d = new Date(payload.trainingStartDate + 'T12:00:00');
    if (isNaN(d.getTime())) {
      errors.push('trainingStartDate must be a valid date (YYYY-MM-DD).');
    }
  }

  // z2DurationMinutes: optional override for Zone 2 session length (20–120 min)
  if (baseline.z2DurationMinutes != null) {
    const n = Number(baseline.z2DurationMinutes);
    if (isNaN(n) || n < 20 || n > 120) {
      errors.push('baseline.z2DurationMinutes must be between 20 and 120 minutes.');
    }
  }

  // Inconsistent: fixed appointments on preferredRestDays is allowed but may reduce slots
  // No hard error; planner will handle.

  return finish(errors, opts);
}

function finish(errors, opts) {
  if (errors.length > 0) {
    if (opts.exitOnError) {
      console.error('INTAKE VALIDATION FAILED:');
      errors.forEach((e) => console.error('  -', e));
      process.exit(1);
    }
    return { valid: false, errors };
  }
  return { valid: true, errors: [] };
}

module.exports = { validateIntakeV3, VALID_DAY_KEYS, VALID_GOAL_KINDS, VALID_ENDURANCE_SUBKINDS, VALID_STRENGTH_SPLITS };
