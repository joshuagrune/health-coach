/**
 * Unified goal progress computation. Used by profile-builder, vitals-trend, sleep-trend.
 * No new scripts — extend existing ones. Supports: bodycomp (weight), sleep, vo2max, rhr, hrv.
 */

/** Metric config: direction 'up' = higher is better, 'down' = lower is better; or 'lose'/'gain' for weight */
const METRIC_CONFIG = {
  weight: { directionKey: 'direction', upVal: 'gain', downVal: 'lose', unit: 'kg' },
  sleep: { direction: 'up', unit: 'min' },
  vo2max: { direction: 'up', unit: null },
  rhr: { direction: 'down', unit: 'bpm' },
  hrv: { direction: 'up', unit: 'ms' },
};

/**
 * Extract goals that have numeric targets from intake.
 * @returns Array of { goal, metric, target, direction }
 */
function getGoalsWithTargets(goals) {
  const out = [];
  for (const g of goals || []) {
    if (g.targetWeightKg != null) {
      out.push({ goal: g, metric: 'weight', target: Number(g.targetWeightKg), direction: g.direction || null });
    }
    if (g.targetTotalMinutes != null) {
      out.push({ goal: g, metric: 'sleep', target: Number(g.targetTotalMinutes), direction: 'up' });
    }
    if (g.targetVo2max != null) {
      out.push({ goal: g, metric: 'vo2max', target: Number(g.targetVo2max), direction: 'up' });
    }
    if (g.targetRhr != null) {
      out.push({ goal: g, metric: 'rhr', target: Number(g.targetRhr), direction: 'down' });
    }
    if (g.targetHrv != null) {
      out.push({ goal: g, metric: 'hrv', target: Number(g.targetHrv), direction: 'up' });
    }
  }
  return out;
}

/**
 * Compute trendInRightDirection: true = moving toward goal, false = opposite, null = unknown.
 */
function isTrendGood(direction, trend, metric) {
  if (trend == null) return null;
  const cfg = METRIC_CONFIG[metric];
  let higherBetter = true;
  if (cfg.direction === 'down') higherBetter = false;
  else if (cfg.directionKey === 'direction' && direction) {
    higherBetter = direction === 'gain';
  }
  if (higherBetter) return trend > 0;
  return trend < 0;
}

/**
 * Build goalProgress array for profile. Uses profile.vitals, profile.sleep, profile.vitals.weightTrendKg.
 */
function computeFromProfile(goals, profile) {
  const items = [];
  const vitals = profile?.vitals || {};
  const sleep = profile?.sleep || {};

  for (const { goal, metric, target, direction } of getGoalsWithTargets(goals)) {
    let current = null;
    let trend = null;

    if (metric === 'weight') {
      current = vitals.weightKg ?? null;
      trend = vitals.weightTrendKg ?? null;
      const dir = direction || (current != null ? (current > target ? 'lose' : 'gain') : null);
      items.push({
        goalId: goal.id,
        kind: goal.kind,
        metric,
        target,
        current,
        trend,
        trendInRightDirection: isTrendGood(dir, trend, metric),
        unit: 'kg',
      });
    } else if (metric === 'sleep') {
      current = sleep.avgTotalMinutes ?? null;
      items.push({
        goalId: goal.id,
        kind: goal.kind,
        metric,
        target,
        current,
        trend: null,
        trendInRightDirection: current != null && current >= target * 0.95 ? true : null,
        unit: 'min',
      });
    } else if (metric === 'vo2max') {
      current = vitals.vo2max ?? vitals.vo2Max ?? null;
      items.push({
        goalId: goal.id,
        kind: goal.kind,
        metric,
        target,
        current,
        trend: null,
        trendInRightDirection: null,
        unit: null,
      });
    } else if (metric === 'rhr' || metric === 'hrv') {
      current = metric === 'rhr' ? (vitals.restingHeartRateBpm ?? vitals.resting_heart_rate ?? null) : (vitals.hrvMs ?? vitals.hrv ?? null);
      items.push({
        goalId: goal.id,
        kind: goal.kind,
        metric,
        target,
        current,
        trend: null,
        trendInRightDirection: null,
        unit: metric === 'rhr' ? 'bpm' : 'ms',
      });
    }
  }
  return items;
}

/**
 * Compute progress from vitals byPeriod (used by vitals-trend.js).
 * byPeriod: [{ period, lastWeight, lastVo2, avgRhr, avgHrv }, ...]
 */
