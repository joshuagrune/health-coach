# Health Coach Scripts

All scripts use `OPENCLAW_WORKSPACE` (default `~/.openclaw/workspace`) for data paths.

| Script | Purpose |
|--------|---------|
| `salvor-sync.js` | Long-term Salvor sync (bootstrap 365d, incremental 7d, paginated) |
| `intake-from-goals.js` | Pre-fill `intake.json` from `health/goals.md` (schema v2, multi-goal) |
| `intake-writer.js` | Write `intake.json` from JSON input |
| `profile-builder.js` | Compute `profile.json` from Salvor cache or intake |
| `plan-generator.js` | Goal-driven: endurance, strength, habits |
| `adaptive-replanner.js` | Reconcile actual vs planned; LR, Tempo, Intervals, Strength |
| `calendar-publish.js` | Publish next 7–14 days to Sport calendar (dry-run supported) |
| `validate-health-coach.js` | Validation suite: timezone, guardrails, matching, intake v2 |

See `CALENDAR_PUBLISH_CHECKLIST.md` before publishing to calendar.
