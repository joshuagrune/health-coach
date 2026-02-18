# Fixed Appointments Evidence

Evidence for integrating fixed commitments (e.g. team sports, volleyball) into training plans. Season length and volume adjustment.

## RULE_FIXED_APPOINTMENT_SLOT

- **evidenceType:** coach_heuristic
- **confidence:** high
- **sourceIds:** [SRC027, SRC028]
- **decision:** Team sport (e.g. volleyball) counts as a fixed slot; reduces available days for other training. Plan around it: do not schedule conflicting sessions on same day; treat as hard session for recovery planning.
- **limitations:** Intensity of team practice varies; some sessions may be light technical work.

## RULE_FIXED_APPOINTMENT_SEASON

- **evidenceType:** coach_heuristic
- **confidence:** moderate
- **sourceIds:** [SRC026]
- **decision:** User can specify season length (e.g. 2–5 months school, 6–9 months club). Plan treats this period as "constrained" — fewer slots for additional training; adjust volume accordingly.
- **limitations:** Season dates vary by league and region; beach volleyball often year-round.

## RULE_FIXED_APPOINTMENT_VOLUME

- **evidenceType:** evidence_based
- **confidence:** moderate
- **sourceIds:** [SRC027]
- **decision:** When fixed commitments exist: use lower-volume approach; periodize around match days; taper before games. Lower-volume resistance and aerobic training can achieve similar fitness gains when managing fixed commitments.
- **limitations:** Meta-analysis certainty low due to study heterogeneity; individual response varies.

## RULE_VOLLEYBALL_SEASON_LENGTH

- **evidenceType:** coach_heuristic
- **confidence:** moderate
- **sourceIds:** [SRC026]
- **decision:** Indoor: high school 2–3 months (10–12 weeks competition); college 4–5 months; club 6–9 months (Aug/Sep–Mar/Apr). Beach: year-round at recreational level. Use to set constraint window for planning.
- **limitations:** Regional and league differences; professional/international summer tournaments (Jun–Aug).
