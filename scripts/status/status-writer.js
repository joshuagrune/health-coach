#!/usr/bin/env node
/**
 * Set or clear current health/training status (illness, injury, travel, deload).
 * Used when user says "I'm sick", "Ich bin krank", "traveling next week", etc.
 *
 * Usage:
 *   node status-writer.js --status illness --until 2026-02-25 [--note "Erkältung"]
 *   node status-writer.js --status travel --since 2026-03-01 --until 2026-03-08
 *   node status-writer.js --clear
 *   node status-writer.js --show
 */

const fs = require('fs');
const path = require('path');

const WORKSPACE = process.env.OPENCLAW_WORKSPACE || path.join(process.env.HOME || '/root', '.openclaw/workspace');
const COACH_ROOT = path.join(WORKSPACE, 'health', 'coach');
const STATUS_FILE = path.join(COACH_ROOT, 'status.json');
const TZ = 'Europe/Berlin';

const VALID_STATUS = ['illness', 'injury', 'travel', 'deload', 'healthy'];

function today() {
  return new Date().toLocaleDateString('en-CA', { timeZone: TZ });
}

function loadStatus() {
  try {
    return JSON.parse(fs.readFileSync(STATUS_FILE, 'utf8'));
  } catch {
    return null;
  }
}

function saveStatus(data) {
  if (!fs.existsSync(COACH_ROOT)) fs.mkdirSync(COACH_ROOT, { recursive: true });
  fs.writeFileSync(STATUS_FILE, JSON.stringify(data, null, 2), 'utf8');
}

function parseArgs() {
  const args = process.argv.slice(2);
  const out = {};
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--clear') return { clear: true };
    if (args[i] === '--show') return { show: true };
    if (args[i] === '--status' && args[i + 1]) {
      out.status = args[i + 1].toLowerCase();
      i++;
    } else if (args[i] === '--since' && args[i + 1]) {
      out.since = args[i + 1];
      i++;
    } else if (args[i] === '--until' && args[i + 1]) {
      out.until = args[i + 1];
      i++;
    } else if (args[i] === '--note' && args[i + 1]) {
      out.note = args[i + 1];
      i++;
    }
  }
  return out;
}

function main() {
  const opts = parseArgs();

  if (opts.show) {
    const s = loadStatus();
    if (!s || s.status === 'healthy') {
      console.log('Status: healthy (no restrictions)');
      return;
    }
    console.log(JSON.stringify(s, null, 2));
    return;
  }

  if (opts.clear) {
    saveStatus({ status: 'healthy', updatedAt: new Date().toISOString() });
    console.log('Status cleared. Back to healthy.');
    return;
  }

  if (!opts.status || !VALID_STATUS.includes(opts.status)) {
    console.error('Usage: node status-writer.js --status illness|injury|travel|deload --until YYYY-MM-DD [--since YYYY-MM-DD] [--note "…"]');
    console.error('       node status-writer.js --clear');
    console.error('       node status-writer.js --show');
    process.exit(1);
  }

  if (opts.status === 'healthy') {
    saveStatus({ status: 'healthy', updatedAt: new Date().toISOString() });
    console.log('Status set to healthy.');
    return;
  }

  const since = opts.since || today();
  const until = opts.until || since;
  if (until < since) {
    console.error('--until must be >= --since');
    process.exit(1);
  }

  const data = {
    status: opts.status,
    since,
    until,
    note: opts.note || null,
    updatedAt: new Date().toISOString(),
  };
  saveStatus(data);
  console.log(`Status set: ${opts.status} from ${since} to ${until}${opts.note ? ` (${opts.note})` : ''}`);
}

main();
