# Illness and Training: Neck Rule

Evidence for when to train vs rest when sick.

## RULE_ILLNESS_NECK_RULE

- **evidenceType:** coach_heuristic
- **confidence:** high
- **sourceIds:** [common practice; Cleveland Clinic, WebMD, LA Times]
- **decision:** **Above the neck** (runny nose, stuffy nose, light headache, sore throat, sneezing, dry cough): light exercise (Z2, walk) may be OK at ~50% intensity. **Below the neck** (chest congestion, body aches, fatigue, nausea): rest. **Fever**: never train regardless of other symptoms.
- **limitations:** Individual tolerance varies; "sweating out" a cold is a myth.

## RULE_ILLNESS_FEVER_48H

- **evidenceType:** coach_heuristic
- **confidence:** high
- **sourceIds:** [intake illnessRule]
- **decision:** If fever or flu: no training until 48h symptom-free.
- **limitations:** Conservative; some sources suggest 24h.

## RULE_STATUS_ILLNESS_BLOCK

- **evidenceType:** system_constraint
- **confidence:** high
- **sourceIds:** []
- **decision:** When user sets `status: illness` via status-writer: sessions in [since, until] are not published to calendar; adaptive-replanner marks them as "skipped" (not "missed"); no swap logic triggered.
- **limitations:** User must manually set/clear status.
