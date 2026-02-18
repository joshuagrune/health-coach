# Health Coach Scripts

All scripts use `OPENCLAW_WORKSPACE` (default `~/.openclaw/workspace`) for data paths.

| Script | Purpose |
|--------|---------|
| `salvor-sync.js` | Long-term Salvor sync (workouts, sleep, vitals, activity, scores); incremental + bootstrap |
| `intake-from-goals.js` | Pre-fill `intake.json` from `health/goals.md` |
| `intake-writer.js` | Write `intake.json` from JSON input |
| `profile-builder.js` | Compute `profile.json` from cache; write `health_profile_summary.json` |
| `plan-generator.js` | Generate `workout_calendar.json` (history + planned sessions to milestone) |
| `adaptive-replanner.js` | Reconcile actual vs planned; apply adaptation rules; append to `adaptation_log.jsonl` |
| `calendar-publish.js` | Publish next 7–14 days to Sport calendar (dry-run supported) |
| `validate-health-coach.js` | Validation suite: timezone, guardrails, matching |

See `CALENDAR_PUBLISH_CHECKLIST.md` before publishing to calendar.