function computeFromVitalsByPeriod(goalsWithTargets, byPeriod) {
  const items = [];
  if (!byPeriod || byPeriod.length < 1) return items;
  const last = byPeriod[byPeriod.length - 1];
  const prev = byPeriod.length >= 2 ? byPeriod[byPeriod.length - 2] : null;

  for (const { goal, metric, target, direction } of goalsWithTargets) {
    if (!['weight', 'vo2max', 'rhr', 'hrv'].includes(metric)) continue;
    let current = null;
    let trend = null;
    if (metric === 'weight') {
      current = last.lastWeight ?? null;
      trend = prev && last.lastWeight != null && prev.lastWeight != null
        ? Math.round((last.lastWeight - prev.lastWeight) * 10) / 10 : null;
      const dir = direction || (current != null ? (current > target ? 'lose' : 'gain') : null);
      items.push({
        goalId: goal.id,
        kind: goal.kind,
        metric,
        target,
        current,
        trend,
        trendInRightDirection: isTrendGood(dir, trend, metric),
        unit: 'kg',
      });
      continue;
    } else if (metric === 'vo2max') {
      current = last.lastVo2 ?? null;
      trend = prev && last.lastVo2 != null && prev.lastVo2 != null
        ? Math.round((last.lastVo2 - prev.lastVo2) * 10) / 10 : null;
    } else if (metric === 'rhr') {
      current = last.avgRhr ?? null;
      trend = prev && last.avgRhr != null && prev.avgRhr != null
        ? Math.round((last.avgRhr - prev.avgRhr) * 10) / 10 : null;
    } else if (metric === 'hrv') {
      current = last.avgHrv ?? null;
      trend = prev && last.avgHrv != null && prev.avgHrv != null
        ? Math.round((last.avgHrv - prev.avgHrv) * 10) / 10 : null;
    }
    const dir = metric === 'rhr' ? 'down' : 'up';
    items.push({
      goalId: goal.id,
      kind: goal.kind,
      metric,
      target,
      current,
      trend,
      trendInRightDirection: isTrendGood(dir, trend, metric),
      unit: metric === 'rhr' ? 'bpm' : (metric === 'hrv' ? 'ms' : null),
    });
  }
  return items;
}

/**
 * Compute progress from sleep byPeriod (used by sleep-trend.js).
 * byPeriod: [{ period, avgTotal, ... }, ...]
 */
function computeFromSleepByPeriod(goalsWithTargets, byPeriod) {
  const items = [];
  if (!byPeriod || byPeriod.length < 1) return items;
  const last = byPeriod[byPeriod.length - 1];
  const prev = byPeriod.length >= 2 ? byPeriod[byPeriod.length - 2] : null;
  const avgTotal = last.avgTotal ?? last.avgTotalMinutes ?? null;

  for (const { goal, metric, target } of goalsWithTargets) {
    if (metric !== 'sleep') continue;
    const current = avgTotal;
    const prevAvg = prev ? (prev.avgTotal ?? prev.avgTotalMinutes) : null;
    const trend = prevAvg != null && current != null
      ? Math.round(current - prevAvg) : null;
    items.push({
      goalId: goal.id,
      kind: goal.kind,
      metric,
      target,
      current,
      trend,
      trendInRightDirection: trend != null ? trend > 0 : (current != null && current >= target * 0.95),
      unit: 'min',
    });
  }
  return items;
}

/**
 * Format a single goal progress line for console output.
 */
function formatProgressLine(p) {
  if (p.metric === 'weight') {
    const current = p.current != null ? `${p.current}kg` : '—';
    const trend = p.trend != null ? `, ${p.trend > 0 ? '+' : ''}${p.trend}kg` : '';
    const ok = p.trendInRightDirection === true ? ' ✓' : p.trendInRightDirection === false ? ' (consider adjusting)' : '';
    return `${p.kind}: ${current} → ${p.target}kg target${trend}${ok}`;
  }
  if (p.metric === 'sleep') {
    const fmt = (m) => m != null ? `${Math.floor(m / 60)}h ${Math.round(m % 60)}m` : '—';
    const trend = p.trend != null ? `, ${p.trend > 0 ? '+' : ''}${p.trend}min` : '';
    const ok = p.trendInRightDirection === true ? ' ✓' : '';
    return `${p.kind}: ${fmt(p.current)} → ${fmt(p.target)} target${trend}${ok}`;
  }
  if (p.metric === 'vo2max') {
    const current = p.current != null ? `${p.current}` : '—';
    return `${p.kind}: ${current} → ${p.target} VO2max`;
  }
  if (p.metric === 'rhr') {
    const current = p.current != null ? `${p.current} bpm` : '—';
    return `${p.kind}: ${current} → ${p.target} bpm target`;
  }
  if (p.metric === 'hrv') {
    const current = p.current != null ? `${p.current} ms` : '—';
    return `${p.kind}: ${current} → ${p.target} ms target`;
  }
  return `${p.kind}: ${p.current} → ${p.target}`;
}

module.exports = {
  getGoalsWithTargets,
  isTrendGood,
  computeFromProfile,
  computeFromVitalsByPeriod,
  computeFromSleepByPeriod,
  formatProgressLine,
  METRIC_CONFIG,
};
