# Health Coach Scripts

All scripts use `OPENCLAW_WORKSPACE` (default `~/.openclaw/workspace`) for data paths.

## Structure

| Dir | Scripts |
|-----|---------|
| **sync/** | salvor-sync.js |
| **intake/** | intake-writer.js |
| **plan/** | profile-builder.js, plan-generator.js, health-notifier.js, adaptive-replanner.js |
| **calendar/** | calendar-publish.js, calendar-reconcile.js |
| **status/** | status-writer.js |
| **lib/** | cache-io.js (loadJson, loadJsonlFiles, getRecent), intake-validation.js, status-helper.js, goal-progress.js |
| **analysis/** | workout-analysis, workout-volume-trend, pace-at-hr-trend, sleep-trend, weekly-summary, load-management, running-form-trend, vitals-trend |
| **validate/** | validate-health-coach.js, run-scenario-tests.js |

## Examples

```bash
# Sync and profile
node scripts/sync/salvor-sync.js
node scripts/plan/profile-builder.js

# Plan
node scripts/plan/plan-generator.js
node scripts/plan/adaptive-replanner.js

# Analysis
node scripts/analysis/weekly-summary.js --text
node scripts/analysis/vitals-trend.js --days 365 --summary
```

See `CALENDAR_PUBLISH_CHECKLIST.md` before publishing to calendar.
