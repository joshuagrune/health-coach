/**
 * Shared I/O for Salvor cache and JSON files.
 * Used by plan/, analysis/, sync scripts.
 */

const fs = require('fs');
const path = require('path');

const TZ = 'Europe/Berlin';

function getWorkspace() {
  return process.env.OPENCLAW_WORKSPACE || path.join(process.env.HOME || '/root', '.openclaw/workspace');
}

function getCoachRoot() {
  return path.join(getWorkspace(), 'health', 'coach');
}

function getCacheDir() {
  return path.join(getCoachRoot(), 'salvor_cache');
}

function loadJson(filePath, fallback = null) {
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch {
    return fallback;
  }
}

function loadJsonlFiles(prefix, cacheDir = null) {
  const dir = cacheDir || getCacheDir();
  const out = [];
  if (!fs.existsSync(dir)) return out;
  const files = fs.readdirSync(dir).filter((f) => f.startsWith(prefix) && f.endsWith('.jsonl'));
  for (const f of files.sort()) {
    const lines = fs.readFileSync(path.join(dir, f), 'utf8').trim().split('\n').filter(Boolean);
    for (const line of lines) {
      try {
        out.push(JSON.parse(line));
      } catch (_) {}
    }
  }
  return out;
}

function getRecent(records, days, tz = TZ) {
  const cutoff = new Date();
  cutoff.setDate(cutoff.getDate() - days);
  const cutoffStr = cutoff.toLocaleDateString('en-CA', { timeZone: tz });
  return records.filter((r) => (r.localDate || r.date) >= cutoffStr);
}

module.exports = {
  getWorkspace,
  getCoachRoot,
  getCacheDir,
  loadJson,
  loadJsonlFiles,
  getRecent,
  TZ,
};
