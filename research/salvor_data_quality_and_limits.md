# Salvor Data Quality & Limits

## Source

- **sourceIds:** [SRC010]

## Data Quality Notes

- **Timezone:** Server UTC vs user local date. Use `target_date` (scores/today) and `anchor_date` (scores/history) for consistent UI alignment.
- **Nullable fields:** Preserve `null` vs `0` (unknown vs measured-zero).
- **Unit-tagged fields:** Prefer `_meters`, `_seconds`, `_kg`, `_mps`, `_w`, `_rpm`, etc.
- **Scores availability:** Computed from personal baselines (last 28 days); expect null or low `data_quality` when history sparse or sources change.

## API Limits

- **Workouts:** `limit` max 100; paginate by date range.
- **Scores history:** `days` 1–90 (default 30).
- **Export:** JSON `days` 1–730; PDF `days` 1–365.

## Normalization Rules

- Store `startTimeUtc`, `endTimeUtc`, and derived `localDate` (Europe/Berlin).
- Workout IDs: `salvor:<id>` when API returns id.
- Do not assume units for ambiguous fields (e.g. `active_calories`, `hrv`, `spo2`).
