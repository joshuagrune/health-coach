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
node ~/.openclaw/skills/health-coach/scripts/salvor-sync.js

# Or with explicit workspace
OPENCLAW_WORKSPACE=/path/to/workspace node ~/.openclaw/skills/health-coach/scripts/salvor-sync.js
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

## Assessment-First Flow

On first use, the agent asks: "Should I sync and analyze your health data first (recommended)?" If yes and key exists, it runs `salvor-sync.js` then `profile-builder.js`. If no or key missing, it does manual intake and builds a profile from your answers.

## Intake Schema v3

- **goals[]**: `kind` (endurance, strength, bodycomp, sleep, general) + `subKind` (marathon, half, 10k, 5k, cycling, triathlon_*)
- **constraints**: daysAvailable, preferredRestDays, maxSessionsPerWeek, fixedAppointments[]
- **baseline**: strengthSplitPreference (full_body, upper_lower, push_pull_legs, bro_split), trainingHistoryByModality

## First Run

1. (Optional) Set `SALVOR_API_KEY` in config or env for data-driven profile.
2. Run `node ~/.openclaw/skills/health-coach/scripts/salvor-sync.js` (bootstrap 365d) — only if using Salvor.
3. Run `node ~/.openclaw/skills/health-coach/scripts/intake-from-goals.js` (or complete onboarding).
4. Run `node ~/.openclaw/skills/health-coach/scripts/profile-builder.js`.
5. Run `node ~/.openclaw/skills/health-coach/scripts/plan-generator.js`.

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

- **adaptive-replanner.js**: Match Salvor workouts to planned sessions; mark completed/missed/skipped.
- **calendar-reconcile.js**: After `vdirsyncer sync`, detect moved/deleted calendar events; update plan. Run before adaptive-replanner if using calendar publish.

## Cron Jobs (recommended)

To keep profile and plan up to date without manual runs. **Schedule daily jobs shortly after your typical wake-up time** (e.g. 30–60 min) so last night's sleep data is complete and the profile is fresh when you start your day.

```bash
# Edit crontab
crontab -e
```

**Daily** (e.g. 07:30 — adjust to your wake-up + 30 min) — sync Salvor data, rebuild profile, weekly summary:

```
30 7 * * * SALVOR_API_KEY=your_key OPENCLAW_WORKSPACE=~/.openclaw/workspace node ~/.openclaw/skills/health-coach/scripts/salvor-sync.js && node ~/.openclaw/skills/health-coach/scripts/profile-builder.js && node ~/.openclaw/skills/health-coach/scripts/analysis/weekly-summary.js
```

**Daily** (e.g. 07:45 — 15 min after sync) — reconcile planned vs actual:

```
45 7 * * * OPENCLAW_WORKSPACE=~/.openclaw/workspace node ~/.openclaw/skills/health-coach/scripts/adaptive-replanner.js
```

**Weekly** (e.g. Sunday 18:00) — regenerate plan (optional; plan changes only when intake/goals change):

```
0 18 * * 0 OPENCLAW_WORKSPACE=~/.openclaw/workspace node ~/.openclaw/skills/health-coach/scripts/plan-generator.js
```

**If using calendar publish** — run `vdirsyncer sync` before adaptive-replanner:

```
45 7 * * * vdirsyncer sync && OPENCLAW_WORKSPACE=~/.openclaw/workspace node ~/.openclaw/skills/health-coach/scripts/calendar-reconcile.js && node ~/.openclaw/skills/health-coach/scripts/adaptive-replanner.js
```

Replace `~/.openclaw/workspace` with your actual workspace path. Adjust the hour (e.g. `30 8` for 08:30) to match your wake-up. Use `SALVOR_API_KEY` from env or a secrets file; avoid hardcoding in crontab.

## Troubleshooting

See `TROUBLESHOOTING.md` for common issues (Salvor sync, profile, calendar, scripts).
