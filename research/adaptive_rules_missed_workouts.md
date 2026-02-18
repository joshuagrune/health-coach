# Adaptive Rules for Missed Workouts

## RULE_NEVER_CRAM

- **evidenceType:** coach_heuristic
- **confidence:** high
- **sourceIds:** [SRC003]
- **decision:** Never add extra hard sessions to make up a miss; never stack two key workouts back-to-back
- **limitations:** Universal rule.

## RULE_EASY_MISSED_DROP

- **evidenceType:** coach_heuristic
- **confidence:** high
- **sourceIds:** [SRC003]
- **decision:** If easy run missed: default drop. Optional: add +10–20% to one easy run only if weekly load guardrails pass
- **limitations:** Conservative.

## RULE_INTERVALS_MISSED_DROP

- **evidenceType:** coach_heuristic
- **confidence:** high
- **sourceIds:** [SRC003]
- **decision:** If Intervals missed: drop this week. Swap allowed only if no back-to-back hard and LR not threatened
- **limitations:** Intervals lowest-priority key workout.

## RULE_TEMPO_MISSED_SWAP

- **evidenceType:** coach_heuristic
- **confidence:** high
- **sourceIds:** [SRC003]
- **decision:** If Tempo/MP missed: swap within 48–72h only if recovery spacing preserved. Else drop.
- **limitations:** Preserve LR.

## RULE_LR_MISSED_SWAP_OR_SHORTEN

- **evidenceType:** coach_heuristic
- **confidence:** high
- **sourceIds:** [SRC003]
- **decision:** If LR missed: swap to nearest available day within 1–2 days, or do shortened LR (60–80% planned). Do not pay back next week with oversized LR
- **limitations:** LR highest priority.

## RULE_DISRUPTION_DELOAD

- **evidenceType:** coach_heuristic
- **confidence:** high
- **sourceIds:** [SRC002]
- **decision:** If >30–40% of the planned week missed (travel/illness): treat as unplanned deload; next week reduce targets
- **limitations:** Threshold heuristic.

## RULE_Z2_MISSED_SKIP

- **evidenceType:** coach_heuristic
- **confidence:** high
- **sourceIds:** [SRC003]
- **decision:** If Z2/easy session missed: mark skipped. Low priority; no swap. Optional: add volume to another easy session if guardrails pass.
- **limitations:** Conservative; Z2 is filler.

## RULE_CYCLING_MISSED_SWAP

- **evidenceType:** coach_heuristic
- **confidence:** moderate
- **sourceIds:** [SRC003]
- **decision:** If Cycling session missed: swap to next available slot within 48–72h, or skip. Similar to Z2 for volume; key sessions (e.g. long ride) may warrant swap.
- **limitations:** Cycling-specific evidence limited; extrapolated from running.

## RULE_TRIATHLON_MISSED_SWAP

- **evidenceType:** coach_heuristic
- **confidence:** moderate
- **sourceIds:** [SRC003]
- **decision:** If Swim/Bike/Brick missed: swap to next available slot. Brick sessions highest priority; swim/bike can swap within modality.
- **limitations:** Triathlon-specific evidence limited; extrapolated from running and cycling.

## RULE_CALENDAR_RECONCILE

- **evidenceType:** system_constraint
- **confidence:** high
- **sourceIds:** []
- **decision:** When user moves or deletes a published calendar event: update workout_calendar session (moved → new date; deleted → cancelled). Calendar is intent signal; reconcile before adaptive-replanner.
- **limitations:** Requires vdirsyncer sync; reads from local storage. No source — operational rule.
