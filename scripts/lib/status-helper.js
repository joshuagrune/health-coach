/**
 * Shared helper to load and interpret status.json.
 * Used by calendar-publish, adaptive-replanner, plan-generator.
 */

const fs = require('fs');
const path = require('path');

const WORKSPACE = process.env.OPENCLAW_WORKSPACE || path.join(process.env.HOME || '/root', '.openclaw/workspace');
const COACH_ROOT = path.join(WORKSPACE, 'health', 'coach');
const STATUS_FILE = path.join(COACH_ROOT, 'status.json');

function loadStatus() {
  try {
    const data = JSON.parse(fs.readFileSync(STATUS_FILE, 'utf8'));
    if (data.status === 'healthy' || !data.status) return null;
    return data;
  } catch {
    return null;
  }
}

/** Returns true if dateStr (YYYY-MM-DD) falls within an active illness/travel block. */
function isDateInStatusBlock(dateStr, status = null) {
  const s = status || loadStatus();
  if (!s || !s.since || !s.until) return false;
  if (s.status !== 'illness' && s.status !== 'travel') return false;
  return dateStr >= s.since && dateStr <= s.until;
}

/** Returns status object or null. */
function getStatus() {
  return loadStatus();
}

module.exports = { loadStatus, isDateInStatusBlock, getStatus };
