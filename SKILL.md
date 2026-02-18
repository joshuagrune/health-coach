---
name: health-coach
description: Salvor-based Health Coach — onboards goals/constraints, builds health & fitness profile from Salvor data, generates milestone-based adaptive training plans (e.g. marathon), outputs workout calendar JSON. Use when users ask about training plans, marathon prep, workout scheduling, health profile, or adaptive planning.
metadata: {"openclaw":{"requires":{"env":["SALVOR_API_KEY"]},"primaryEnv":"SALVOR_API_KEY"}}
---

# Health Coach (Salvor-based)

Builds a long-term health and fitness profile from Salvor data, generates milestone-based adaptive training plans (e.g. marathon), and maintains a canonical workout calendar JSON with history + future plans.

## When to Use

- "Erstelle mir einen Marathon-Trainingsplan"
- "Wie sieht mein aktuelles Fitness-Profil aus?"
- "Workout-Kalender für die nächsten Wochen"
- "Ich habe ein Workout verpasst – wie passe ich den Plan an?"
- "Zeig mir meine Trainingshistorie und den Plan bis zum Marathon"
- "Health Coach Onboarding" / "Ziele und Constraints erfassen"

## Prerequisites

- **SALVOR_API_KEY**: Injected from config when skill is enabled. Never read from .env in scripts — use `$SALVOR_API_KEY` from process env.
- **Salvor skill**: This skill extends Salvor API usage; ensure the `salvor` skill is also enabled.
- **Calendar (optional)**: For publishing planned sessions to Sport calendar — requires vdirsyncer + khal (see caldav-calendar skill). **Always run `vdirsyncer sync` first** before any calendar write.

## Timezone

All user-facing scheduling uses **CET / Europe/Berlin**. Store timestamps in UTC; derive `localDate` for day aggregation.

## Data Paths

- **Coach root**: `workspace/health/coach/`
- **Salvor cache**: `workspace/health/coach/salvor_cache/` (workouts, sleep, vitals, activity, scores)
- **Derived**: `intake.json`, `profile.json`, `workout_calendar.json`, `adaptation_log.jsonl`
- **Rolling summaries**: `workspace/current/health_profile_summary.json`, `workspace/current/training_plan_week.json`

## Interaction Flows

### 1. Onboarding (first run)

If `workspace/health/coach/intake.json` is missing, run an intake conversation:

- **Milestones**: Marathon date, priority (finish vs target time), intermediate races
- **Constraints**: Days available, max time/day, travel, gym access, other sports (e.g. volleyball), rest days
- **Baseline**: Current running frequency, longest recent run, injury history, perceived fitness
- **Intensity calibration**: Race times or threshold estimate; fallback RPE zones (Zone2, Tempo, Intervals)
- **Preferences**: Plan style, language, notification cadence
- **Safety gates**: Pain/illness rules (when to stop and rest)

Then write `intake.json` and trigger profile + plan generation.

### 2. Profile & Plan Generation

- Run Salvor sync (if needed): `node {baseDir}/scripts/salvor-sync.js`
- Build profile: `node {baseDir}/scripts/profile-builder.js`
- Generate plan: `node {baseDir}/scripts/plan-generator.js`

### 3. Adaptation (missed workouts, schedule changes)

- Run reconciliation: `node {baseDir}/scripts/adaptive-replanner.js`
- Applies rules: never cram; LR swap/shorten; Tempo swap within 48–72h; Intervals drop first; illness/travel → deload

### 4. Calendar Publishing (optional)

- Dry-run: `node {baseDir}/scripts/calendar-publish.js --dry-run`
- Publish: `node {baseDir}/scripts/calendar-publish.js` (requires vdirsyncer sync first)

## Scripts (in `{baseDir}/scripts/`)

| Script | Purpose |
|--------|---------|
| `salvor-sync.js` | Long-term Salvor sync (workouts, sleep, vitals, activity, scores); incremental + bootstrap |
| `profile-builder.js` | Compute `profile.json` from cache; write `health_profile_summary.json` |
| `plan-generator.js` | Generate `workout_calendar.json` (history + planned sessions to milestone) |
| `adaptive-replanner.js` | Reconcile actual vs planned; apply adaptation rules; append to `adaptation_log.jsonl` |
| `calendar-publish.js` | Publish next 7–14 days to Sport calendar (dry-run supported) |

## Safety

- **Health advice**: Coaching guidance only; no diagnosis. Include injury/illness stop gate.
- **Secrets**: Never print or store SALVOR_API_KEY in outputs.
- **Calendar**: Follow vdirsyncer sync-first rule; never delete `~/.cache/vdirsyncer/`.

## Research & Evidence

Planning rules are traceable to `research/` in this skill folder. Each rule has `ruleId`, `sourceIds`, and limitations. See `research/README.md` and `research/sources.md`.
