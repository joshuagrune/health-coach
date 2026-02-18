# Calendar Publish Safety Checklist

Before publishing planned sessions to the Sport calendar:

1. **vdirsyncer sync first** — Always run `vdirsyncer sync` before any calendar write. Never run `khal new` first and sync afterwards.

2. **Dry-run** — Run `node health/scripts/calendar-publish.js --dry-run` to see what would be created. Verify dates and titles.

3. **No duplicates** — Check that planned sessions don't overlap with existing calendar events for the same day. The sync script matches by title + time; avoid creating duplicates.

4. **Timezone** — All times are in CET (Europe/Berlin). Default publish time is 10:00 local.

5. **Never delete** — Do NOT delete `~/.cache/vdirsyncer/` or any subdirectory. Only delete individual `.ics` files when intentionally removing a single event.

6. **After publish** — Run `vdirsyncer sync` again to push changes to iCloud.
