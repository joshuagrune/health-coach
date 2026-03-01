# Health Coach Skill — Install

## Git Clone

```bash
# Into OpenClaw skills (shared)
git clone <repo-url> ~/.openclaw/skills/health-coach

# Or into workspace skills (per-agent)
git clone <repo-url> /path/to/workspace/skills/health-coach
```

## Scripts

Scripts live in **`{skill}/scripts/`** (e.g. `~/.openclaw/skills/health-coach/scripts/`). Coach data is in `workspace/health/coach/`.

```bash
# From workspace (OPENCLAW_WORKSPACE defaults to ~/.openclaw/workspace)
cd ~/.openclaw/workspace
node ~/.openclaw/skills/health-coach/scripts/sync/salvor-sync.js

# Or with explicit workspace
OPENCLAW_WORKSPACE=/path/to/workspace node ~/.openclaw/skills/health-coach/scripts/sync/salvor-sync.js
```

## Config

Add to `~/.openclaw/openclaw.json`:

```json
"skills": {
  "entries": {
    "health-coach": {
      "apiKey": "<your SALVOR_API_KEY>"
    }
  }
}
```

**Salvor is optional.** If `SALVOR_API_KEY` is set, the skill can sync and analyze your health data automatically. If not set, the agent will use manual intake to build your profile.

**Calendar publish** requires `SPORT_CALENDAR_ID` (your khal calendar ID). Set in env or `workspace/.env`. Never commit this value.

Wetter kann für Outdoor-Workouts berücksichtigt werden – bei vorhandener `current/weather_forecast.json` (weather skill: `~/.openclaw/skills/weather/`).

## Assessment-First Flow

On first use, the agent asks: "Should I sync and analyze your health data first (recommended)?" If yes and key exists, it runs `salvor-sync.js` then `profile-builder.js`. If no or key missing, it does manual intake and builds a profile from your answers.

## Intake Schema v3

- **goals[]**: `kind` (endurance, strength, bodycomp, sleep, general) + `subKind` (marathon, half, 10k, 5k, cycling, triathlon_*)
- **constraints**: daysAvailable, preferredRestDays, maxSessionsPerWeek, fixedAppointments[]
- **baseline**: strengthSplitPreference (full_body, upper_lower, push_pull_legs, bro_split), trainingHistoryByModality

## First Run

1. (Optional) Set `SALVOR_API_KEY` in config or env for data-driven profile.
2. Run `node ~/.openclaw/skills/health-coach/scripts/sync/salvor-sync.js` (bootstrap 365d) — only if using Salvor.
3. Complete onboarding (agent collects constraints, baseline, goals) and write `intake.json` via `intake-writer.js`.
4. Run `node ~/.openclaw/skills/health-coach/scripts/plan/profile-builder.js`.
5. Run `node ~/.openclaw/skills/health-coach/scripts/plan/plan-generator.js`.

## Analysis Scripts (`scripts/analysis/`)

All analysis scripts live in `scripts/analysis/`:

| Script | Purpose |
|--------|---------|
| workout-analysis.js | Compare metrics across same-type workouts (pace, HR, GCT, stride, power) |
| workout-volume-trend.js | Training volume per week/month |
| pace-at-hr-trend.js | Pace at HR zone (Z2) over time |
| sleep-trend.js | Sleep: total, deep, REM, weekday vs weekend, consistency |
| weekly-summary.js | Volume, sleep, readiness; writes `health_weekly_summary.json` |
| load-management.js | Acute:Chronic Load Ratio (injury risk) |
| running-form-trend.js | GCT, stride length, vertical oscillation |
| vitals-trend.js | RHR, HRV, weight, VO2max over time |

```bash
# Examples
node ~/.openclaw/skills/health-coach/scripts/analysis/workout-analysis.js [--type Running] [--summary]
node ~/.openclaw/skills/health-coach/scripts/analysis/weekly-summary.js [--days 7] [--text]
node ~/.openclaw/skills/health-coach/scripts/analysis/vitals-trend.js [--days 365] [--period month] [--summary]
```

## Reconcile (optional)

- **plan/adaptive-replanner.js**: Match Salvor workouts to planned sessions; mark completed/missed/skipped.
- **calendar/calendar-reconcile.js**: After `vdirsyncer sync`, detect moved/deleted calendar events; update plan. Run before adaptive-replanner if using calendar publish.

## Heartbeats (for Agent Systems like OpenClaw)

In agent systems that support **heartbeats** (periodic background checks), the Health Coach becomes proactive: the agent reads fresh data and reaches out when something needs attention.

**Recommended heartbeat task** — add to your agent's `HEARTBEAT.md` or equivalent:

1. **Check** `current/health_profile_summary.json`, `current/training_plan_week.json`, optionally `current/health_weekly_summary.json`
2. **Triggers for proactive outreach**:
   - `flags.sleepDeficit` → "Your sleep was below average recently. Should I reduce intensity this week?"
   - `flags.loadSpike` → "Training volume has increased significantly. Want to schedule a deload week?"
   - `flags.lowReadiness` → "Readiness is low — light sessions or rest today?"
   - No workout in 3+ days (compare `workout_calendar.json` / Salvor vs today) → "You haven't trained in a few days — intentional or should I adjust the plan?"
   - `goalProgress` with `trendInRightDirection: true` → Congratulate (e.g. "Your weight/sleep is moving toward your goal.")
   - `goalProgress` with `trendInRightDirection: false` → Gentle nudge (e.g. "Trend is opposite your goal; consider adjusting.")
3. **If relevant**: Send a short message (Telegram, etc.). **Else**: continue (no message).

These files are written by the cron jobs below. Run cron first so the agent has fresh data to check.

---

## Cron Jobs (System Crontab)

```bash
crontab -e
```

**Alle 15 Min** — Sync + Kalender + Notifier:

```
*/15 * * * * cd ~/.openclaw/workspace && node ~/.openclaw/skills/health-coach/scripts/sync/salvor-sync.js && node health/scripts/sync-workouts-and-calendar.js && node ~/.openclaw/skills/health-coach/scripts/plan/health-notifier.js
```

**Täglich** (z.B. 08:30) — Profil:

```
30 8 * * * cd ~/.openclaw/workspace && node ~/.openclaw/skills/health-coach/scripts/plan/profile-builder.js
```

Replace `~/.openclaw/workspace` with your actual path. Use `SALVOR_API_KEY` from env or `workspace/.env`; avoid hardcoding in crontab.

Plan wird bei neuem Workout automatisch vom Sync neu gebaut. Kein separater Weekly-Plan oder Daily-Replan nötig.

## Troubleshooting

See `TROUBLESHOOTING.md` for common issues (Salvor sync, profile, calendar, scripts).
