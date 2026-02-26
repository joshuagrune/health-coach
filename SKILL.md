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
- "Workout analysis" / "Compare my runs" / "Compare run metrics"
- "Volume trend" / "Training volume over time" / "Pace at heart rate" / "Sleep trend"
- "Health Coach Onboarding" / "Goal capture"

## Prerequisites

- **SALVOR_API_KEY** (optional, recommended): When set, enables automatic sync and data-driven profile. If missing, use manual intake. Never read from .env in scripts — use `$SALVOR_API_KEY` from process env.
- **Salvor skill**: Only needed when using Salvor sync; ensure enabled if SALVOR_API_KEY is set.
- **Calendar (optional)**: For publishing planned sessions — requires vdirsyncer + khal. **Always run `vdirsyncer sync` first** before any calendar write.

**→ See `INSTALL.md`** in this skill folder for: first run, cron jobs, heartbeats (proactive agent checks in OpenClaw-style systems).

## Timezone

All user-facing scheduling uses **CET / Europe/Berlin**. Store timestamps in UTC; derive `localDate` for day aggregation.

## Data Paths

- **Coach root**: `workspace/health/coach/`
- **Salvor cache**: `workspace/health/coach/salvor_cache/` (workouts, sleep, vitals, activity, scores)
- **Derived**: `intake.json`, `profile.json`, `workout_calendar.json`, `adaptation_log.jsonl`
- **Rolling summaries**: `workspace/current/health_profile_summary.json`, `workspace/current/training_plan_week.json`, `workspace/current/health_weekly_summary.json`

## Assessment-First Flow (MANDATORY)

**Before asking any baseline or goal questions**, auto-detect state:

1. **Detect state**: Check `workspace/health/coach/intake.json`, `profile.json`, `workout_calendar.json`, `salvor_cache/`, `workspace/current/health_profile_summary.json`, `workspace/current/training_plan_week.json`.
2. **If profile exists and is recent (<24h)** and salvor_cache has data → summarize current state and ask what the user wants to do next.
3. **If coach/ is empty or profile missing/stale** → **First question (always)**:
   - "Should I sync and analyze your health data first (recommended) to evaluate your current fitness and health status? If yes, I'll run Salvor sync and build your profile. If no or you don't use Salvor, I'll ask you a few questions to estimate your baseline."
4. **If user says yes and SALVOR_API_KEY is set**:
   - Run `scripts/sync/salvor-sync.js` (bootstrap 365d, configurable via SALVOR_BOOTSTRAP_DAYS)
   - Run `scripts/plan/profile-builder.js`
   - Summarize profile (sleep, workouts, readiness, vitals, dataQuality) and then ask about goals.
5. **If user says yes but SALVOR_API_KEY is not set**:
   - Prompt: "To sync Salvor data, I need your Salvor API key. You can add it as SALVOR_API_KEY, or we can proceed with manual intake instead."
   - If user provides key → run sync + profile. If user declines → go to step 6.
6. **If user says no or prefers manual** (Salvor optional):
   - Run manual intake Q&A (constraints, baseline, goals)
   - Write `intake.json` via `scripts/intake/intake-writer.js`
   - Run `scripts/plan/profile-builder.js` (builds manual profile from intake; dataQuality: "manual")
   - Then ask about planning goals.

**Sync on demand**: When the user insists on current/fresh data (e.g. "use current data", "aktuelle Daten", "sync first", "ist das aktuell?", "refresh", "neueste Daten") and SALVOR_API_KEY is set → run `scripts/sync/salvor-sync.js` then `scripts/plan/profile-builder.js` before answering. Do not ask — just sync and then proceed with the answer.

## Interaction Flows

### 1. Onboarding (first run)

Follow Assessment-First Flow above. Then, if intake is missing:

- **Goals**: Endurance (marathon, half, 10k, 5k, cycling, triathlon sprint/olympic/70.3/ironman), strength, bodycomp, sleep, general fitness — ask what matters to the user
- **Constraints** (required): **daysAvailable** — which days can you train? (mo, tu, wed, th, fr, sa, sun). **preferredRestDays** — which days do you prefer off? (e.g. wed, sun). **maxSessionsPerWeek** (optional) — cap sessions even if more days available (e.g. "I want 3x/week"). **fixedAppointments** (optional) — e.g. volleyball on Wed 18:00, frequency, season window. Also: max time/day, gym access, other sports.
- **Baseline**: Training frequency, longest recent run/session, injury history, perceived fitness (running + strength), strengthSplitPreference (full_body, upper_lower, push_pull_legs, bro_split), trainingHistoryByModality (optional)
- **Intensity calibration**: Race times or threshold; fallback RPE zones
- **Preferences**: Plan style, language, notification cadence
- **Safety gates**: Pain/illness rules

