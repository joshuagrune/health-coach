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

## RULE_RECOVERY_EXCLUDE

- **evidenceType:** coach_heuristic
- **confidence:** high
- **sourceIds:** [SRC002]
- **decision:** Low-intensity active recovery (flexibility, mobility, yoga, stretch) excluded from load when RPE < 5, <5 min in Z3+, and avgHR < 70% maxHR. Intense yoga (Power, Hot) or recovery sessions with elevated HR/effort still count.
- **limitations:** Type matching is keyword-based; edge cases (e.g. "Yoga Flow" at RPE 6) may be misclassified.

---

## Implementation (workout-utils.js, plan-generator.js)

### Load computation (computeWorkoutLoad)

- **Priority 1:** HR zones (Edwards-style TRIMP: Z1=1, Z2=2, Z3=3, Z4=4, Z5=5). Standard zone-weighted internal load.
- **Priority 2:** sRPE (RPE × duration) — Foster 1998 [SRC002].
- **Priority 3:** Classification as intensity multiplier (recovery 0.5, zone2 1, tempo 2, intervals 2.5, etc.).
- **Priority 4:** Duration only (1×) as fallback.

### ACWR (computeACWR)

- **Acute:** Last 7 calendar days intensity-weighted load (rest days = 0).
- **Chronic:** Last 28 calendar days load / 4 (rolling average; rest days = 0).
- **Calendar-based windows:** Matches Gabbett 2016 methodology — rest days reduce acute load, so recovery actually lowers ACWR.
- **Thresholds:** <0.8 detraining | 0.8–1.3 safe | 1.3–1.5 elevated | >1.5 high risk.
- **Deload trigger:** ACWR > 1.3 (conservative; Gabbett 2016 [SRC004], Hulin [SRC005]; Zouhal 2021 [SRC009] notes use as heuristic).
- **Fallback** when no chronic data available: volume >600 min/week or (≥4 hard sessions AND >480 min).

### Deload volume reduction

- **Factor:** 0.55 (~45% reduction) — SRC013 (Deload Delphi consensus): reduce volume/sets, maintain frequency.
- **Strength:** 2×12–15 light vs 3×8–12 moderate; SRC014: 1-week deload maintains hypertrophy, reduces strength slightly.
