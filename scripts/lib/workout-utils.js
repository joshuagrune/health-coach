/**
 * Shared workout type helpers.
 * Used by profile-builder, load-management, plan-generator.
 *
 * Evidence: load_management_and_injury_risk.md (RULE_RECOVERY_EXCLUDE, Implementation),
 * sources.md (SRC002 Foster sRPE, SRC004 Gabbett ACWR, SRC005 Hulin, SRC009 Zouhal).
 */

function isActiveRecoveryType(type) {
  const t = (type || '').toLowerCase();
  return /flexibility|mobility|yoga|stretch|recovery/i.test(t);
}

/**
 * Whether to exclude this workout from load (e.g. yoga, mobility).
 * Active recovery types are excluded only if intensity was low (effort/HR).
 * Intense yoga (Power, Hot) still counts.
 * @see load_management_and_injury_risk.md RULE_RECOVERY_EXCLUDE
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
 * Priority: 1) HR zones (Edwards-style Z1=1..Z5=5), 2) effort_score (sRPE Foster SRC002),
 * 3) classification, 4) duration only.
 * @param {object} w - Workout with duration_seconds, heart_rate_zones, effort_score, classification
 * @returns {number} Load in arbitrary units (comparable across workouts)
 * @see load_management_and_injury_risk.md Implementation
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

/**
 * Compute Acute:Chronic Workload Ratio (ACWR) from raw workout history.
 * Acute = intensity-weighted load over last 7 days with recorded data.
 * Chronic = intensity-weighted load over last 28 days / 4 (rolling avg).
 * Returns null when fewer than 7 days of data are available.
 *
 * Thresholds: <0.8 detraining | 0.8–1.3 safe | 1.3–1.5 elevated | >1.5 high risk.
 * Deload trigger at 1.3: Gabbett 2016 [SRC004], Hulin [SRC005]; Zouhal 2021 [SRC009] caveats.
 *
 * @param {object[]} workouts - Raw workout array with localDate/date fields
 * @param {string} todayStr - ISO date string 'YYYY-MM-DD'
 * @returns {number|null} ratio rounded to 2 decimals, or null if insufficient data
 */
function computeACWR(workouts, todayStr) {
  const byDate = {};
  for (const w of workouts) {
    if (shouldExcludeFromLoad(w)) continue;
    const d = w.localDate || w.date;
    if (!d || d > todayStr) continue;
    const load = computeWorkoutLoad(w);
    byDate[d] = (byDate[d] || 0) + load;
  }

  // Build calendar-based windows (rest days = 0) so that recovery days
  // actually reduce acute load — matches Gabbett 2016 methodology.
  const calendarDay = (offsetFromToday) => {
    const d = new Date(todayStr + 'T12:00:00');
    d.setDate(d.getDate() + offsetFromToday);
    return d.toISOString().slice(0, 10);
  };

  const acuteDays = Array.from({ length: 7 }, (_, i) => calendarDay(-(6 - i)));
  const chronicDays = Array.from({ length: 28 }, (_, i) => calendarDay(-(27 - i)));

  // Need at least some training data in the chronic window to be meaningful.
  const hasData = chronicDays.some((d) => byDate[d] != null);
  if (!hasData) return null;

  const acuteLoad = acuteDays.reduce((a, d) => a + (byDate[d] || 0), 0);
  const chronicLoad = chronicDays.reduce((a, d) => a + (byDate[d] || 0), 0) / 4;

  return chronicLoad > 0 ? Math.round((acuteLoad / chronicLoad) * 100) / 100 : null;
}

/**
 * Classify a workout type string as endurance, strength, or other.
 * Mirrors the logic in profile-builder.js so all scripts use a single source of truth.
 * @param {string} type - workout_type string
 * @returns {'endurance'|'strength'|'other'}
 */
function workoutModalityClass(type) {
  const t = (type || '').toLowerCase();
  if (/run|zone|walking|cycling|cardio|jog|swim|rowing|elliptical|stair|hike/i.test(t) && !/strength|full body|gym|flexibility/i.test(t)) return 'endurance';
  if (/strength|full body|gym|hypertrophy|pilates|barre|core|crossfit|functional/i.test(t)) return 'strength';
  return 'other';
}

module.exports = { isActiveRecoveryType, shouldExcludeFromLoad, computeWorkoutLoad, computeACWR, workoutModalityClass };
