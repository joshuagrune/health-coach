# Health Coach Skill

Assessment-first health and fitness coach for OpenClaw. Builds a profile from Salvor data (optional) or manual intake, generates multi-goal training plans (endurance, strength, bodycomp, sleep), and maintains a workout calendar JSON.

## Features

- **Assessment-first**: Agent asks to sync/analyze health data before baseline questions.
- **Salvor optional**: Works with or without Salvor; manual intake fallback.
- **Multi-goal planning**: Endurance (marathon), strength, bodycomp, sleep, general fitness.
- **Profile**: Cross-domain (endurance, strength, sleep, body) from Salvor or intake.
- **Adaptation**: Missed-workout reconciliation for LR, Tempo, Intervals, Strength.
- **Calendar publish**: Optional khal integration (dry-run supported).
- **Research**: Scientific background in `research/` with ruleId→sourceId traceability.

## Install

See [INSTALL.md](INSTALL.md).

## Scripts (`scripts/`)

All scripts live in `scripts/` within this skill folder. See [scripts/README.md](scripts/README.md).

| Script | Purpose |
|--------|---------|
| salvor-sync.js | Long-term Salvor sync (bootstrap 365d, paginated) |
| intake-from-goals.js | Pre-populate intake from goals.md (schema v2) |
| intake-writer.js | Write intake.json from JSON |
| profile-builder.js | Build profile from Salvor or manual intake |
| plan-generator.js | Goal-driven: endurance, strength, habits |
| adaptive-replanner.js | Reconcile actual vs planned |
| calendar-publish.js | Publish to Sport calendar |
| validate-health-coach.js | Validation suite |

## Research

Planning rules are traceable to `research/` (see [research/README.md](research/README.md)).