Write `intake.json` via `scripts/intake/intake-writer.js` **with goals included**. Never write empty `goals: []` if the user stated goals. Format:
- Endurance: `{ id, kind: "endurance", subKind: "marathon", dateLocal: "YYYY-MM-DD", priority: "target_time"|"finish", targetTimeSeconds?: 14400 }`
- Strength: `{ id, kind: "strength", priority: "moderate" }`
- Bodycomp: `{ id, kind: "bodycomp", priority: "moderate", targetWeightKg?: 75, direction?: "lose"|"gain" }`
- Sleep: `{ id, kind: "sleep", priority: "moderate", targetTotalMinutes?: 480 }` — 480 = 8h
- VO2max: `{ id, kind: "vo2max", priority: "moderate", targetVo2max?: 50 }`
- RHR/HRV: `targetRhr`, `targetHrv` for recovery goals (optional)
- Targets enable progress tracking; vitals-trend and sleep-trend show progress in `--summary`. No new scripts — extend existing ones.
- Also set `milestones: [{ id, kind: "marathon", dateLocal, priority, targetTimeSeconds? }]` for endurance events.

**Parsing user input to JSON:**
- "75kg lean", "abnehmen auf 75" → targetWeightKg: 75, direction: "lose"
- "80kg zunehmen", "gain auf 80" → targetWeightKg: 80, direction: "gain"
- "8 Stunden", "besserer Schlaf", "8h schlafen" → targetTotalMinutes: 480
- "VO2max 50", "höherer VO2max" → kind: "vo2max", targetVo2max: 50
- "every day" / "Mon–Sun" → daysAvailable: ["mo","tu","we","th","fr","sa","su"]
- "Friday Sunday rest" → preferredRestDays: ["fr","su"]; daysAvailable = all except those
- Day keys: mo, tu, we, th, fr, sa, su
- "3x per week" / "I want 3 sessions per week" → maxSessionsPerWeek: 3

**Never use defaults** for daysAvailable or preferredRestDays — if empty, plan-generator and intake-writer fail with clear errors. Always ask the user.

Then trigger profile + plan generation.

### 2. Profile & Plan Generation

- If Salvor available: Run `scripts/sync/salvor-sync.js` first (bootstrap 365d), then `scripts/plan/profile-builder.js`
- If no Salvor: Run `scripts/plan/profile-builder.js` (builds manual profile from intake)
- **Before plan-generator**: Ensure `intake.json` has non-empty `goals` (and `milestones` for endurance). If empty but user stated goals, re-write intake with goals via `intake-writer.js`.
- Generate plan: `node {baseDir}/scripts/plan/plan-generator.js` (goal-driven: endurance, strength, habits)
- **When summarizing the plan** (e.g. from `training_plan_week.json`): Include ALL session kinds — LR, Z2, Tempo, **Strength**, etc. Never omit Strength sessions; they are part of the plan when user has strength/bodycomp goals or baseline.

### 3. Status (illness, injury, travel)

When user says "Ich bin krank", "I'm sick", "erkältet", "Fieber", "traveling next week", "Reise nächste Woche":

- **Set status**: `node {baseDir}/scripts/status/status-writer.js --status illness --until YYYY-MM-DD [--note "Erkältung"]`
- **Travel**: `node scripts/status/status-writer.js --status travel --since YYYY-MM-DD --until YYYY-MM-DD`
- **Clear**: `node scripts/status/status-writer.js --clear` when user says "bin wieder fit", "recovered"
- **Show**: `node scripts/status/status-writer.js --show`

**Neck Rule** (light symptoms): If only above-neck (runny nose, light headache, sore throat) → Z2/light exercise may be OK. Below-neck (fever, body aches, chest) or fever → rest. Ask user for `--until` date; suggest 48h symptom-free for fever/flu.

**Effect**: Sessions in status period are not published to calendar; adaptive-replanner marks them as "skipped" (not "missed"); `training_plan_week.json` includes `status` for agent to show banner.

### 4. Adaptation (missed workouts, schedule changes)

- Run `node {baseDir}/scripts/calendar/calendar-reconcile.js` first (if using calendar publish) — detects moved/deleted events
- Run `node {baseDir}/scripts/plan/adaptive-replanner.js`
- Applies rules: never cram; LR swap/shorten; Tempo swap within 48–72h; Intervals drop first; Strength missed → safe swap; Z2/Cycling/Triathlon missed → swap or skip; illness/travel → deload

### 5. Calendar Publishing (optional)

- Dry-run: `node {baseDir}/scripts/calendar/calendar-publish.js --dry-run`
- Publish: `node {baseDir}/scripts/calendar/calendar-publish.js` (requires vdirsyncer sync first)

## Scripts (in `{baseDir}/scripts/`)

