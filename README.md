# Health Coach Skill

Assessment-first health and fitness coach for OpenClaw. Builds a profile from Salvor data (optional) or manual intake, generates multi-goal training plans (endurance, strength, cycling, triathlon, bodycomp, sleep), and maintains a workout calendar JSON.

## Features

- **Assessment-first**: Agent asks to sync/analyze health data before baseline questions.
- **Salvor optional**: Works with or without Salvor; manual intake fallback.
- **Multi-goal planning**: Endurance (marathon, half, 10k, 5k, cycling, triathlon), strength (split-aware), bodycomp, sleep, general fitness.
- **Fixed appointments**: Block slots for team sports (e.g. volleyball) with season windows.
- **Profile**: Cross-domain (endurance, strength, sleep, body) from Salvor or intake; confidence flags.
- **Adaptation**: Missed-workout reconciliation for LR, Tempo, Intervals, Strength, Cycling, Swim/Bike/Brick.
- **Calendar reconcile**: Detects moved/deleted published sessions; updates plan.
- **Calendar publish**: Optional khal integration (dry-run supported).
- **Research**: Scientific background in `research/` with ruleId→sourceId traceability.

## Install

See [INSTALL.md](INSTALL.md).

## Scripts (`scripts/`)

All scripts live in `scripts/` within this skill folder. See [scripts/README.md](scripts/README.md).

| Script | Purpose |
|--------|---------|
| salvor-sync.js | Long-term Salvor sync (bootstrap 365d, paginated, idempotent) |
| intake-from-goals.js | Pre-populate intake from goals.md (schema v3) |
| intake-writer.js | Write intake.json from JSON (validates v3) |
| intake-validation.js | Intake schema v3 validation (used by writer/plan-generator) |
| profile-builder.js | Build profile from Salvor or manual intake |
| plan-generator.js | Multi-program: endurance, strength, habits; global guardrails |
| adaptive-replanner.js | Reconcile actual vs planned; all session types |
| calendar-publish.js | Publish to Sport calendar |
| calendar-reconcile.js | Reconcile moved/deleted calendar events |
| validate-health-coach.js | Validation suite (intake v3, guardrails, matching) |

## Research

Planning rules are traceable to `research/` (see [research/README.md](research/README.md)).
