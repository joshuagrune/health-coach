# Marathon Periodization

Base → Build → Peak/Specific → Taper scaffold for marathon training.

## RULE_MARATHON_PHASE_BASE

- **evidenceType:** coach_heuristic
- **confidence:** high
- **sourceIds:** [SRC003, SRC017]
- **decision:** Base phase: consistent frequency + gradual volume; intensity low. Key workouts: LR weekly (easy), strides / short hills 1–2×/week. LR progression: adaptive to timeline — (90 min − baseline) / baseWeeks per week, cap 5 min/week (SRC017: build-up +2–3 km/week).
- **limitations:** Phase lengths vary by athlete; no hard evidence for exact week counts.

## RULE_MARATHON_PHASE_BUILD

- **evidenceType:** coach_heuristic
- **confidence:** high
- **sourceIds:** [SRC003, SRC017, SRC018]
- **decision:** Build phase: maintain volume progression while adding 1 quality session. Key workouts: LR weekly (easy → progression). LR progression: adaptive — (150 − 90) / buildWeeks when base exists, else (150 − baseline) / buildWeeks for short plans; cap 5–15 min/week (SRC017: peak LR ~30 km). Tempo 1×/week, optional Intervals every 7–14 days.
- **limitations:** Individual tolerance varies.

## RULE_MARATHON_PHASE_PEAK

- **evidenceType:** coach_heuristic
- **confidence:** high
- **sourceIds:** [SRC003]
- **decision:** Peak phase: marathon-specific endurance. Key workouts: LR with MP segments, T or MP midweek, Intervals optional.
- **limitations:** Fatigue management critical; avoid overreaching.

## RULE_MARATHON_PHASE_TAPER

- **evidenceType:** evidence_based
- **confidence:** high
- **sourceIds:** [SRC001]
- **decision:** Taper phase: ~2 weeks; reduce volume 41–60%; maintain intensity touches.

## RULE_KEY_WORKOUT_PRIORITY

- **evidenceType:** coach_heuristic
- **confidence:** high
- **sourceIds:** [SRC003]
- **decision:** Priority order: LR > Tempo/MP > EasyFrequency > Intervals/Hills. Drop Intervals first when constrained.
- **limitations:** Advanced athletes may tolerate different ordering.
