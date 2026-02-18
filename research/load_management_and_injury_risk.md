# Load Management & Injury Risk

## RULE_NO_BACK_TO_BACK_HARD

- **evidenceType:** coach_heuristic
- **confidence:** high
- **sourceIds:** [SRC003]
- **decision:** No back-to-back hard days; at least 1 easy/rest day between hard sessions
- **limitations:** "Hard" definition varies; some athletes tolerate more.

## RULE_MAX_HARD_SESSIONS_WEEK

- **evidenceType:** coach_heuristic
- **confidence:** moderate
- **sourceIds:** [SRC003]
- **decision:** Max 2 hard sessions per week (LR, T/MP, I/Hills count as hard)
- **limitations:** Advanced runners may tolerate 3; risk lever.

## RULE_LR_RATIO_CAP

- **evidenceType:** coach_heuristic
- **confidence:** moderate
- **sourceIds:** [SRC007, SRC008]
- **decision:** Long run ≤ 30–35% of weekly distance/time
- **limitations:** Common heuristic; no hard threshold.

## RULE_WEEKLY_RAMP_CAP

- **evidenceType:** coach_heuristic
- **confidence:** moderate
- **sourceIds:** [SRC007, SRC008]
- **decision:** Weekly volume change cap: +2–8% (or small absolute cap)
- **limitations:** Calibrate per athlete; sudden changes plausibly risky.

## RULE_CUTBACK_WEEKS

- **evidenceType:** coach_heuristic
- **confidence:** moderate
- **sourceIds:** [SRC002]
- **decision:** Every 3–4 weeks reduce volume ~15–25% (or triggered by flags)
- **limitations:** Planned deload; evidence from monotony/strain framework.

## RULE_ACWR_CAUTION

- **evidenceType:** evidence_based
- **confidence:** high
- **sourceIds:** [SRC004, SRC005, SRC009]
- **decision:** If ACWR > ~1.3: caution (hold week or reduce intensity). If ACWR ≥ ~1.5: spike alert → deload or remove intensity

- **limitations:** ACWR controversial; use as heuristic, not oracle. Strongest evidence in team sports.

## RULE_MONOTONY_STRAIN

- **evidenceType:** evidence_based
- **confidence:** moderate
- **sourceIds:** [SRC002]
- **decision:** If monotony high (little day-to-day variation): insert rest/easy; if strain spikes vs baseline: schedule deload
- **limitations:** Requires daily load data; sRPE if no HR/pace.
