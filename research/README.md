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
| `marathon_periodization.md` | Base → Build → Peak → Taper phases |
| `tapering_evidence.md` | Taper duration, volume reduction |
| `load_management_and_injury_risk.md` | Monotony, strain, ACWR, ramp rate |
| `adaptive_rules_missed_workouts.md` | Missed-workout handling |
| `salvor_data_quality_and_limits.md` | API data quality, normalization |