**sync/**:
| Script | Purpose |
|--------|---------|
| `salvor-sync.js` | Long-term Salvor sync (workouts, sleep, vitals, activity, scores); bootstrap 365d, incremental 7d |

**intake/**:
| Script | Purpose |
|--------|---------|
| `intake-writer.js` | Write intake.json from JSON (validates v3); use after onboarding Q&A |

**plan/**:
| Script | Purpose |
|--------|---------|
| `profile-builder.js` | Compute `profile.json` from Salvor cache or intake; write `health_profile_summary.json` |
| `plan-generator.js` | Multi-program: endurance, strength, habits; fixed appointments; global guardrails |
| `health-notifier.js` | Detect new workouts, scores (today), sleep (last night); emit coach notifications (Telegram) |
| `adaptive-replanner.js` | Reconcile actual vs planned; all session types; append to `adaptation_log.jsonl` |

**calendar/**:
| Script | Purpose |
|--------|---------|
| `calendar-reconcile.js` | Reconcile moved/deleted calendar events; reads vdirsyncer storage |
| `calendar-publish.js` | Publish next 7–14 days to Sport calendar (dry-run supported) |

**status/**:
| Script | Purpose |
|--------|---------|
| `status-writer.js` | Set/clear status (illness, injury, travel, deload); respects status in publish/replan |

**lib/** (shared): `cache-io.js` (loadJson, loadJsonlFiles, getRecent), `intake-validation.js`, `status-helper.js`, `goal-progress.js` (unified progress for all metric goals)

**validate/**:
| Script | Purpose |
|--------|---------|
| `validate-health-coach.js` | Validation suite |
| `run-scenario-tests.js` | E2E scenario tests |

**Analysis** (`scripts/analysis/`):
| Script | Purpose |
|--------|---------|
| `workout-analysis.js` | Compare metrics across same-type workouts (pace, HR, GCT, stride, power); `--type Running`, `--summary` |
| `workout-volume-trend.js` | Volume per week/month; `--type Running`, `--period week|month`, `--summary` |
| `pace-at-hr-trend.js` | Pace at HR zone (Z2) over time; `--hr-min`, `--hr-max`, `--summary` |
| `sleep-trend.js` | Sleep: total, deep, REM, weekday vs weekend, consistency; `--summary` |
| `weekly-summary.js` | Consolidates volume, sleep, readiness; writes `health_weekly_summary.json`; `--text` |
| `load-management.js` | Acute:Chronic Load Ratio (injury risk); `--type Running`, `--summary` |
| `running-form-trend.js` | GCT, stride, vertical oscillation over time; `--summary` |
| `vitals-trend.js` | RHR, HRV, weight, VO2max; goal progress for weight/vo2max/rhr/hrv; `--summary` |

## Goal Progress & Feedback (unified)

`profile.goalProgress` / `health_profile_summary.goalProgress` contains progress for all goals with targets (bodycomp, sleep, vo2max, rhr, hrv). **Use existing scripts** — no new ones:

- **vitals-trend.js --summary**: Shows goal progress for weight, VO2max, RHR, HRV
- **sleep-trend.js --summary**: Shows goal progress for sleep target

For each item in `goalProgress`:
- **trendInRightDirection: true**: Congratulate — e.g. "Your weight/sleep is moving toward your goal."
- **trendInRightDirection: false**: Gently note — e.g. "Trend is opposite your goal; consider adjusting."
- **current: null**: Mention that tracking (e.g. via Salvor) would enable progress feedback.

## Proactive Check-ins

When the user has an active plan and hasn't interacted recently, consider:

- **3+ days no workouts**: "You haven't trained in the last few days — is that intentional or should I adjust the plan?"
- **Load spike** (profile.flags.loadSpike): "Your training volume has increased significantly. Want to schedule a deload week?"
- **Sleep deficit** (profile.flags.sleepDeficit): "Your sleep was below average recently. Should I reduce intensity this week?"
- **Low readiness** (profile.flags.lowReadiness): "Readiness is low — light sessions or rest today?"

Run `scripts/analysis/weekly-summary.js` or read `health_weekly_summary.json` for quick context before check-ins.

## Safety

- **Health advice**: Coaching guidance only; no diagnosis. Include injury/illness stop gate.
- **Secrets**: Never print or store SALVOR_API_KEY in outputs.
- **Calendar**: Follow vdirsyncer sync-first rule; never delete `~/.cache/vdirsyncer/`.

## Research & Evidence

Planning rules are traceable to `research/` in this skill folder. Each rule has `ruleId`, `sourceIds`, and limitations. See `research/README.md` and `research/sources.md`.

## Troubleshooting

See `TROUBLESHOOTING.md` for sync, profile, calendar, and script issues. See `INSTALL.md` for setup, cron, and heartbeat configuration.
