# Research & Evidence

This folder documents the scientific background for the Health Coach planning rules.

## Evidence Policy

- Every non-trivial planning rule has a `ruleId` and cites at least one source in `sources.md`.
- Distinguish: **evidence-based rule** vs **coach heuristic** vs **safety constraint**.
- Include limitations/controversies to avoid overclaiming.
- Keep docs concise and operational.

## Citation Format

- **sources.md:** Each source has stable ID (`SRC001`, `SRC002`, …).
- **Topic files:** Each rule has `ruleId`, `evidenceType`, `confidence`, `sourceIds`, `limitations`.
- **Planner:** References `ruleId`s in code/config; writes applied `ruleId`s into adaptation logs.

## Files

| File | Topic |
|------|-------|
| `sources.md` | Source registry (URLs, annotations) |
| `marathon_periodization.md` | Marathon: Base → Build → Peak → Taper phases |
| `tapering_evidence.md` | Taper duration, volume reduction |
| `load_management_and_injury_risk.md` | Monotony, strain, ACWR, ramp rate, recovery exclusion, implementation (load/ACWR/deload) |
| `adaptive_rules_missed_workouts.md` | Missed-workout handling |
| `strength_training_evidence.md` | Strength: frequency, volume, deload, progression |
| `strength_splits_evidence.md` | Strength splits: full-body, PPL, upper/lower, bro-split, upper-body only |
| `running_plans_evidence.md` | Running: marathon, half, 10k, 5k plan structure |
| `cycling_plans_evidence.md` | Cycling: Base → Build → Peak periodization |
| `triathlon_plans_evidence.md` | Triathlon: sprint, Olympic, 70.3, Ironman; swim/bike/run distribution |
| `fixed_appointments_evidence.md` | Fixed appointments: team sports, volleyball, season length |
| `endurance_zone_hiit_evidence.md` | Zone 2, polarized, HIIT frequency and recovery |
| `flexibility_mobility_evidence.md` | Stretching, ROM, foam rolling |
| `sleep_recovery_evidence.md` | Sleep hygiene, napping, SWS, recovery |
| `salvor_data_quality_and_limits.md` | API data quality, normalization |
