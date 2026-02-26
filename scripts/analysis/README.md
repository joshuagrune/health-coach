# Analysis Scripts

All scripts read from `workspace/health/coach/salvor_cache/` via `lib/cache-io.js` (no API calls). Run from workspace or with `OPENCLAW_WORKSPACE` set.

| Script | Purpose |
|--------|---------|
| workout-analysis.js | Compare metrics across same-type workouts (pace, HR, GCT, stride, power) |
| workout-volume-trend.js | Training volume per week/month |
| pace-at-hr-trend.js | Pace at HR zone (Z2) over time |
| sleep-trend.js | Sleep: total, deep, REM, weekday vs weekend, consistency |
| weekly-summary.js | Volume, sleep, readiness; writes `workspace/current/health_weekly_summary.json` |
| load-management.js | Acute:Chronic Load Ratio (injury risk) |
| running-form-trend.js | GCT, stride length, vertical oscillation |
| vitals-trend.js | RHR, HRV, weight, VO2max over time |

Add `--summary` for human-readable output; omit for JSON.
