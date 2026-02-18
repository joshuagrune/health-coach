# Health Coach Skill (Salvor-based)

OpenClaw skill for milestone-based adaptive training plans (e.g. marathon), health profiles from Salvor data, and workout calendar JSON.

## Features

- **Onboarding**: Goals, constraints, safety gates → `intake.json`
- **Salvor sync**: Long-term workouts, sleep, vitals, activity, scores
- **Profile**: Baselines, trends, flags (sleep, load, readiness)
- **Plan**: Base → Build → Peak → Taper; fits weekly schedule
- **Adaptation**: Missed-workout reconciliation; audit trail
- **Calendar publish**: Optional khal integration (dry-run supported)
- **Research**: Scientific background in `research/` with ruleId→sourceId traceability

## Install

See [INSTALL.md](INSTALL.md).

## Scripts (`scripts/`)

All scripts live in `scripts/` within this skill folder. See [scripts/README.md](scripts/README.md).

| Script | Purpose |
|--------|---------|
| salvor-sync.js | Long-term Salvor sync |
| intake-from-goals.js | Pre-populate intake from goals.md |
| intake-writer.js | Write intake.json from JSON |
| profile-builder.js | Build profile.json |
| plan-generator.js | Generate workout_calendar.json |
| adaptive-replanner.js | Reconcile actual vs planned |
| calendar-publish.js | Publish to Sport calendar |
| validate-health-coach.js | Validation suite |

## Research

Planning rules are traceable to `research/` (see [research/README.md](research/README.md)).
