# Health Coach — Troubleshooting

## Salvor Sync

**"SALVOR_API_KEY not set"**
- Add the key to `~/.openclaw/openclaw.json` under `skills.entries.health-coach.apiKey`, or
- Set `SALVOR_API_KEY` in your environment / cron, or
- Create `workspace/.env` with `SALVOR_API_KEY=your_key`

**Sync fails with HTTP 401**
- API key is invalid or expired. Regenerate in Salvor dashboard.

**Sync fails with "Insufficient data"**
- Salvor may return empty arrays for new accounts. Run `profile-builder.js` after first successful sync; it falls back to manual intake if cache is empty.

## Profile / Plan

**"intake.json has empty goals"**
- Run onboarding. Never write `goals: []` if the user stated goals.

**Plan shows no Strength sessions**
- Check `intake.json` has a strength or bodycomp goal, or baseline with strength history.

## Calendar

**"SPORT_CALENDAR_ID not set"**
- Add `SPORT_CALENDAR_ID=your-khal-calendar-id` to env or `workspace/.env`
- Find your calendar ID with `khal list` or in vdirsyncer config. Never commit this value.

**Events not appearing**
- Run `vdirsyncer sync` before `calendar-publish.js`
- Check `~/.cache/vdirsyncer/` exists and collection is configured

**Adaptive-replanner marks sessions wrong**
- Ensure `status.json` is correct (illness/travel)
- Run `calendar-reconcile.js` first if using calendar publish

## Scripts

**"Insufficient data" in load-management**
- Need at least 7 days of workouts. Sync more data or extend `--days`.

**workout-analysis / pace-at-hr shows no Running**
- Filter by `--type Running`; ensure Salvor has running workouts with distance.

**sleep-trend / vitals-trend empty**
- Salvor must have sleep/vitals data. Check `salvor_cache/sleep_*.jsonl` and `vitals_*.jsonl`.
