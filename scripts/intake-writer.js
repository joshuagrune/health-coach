#!/usr/bin/env node
/**
 * Writes intake.json from a JSON object (stdin or --file path).
 * Use after onboarding Q&A: agent collects answers, builds object, pipes to this script.
 *
 * Example: echo '{"milestones":[{"id":"m1","kind":"marathon","dateLocal":"2026-06-15","priority":"finish"}]}' | node intake-writer.js
 */

const fs = require('fs');
const path = require('path');

const WORKSPACE = process.env.OPENCLAW_WORKSPACE || path.join(process.env.HOME || '/root', '.openclaw/workspace');
const COACH_ROOT = path.join(WORKSPACE, 'health', 'coach');
const INTAKE_FILE = path.join(COACH_ROOT, 'intake.json');

function ensureDir(dir) {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

function main() {
  let data;
  const fileArg = process.argv.find((a) => a.startsWith('--file='));
  if (fileArg) {
    const filePath = fileArg.slice(7);
    data = JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } else {
    const chunks = [];
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', (c) => chunks.push(c));
    process.stdin.on('end', () => {
      const raw = chunks.join('');
      if (!raw.trim()) {
        console.error('No JSON input. Pipe JSON or use --file=path');
        process.exit(1);
      }
      try {
        data = JSON.parse(raw);
      } catch (e) {
        console.error('Invalid JSON:', e.message);
        process.exit(1);
      }
      writeIntake(data);
    });
    return;
  }
  writeIntake(data);
}

function writeIntake(data) {
  ensureDir(COACH_ROOT);
  const payload = {
    version: data.version ?? 2,
    updatedAt: new Date().toISOString(),
    ...data,
  };
  fs.writeFileSync(INTAKE_FILE, JSON.stringify(payload, null, 2), 'utf8');
  console.log('Wrote', INTAKE_FILE);
}

main();
