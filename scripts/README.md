# Health Coach Scripts

All scripts use `OPENCLAW_WORKSPACE` (default `~/.openclaw/workspace`) for data paths.

| Script | Purpose |
|--------|---------|
| `salvor-sync.js` | Long-term Salvor sync (bootstrap 365d, incremental 7d, paginated, idempotent) |
| `intake-from-goals.js` | Pre-fill `intake.json` from `health/goals.md` (schema v3, multi-goal, fixed appointments) |
| `intake-writer.js` | Write `intake.json` from JSON input (validates v3) |
| `intake-validation.js` | Intake schema v3 validation; used by intake-writer and plan-generator |
| `profile-builder.js` | Compute `profile.json` from Salvor cache or intake; confidence flags |
| `plan-generator.js` | Multi-program: endurance (marathon/half/10k/5k/cycling/triathlon), strength (split-aware), habits; fixed appointments; global guardrails |
| `adaptive-replanner.js` | Reconcile actual vs planned; LR, Tempo, Intervals, Strength, Z2, Cycling, Swim/Bike/Brick |
| `calendar-publish.js` | Publish next 7–14 days to Sport calendar (dry-run supported) |
| `calendar-reconcile.js` | Reconcile moved/deleted calendar events; reads vdirsyncer storage |
| `status-writer.js` | Set/clear status (illness, injury, travel, deload); `status.json` used by publish/replan |
| `status-helper.js` | Shared helper: `isDateInStatusBlock`, `getStatus` |
| `validate-health-coach.js` | Validation suite: timezone, guardrails, matching, intake v3, calendar consistency |
| `run-scenario-tests.js` | E2E scenario tests: endurance-only, strength-only, endurance+strength, fixed-appointments |
| `workout-analysis.js` | Compare metrics across workouts of same type (pace, HR, GCT, stride, power); `--type Running`, `--summary` |
| `workout-volume-trend.js` | Volume per week/month; `--type Running`, `--period week|month`, `--summary` |
| `pace-at-hr-trend.js` | Pace at HR zone (Z2) over time; `--hr-min`, `--hr-max`, `--summary` |
| `sleep-trend.js` | Sleep: total, deep, REM, weekday vs weekend, consistency; `--summary` |
| `weekly-summary.js` | Consolidates volume, sleep, readiness; writes `health_weekly_summary.json`; `--text` |
| `load-management.js` | Acute:Chronic Load Ratio (injury risk); `--type Running`, `--summary` |
| `running-form-trend.js` | GCT, stride, vertical oscillation over time; `--summary` |
| `vitals-trend.js` | RHR, HRV, weight, VO2max over time; `--summary` |

See `CALENDAR_PUBLISH_CHECKLIST.md` before publishing to calendar.
