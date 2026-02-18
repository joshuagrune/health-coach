---
name: health-coach
description: Health Coach — assessment-first, builds health & fitness profile (Salvor optional), generates multi-goal training plans (endurance, strength, bodycomp, sleep). Use when users ask about training plans, fitness profile, workout scheduling, or health goals.
metadata: {"openclaw":{"requires":{"env":[]},"optionalEnv":["SALVOR_API_KEY"]}}
---

# Health Coach

Assessment-first health and fitness coach. Builds a profile from Salvor data (optional but recommended) or manual intake, generates multi-goal training plans (endurance, strength, bodycomp, sleep), and maintains a workout calendar JSON.

## When to Use

- "Show my health profile"
- "Create a training plan"
- "Workout scheduling"
- "Missed workout adaptation"
- "Health Coach Onboarding" / "Goal capture"

## Prerequisites

- **SALVOR_API_KEY** (optional, recommended): When set, enables automatic sync and data-driven profile. If missing, use manual intake. Never read from .env in scripts — use `$SALVOR_API_KEY` from process env.
- **Salvor skill**: Only needed when using Salvor sync; ensure enabled if SALVOR_API_KEY is set.
- **Calendar (optional)**: For publishing planned sessions — requires vdirsyncer + khal. **Always run `vdirsyncer sync` first** before any calendar write.

## Timezone

All user-facing scheduling uses **CET / Europe/Berlin**. Store timestamps in UTC; derive `localDate` for day aggregation.

## Data Paths

- **Coach root**: `workspace/health/coach/`
- **Salvor cache**: `workspace/health/coach/salvor_cache/` (workouts, sleep, vitals, activity, scores)
- **Derived**: `intake.json`, `profile.json`, `workout_calendar.json`, `adaptation_log.jsonl`
- **Rolling summaries**: `workspace/current/health_profile_summary.json`, `workspace/current/training_plan_week.json`

## Assessment-First Flow (MANDATORY)

**Before asking any baseline or goal questions**, auto-detect state:

1. Check: `workspace/health/coach/intake.json`, `profile.json`, `workout_calendar.json`, `salvor_cache/`, `workspace/current/health_profile_summary.json`
2. If profile exists and is recent (<24h) and salvor_cache has data → summarize current state and ask what the user wants to do next.
3. If coach/ is empty or profile missing/stale → **ask first**:
   - "Should I sync and analyze your health data first (recommended) to evaluate your current fitness and health status? If yes, I'll run Salvor sync and build your profile. If no or you don't use Salvor, I'll ask you a few questions to estimate your baseline."
4. **If user says yes**:
   - **If SALVOR_API_KEY is set**:
      - continue
   - **If SALVOR_API_KEY is not set**:
     - Prompt the user to provide their Salvor API key to enable automatic sync and a data-driven profile, or proceed with manual intake if they prefer.
   - Run `salvor-sync.js` (bootstrap 365d)
   - Run `profile-builder.js`
   - Summarize profile (sleep, workouts, readiness, vitals) and then ask about goals.
5. **If user says no** or SALVOR_API_KEY is not set:
   - Run manual intake Q&A (constraints, baseline, goals)
   - Write `intake.json` via `intake-writer.js`
   - Run `profile-builder.js` (builds manual profile from intake)
   - Then ask about planning goals.


## Interaction Flows

### 1. Onboarding (first run)

Follow Assessment-First Flow above. Then, if intake is missing:

- **Goals**: Endurance (marathon, half, 10k), strength, bodycomp, sleep, general fitness — ask what matters to the user
- **Constraints**: Days available, max time/day, travel, gym access, other sports, rest days
- **Baseline**: Training frequency, longest recent run/session, injury history, perceived fitness (running + strength)
- **Intensity calibration**: Race times or threshold; fallback RPE zones
- **Preferences**: Plan style, language, notification cadence
- **Safety gates**: Pain/illness rules

Write `intake.json` via `intake-writer.js` **with goals included**. Never write empty `goals: []` if the user stated goals. Format:
- Endurance: `{ id, kind: "endurance", subKind: "marathon", dateLocal: "YYYY-MM-DD", priority: "target_time"|"finish", targetTimeSeconds?: 14400 }`
- Strength: `{ id, kind: "strength", priority: "moderate" }`
- Bodycomp: `{ id, kind: "bodycomp", priority: "moderate" }`
- Also set `milestones: [{ id, kind: "marathon", dateLocal, priority, targetTimeSeconds? }]` for endurance events.

Then trigger profile + plan generation.

### 2. Profile & Plan Generation

- If Salvor available: Run `salvor-sync.js` first (bootstrap 365d), then `profile-builder.js`
- If no Salvor: Run `profile-builder.js` (builds manual profile from intake)
- **Before plan-generator**: Ensure `intake.json` has non-empty `goals` (and `milestones` for endurance). If empty but user stated goals, re-write intake with goals or run `intake-from-goals.js` (when `health/goals.md` exists).
- Generate plan: `node {baseDir}/scripts/plan-generator.js` (goal-driven: endurance, strength, habits)

### 3. Adaptation (missed workouts, schedule changes)

- Run `node {baseDir}/scripts/adaptive-replanner.js`
- Applies rules: never cram; LR swap/shorten; Tempo swap within 48–72h; Intervals drop first; Strength missed → safe swap; illness/travel → deload

### 4. Calendar Publishing (optional)

- Dry-run: `node {baseDir}/scripts/calendar-publish.js --dry-run`
- Publish: `node {baseDir}/scripts/calendar-publish.js` (requires vdirsyncer sync first)

## Scripts (in `{baseDir}/scripts/`)

| Script | Purpose |
|--------|---------|
| `salvor-sync.js` | Long-term Salvor sync (workouts, sleep, vitals, activity, scores); bootstrap 365d, incremental 7d |
| `profile-builder.js` | Compute `profile.json` from Salvor cache or intake baseline; write `health_profile_summary.json` |
| `plan-generator.js` | Goal-driven: endurance, strength, habits; outputs `workout_calendar.json` |
| `adaptive-replanner.js` | Reconcile actual vs planned; apply adaptation rules; append to `adaptation_log.jsonl` |
| `calendar-publish.js` | Publish next 7–14 days to Sport calendar (dry-run supported) |

## Safety

- **Health advice**: Coaching guidance only; no diagnosis. Include injury/illness stop gate.
- **Secrets**: Never print or store SALVOR_API_KEY in outputs.
- **Calendar**: Follow vdirsyncer sync-first rule; never delete `~/.cache/vdirsyncer/`.

## Research & Evidence

Planning rules are traceable to `research/` in this skill folder. Each rule has `ruleId`, `sourceIds`, and limitations. See `research/README.md` and `research/sources.md`.
