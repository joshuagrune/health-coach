/**
 * Shared workout type helpers.
 * Used by profile-builder, load-management, plan-generator.
 */

function isActiveRecoveryType(type) {
  const t = (type || '').toLowerCase();
  return /flexibility|mobility|yoga|stretch|recovery/i.test(t);
}

/**
 * Whether to exclude this workout from load (e.g. yoga, mobility).
 * Active recovery types are excluded only if intensity was low (effort/HR).
 * Intense yoga (Power, Hot) still counts.
 */
function shouldExcludeFromLoad(w) {
  const type = w.workout_type || w.workoutType || w.type || '';
  if (!isActiveRecoveryType(type)) return false;

  const effort = w.effort_score ?? w.effortScore;
  if (effort != null && Number(effort) >= 5) return false; // RPE 5+ → count it

  const zones = w.heart_rate_zones ?? w.heartRateZones;
  if (zones && typeof zones === 'object') {
    const z3 = (zones.z3 ?? zones['3'] ?? zones.zone3 ?? 0) || 0;
    const z4 = (zones.z4 ?? zones['4'] ?? zones.zone4 ?? 0) || 0;
    const z5 = (zones.z5 ?? zones['5'] ?? zones.zone5 ?? 0) || 0;
    if (z3 + z4 + z5 > 5) return false; // >5 min in Z3+ → count it
  }

  const avgHR = w.avg_heart_rate ?? w.avgHeartRate ?? w.average_heart_rate;
  const maxHR = w.max_heart_rate ?? w.maxHeartRate;
  if (avgHR != null && maxHR != null && maxHR > 0 && avgHR / maxHR > 0.7) return false; // >70% maxHR → count it

  return true; // low-intensity active recovery → exclude
}

/**
 * Compute intensity-weighted load for a workout (TRIMP/sRPE-style).
 * Priority: 1) HR zones (Edwards), 2) effort_score (sRPE), 3) classification, 4) duration only.
 * @param {object} w - Workout with duration_seconds, heart_rate_zones, effort_score, classification, avg_heart_rate
 * @returns {number} Load in arbitrary units (comparable across workouts)
 */
function computeWorkoutLoad(w) {
  const dur = (w.duration_seconds ?? w.durationSeconds ?? w.duration ?? 0) / 60;

  // 1) HR zones (Edwards TRIMP-style: Z1=1, Z2=2, Z3=3, Z4=4, Z5=5)
  const zones = w.heart_rate_zones ?? w.heartRateZones;
  if (zones && typeof zones === 'object') {
    const z1 = (zones.z1 ?? zones['1'] ?? zones.zone1 ?? 0) || 0;
    const z2 = (zones.z2 ?? zones['2'] ?? zones.zone2 ?? 0) || 0;
    const z3 = (zones.z3 ?? zones['3'] ?? zones.zone3 ?? 0) || 0;
    const z4 = (zones.z4 ?? zones['4'] ?? zones.zone4 ?? 0) || 0;
    const z5 = (zones.z5 ?? zones['5'] ?? zones.zone5 ?? 0) || 0;
    const total = z1 + z2 + z3 + z4 + z5;
    if (total > 0) {
      return z1 * 1 + z2 * 2 + z3 * 3 + z4 * 4 + z5 * 5;
    }
  }

  // 2) effort_score (sRPE: RPE × duration)
  const effort = w.effort_score ?? w.effortScore;
  if (effort != null && Number(effort) >= 1 && Number(effort) <= 10) {
    return Number(effort) * dur;
  }

  // 3) classification as intensity multiplier
  const cls = (w.classification || '').toLowerCase();
  const mult = { recovery: 0.5, zone2: 1, zone1: 0.7, mixed: 1.3, zone3: 1.5, tempo: 2, intervals: 2.5, zone4: 2, zone5: 2.5 }[cls];
  if (mult != null) return dur * mult;

  // 4) Fallback: duration only (1×)
  return dur;
}

module.exports = { isActiveRecoveryType, shouldExcludeFromLoad, computeWorkoutLoad };
