# Trainingsplan-Generator — Logik-Übersicht

Rolling 7-Tage-Plan basierend auf Workout-History, ACWR, Readiness und Constraints.

---

## 1. Eingaben

| Quelle | Verwendung |
|--------|------------|
| **intake.json** | Goals, Baseline, Constraints (Tage, Rest Days, fixedAppointments) |
| **profile.json** | Historische Frequenz (falls Baseline fehlt) |
| **workouts_** (JSONL) | Letzte 7 Tage Workouts → Hard-Einstufung, Volumen, Modality |
| **scores_** (JSONL) | Salvor: Readiness, ACWR (EWMA), Recovery, Sleep |
| **weather_forecast.json** | (optional, von weather skill) 7-Tage-Vorhersage je Standort → Hinweise für Outdoor-Sessions (Regen, Hitze, Wind); health-notifier nutzt für Benachrichtigungen |

---

## 2. Modus

Aus Goals/Milestones:
- **Hybrid**: Endurance + Strength
- **Endurance only**: Laufen/Fahrrad (Marathon, Halbmarathon, etc.)
- **Strength only**: Nur Kraft

---

## 3. Verfügbare Slots

Für jeden der nächsten 7 Tage:
- Muss in `daysAvailable` sein (z.B. mo, tu, we, th, fr, sa)
- Darf nicht in `preferredRestDays` sein (z.B. sun)
- Darf nicht durch `fixedAppointments` blockiert sein (z.B. Volleyball Mo)
- Tage mit bereits erledigten Workouts werden herausgefiltert

→ Nur freie Slots können Sessions bekommen.

---

## 4. Signal-Sammlung (letzte 7 Tage)

### Hard-Einstufung (datenbasiert, nicht Typ-Annahme)

**Hard** (1 Tag Recovery nötig):
1. Effort Score ≥ 7 (RPE)
2. Classification: tempo, interval, zone4, zone5, threshold, vo2max
3. HR-Zonen: ≥8 min Z4+Z5 (oder ≥5 min bei Session ≥30 min; bei langen Sessions Ratio 15 %+)
4. Fallback nur wenn keine Vitals: Typ-Pattern (tempo, volleyball, strength, etc.)

**Very Hard** (2 Tage Recovery):
- Effort ≥ 8 ODER Z4+Z5 ≥ 20 min ODER ≥80 min + Hard

### Modality

- **Endurance**: run, zone, walking, cycling, swim, etc.
- **Strength**: strength, full body, gym, crossfit, etc.
- **Other**: z.B. Volleyball (zählt für Hard, nicht für Strength/Endurance-Quota)

### ACWR

- Salvor EWMA-Ratio bevorzugt (Williams et al. 2017)
- Fallback: eigener Compute aus Workout-Load (28d vs 7d)

### Readiness

- Von Salvor: heutiger Score (HRV, RHR, Sleep, Load Composite)

---

## 5. Weekly Targets

**Baseline:**
- Strength: `baseline.strengthFrequencyPerWeek` (default 2)
- Endurance: `baseline.runningFrequencyPerWeek` (default 3)

**Deload** (ACWR > 1.3 nach Gabbett 2016):
- Volumen ~45 % reduziert (SRC013 Delphi)
- Hard Sessions: Faktor 0.55
- Z2: Faktor 0.75 (Bosquet & Mujika 2012 — aerober Stimulus erhalten)

**Remaining:**
- `remainingEndurance` = Target − erledigte Endurance-Sessions
- `remainingStrength` = Target − erledigte Strength-Sessions

---

## 6. Session-Platzierung

### Hard-Session-Regeln

- Kein Hard am Tag nach/nach einem Hard
- Kein Hard am Tag nach einem Very Hard
- Kein Hard am Tag vor einem geplanten Hard
- Max Hard pro 7-Tage-Fenster: 2–5 (je nach Fitness, default 3)

### Endurance-Sessions

Reihenfolge (Marathon-Base):
1. Long Run (LR) — hard
2. Zone 2 — easy
3. Qualität (Intervals/Tempo abwechselnd wöchentlich) — hard
4. Zone 2 — easy

Dauer: Baseline-basiert (`longestRecentRunMinutes`, `z2DurationMinutes`).

### Strength-Sessions

- Split: full_body, upper_lower, push_pull_legs, bro_split
- Titel: Full Body A/B, Upper/Lower, etc.
- Dauer: `longestStrengthSessionMinutes` (default 60)

### Hybrid

- Endurance auf geraden Slot-Indizes, Strength auf ungeraden
- Keine Modality-Mischung pro Tag (eine Session pro Tag)

---

## 7. Guardrails

1. **Back-to-back Hard**: Entfernt, falls zwei Hard-Sessions auf benachbarten Tagen
2. **Hard-Budget**: Geplante Hard + erledigte Hard ≤ maxHardPerWeek

---

## 8. Readiness Gating

Nur wenn **erste geplante Session heute oder morgen** ist (Readiness hat keine Prädiktivkraft für 2+ Tage):

| Readiness | Aktion auf erste Session |
|-----------|--------------------------|
| > 65 | Keine Änderung |
| 50–65 | Tempo, Intervals → Z2 |
| < 50 | LR, Tempo, Intervals → Z2 |

Strength bleibt unverändert. Bei `dataQuality: insufficient` → kein Gating.

---

## 9. Output

- `workout_calendar.json`: Sessions, Recommendations, Blueprint
- `training_plan_week.json`: Nächste 7 Tage, Blueprint, Status

---

## 10. Wissenschaftliche Referenzen

| Konzept | Quelle |
|---------|--------|
| ACWR 1.3 Deload-Schwelle | Gabbett 2016 |
| EWMA vs Rolling Average | Williams et al. 2017 |
| Deload ~45 % Volumen | SRC013 Deload Delphi |
| Z2 bei Deload leichter reduzieren | Bosquet & Mujika 2012 |

---

*Stand: März 2026*
