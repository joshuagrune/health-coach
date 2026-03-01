# Trainingsplan-Generator — Logik-Übersicht

Rolling 7-Tage-Plan basierend auf Workout-History, ACWR, Readiness und Constraints.

---

## 1. Eingaben

| Quelle | Verwendung |
|--------|------------|
| **intake.json** | Goals, Baseline, Constraints (Tage, Rest Days, fixedAppointments), **trainingStartDate** (fester Vorbereitungsstart für Marathon-Phasen) |
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

## 2b. Marathon-Phasen & Vorbereitungsstart

**trainingStartDate** (intake.json) legt den festen Start der Vorbereitung fest. Ohne dieses Feld wird implizit „heute“ als Start angenommen.

- **Phase** (base → build → peak → taper): weiterhin aus `weeksToRace` (Renntermin minus heute)
- **weeksIntoBase** / **weeksIntoBuild**: wenn `trainingStartDate` gesetzt ist, aus vergangenen Wochen seit Start (nicht aus weeksToRace). So bleibt die Wochennummer stabil, auch wenn der Plan mehrfach pro Woche neu erzeugt wird.

Beispiel: Start 22.02.2026, heute 01.03.2026 → 7 Tage vergangen = **Woche 2** der Base-Phase.

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

**Frequenz-Zählung (per-Slot Rolling Window):** Für jeden zu planenden Tag wird das Rolling-7-Tage-Fenster [Tag−6 .. Tag] einzeln geprüft. Workouts von letzter Woche blockieren nicht mehr diese Woche. Beispiel: Di 03.03. vs Sa 07.03. haben unterschiedliche Fenster — Läufe von Do/Fr letzter Woche zählen für Di, nicht für Sa.

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

**Deload** — drei Auslöser (OR-verknüpft):
1. **Reaktiv:** ACWR > 1.3 (Gabbett 2016)
2. **Reaktiv Fallback:** >600 min/Woche oder (≥4 hard + >480 min) wenn ACWR fehlt
3. **Proaktiv (Bompa):** Base-Phase jede 4. Woche; Build-Phase jede 3. Woche

Blueprint: `deloadReason: 'acwr' | 'volume' | 'scheduled' | null`

Effekte: Volumen ~45 % reduziert (SRC013 Delphi), Hard Sessions Faktor 0.55, Z2 Faktor 0.75 (Bosquet & Mujika 2012).

**Frequenz-Check:** Pro Slot wird `countModalityInWindow(slotDate, completedWorkouts, plannedSessions, modality)` berechnet. Wenn count ≥ Target → kein weiteres Session dieser Modality an diesem Tag. Kein einmaliger Abzug mehr.

**Dynamisches Hard-Cap** (`deriveMaxHard(intake, recentSignals)`):

| Signal | Bedingung | Effekt |
|--------|-----------|--------|
| `perceivedFitness` | low/moderate/high/advanced | Basiswert 2/3/4/5 |
| ACWR | < 0.80 | +1 (untertrainiert, kann mehr absorbieren) |
| ACWR | > 1.25 | −1 (Überbelastungszone, Gabbett 2016) |
| ~~Readiness~~ | ~~< 50~~ | ~~−1~~ (akutes Tages-Signal, keine Prädiktivkraft >48h → nur Readiness Gating) |
| Very-Hard-Sessions letzte 7d | ≥ 2 | −1 (Residualfatigue) |

Ergebnis: clamp(1, 6). Manuelle Überschreibung via `baseline.maxHardSessionsPerWeek`.

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
2. Zone 2 — easy (+ optional Strides-Note bei ≥40 min in Base-Phase)
3. Qualität (Tempo) — nur wenn erlaubt (siehe Tempo-Gate)
4. Zone 2 — easy

Dauer: Baseline-basiert (`longestRecentRunMinutes`, `z2DurationMinutes`).

**Tempo-Gate (Hadd/Maffetone) — composite, signalbasiert:**  
In der Base-Phase wird Tempo nur eingebaut wenn **alle** Bedingungen erfüllt sind:

- ACWR ≥ 0.8 (nicht undertrained — kein Qualitätsreiz bei chronisch unterbelasteter Basis)
- Dann fitnesslevel-abhängig:
  - `high/advanced`: `weeksIntoBase >= 1` UND `longestRecentRunMinutes >= 45`
  - `moderate`: `weeksIntoBase >= 3` UND `longestRecentRunMinutes >= 60`
  - `low`: kein Tempo in der Base-Phase

Kein kalenderbasierter Hard-Cutoff mehr — gate entscheidet sich jede Woche neu anhand der aktuellen Signale.

**Strides:** Z2-Sessions ≥40 min in Base-Phase erhalten Note: "Optional: 4–6 × 20s Strides am Ende (locker ausschütteln, kein Sprint)".

### Strength-Sessions

- Split: full_body, upper_lower, push_pull_legs, bro_split
- Titel: Full Body A/B, Upper/Lower, etc.
- Dauer: `longestStrengthSessionMinutes` (default 60)

**Phasenabhängige Periodisierung (Bompa, Issurin):**

| Phase | Reps/Sets | Intensität | Ziel |
|-------|-----------|------------|------|
| Base | 3×10–12 | moderate | Hypertrophie/Basis |
| Build | 4×5–6 | hard | Maximalkraft |
| Peak | 3×3–5 | hard | Power/Erhalt (Dauer ×0.7) |
| Taper | 2×8–10 | light | Erhalt |
| Deload | 2×12–15 | light | Regeneration |

### Hybrid (Priority-Based, SRC029–SRC032)

**Ablauf:**
1. **Strength-Garantie (Pre-Reservation):** Vor der Endurance-Planung werden `min(2, strengthTarget)` Slots für Kraft reserviert (dry-run). Bei Marathon-Ziel bekommt Endurance nur die nicht-reservierten Slots.
2. **Endurance-Priorität:** Marathon-Ziel → Endurance zuerst auf freie (nicht reservierte) Slots. LR bevorzugt Wochenende. Tempo/Intervals bevorzugt Wochenende, um Wochenmitte für Kraft frei zu halten.
3. **Strength-Platzierung:** Kraft bekommt verbleibende Slots (inkl. reservierter). Interference Effect → kein Kraft benachbart zu LR/Tempo. **Puffertag vor LR:** Der Tag vor dem LR ist explizit für Kraft gesperrt (`lrDate - 1` wird zu `avoidHardDates` hinzugefügt). Strength-Slots werden nach Wochentag-Präferenz sortiert (Sa bleibt frei für LR-Carryover).
4. **Two-a-Days** (`constraints.allowTwoADays: true`, **Fallback only**): Wird **nur aktiviert**, wenn die Strength-Quota nach normaler Single-Session-Platzierung nicht erreicht wird. `allowTwoADays: true` bedeutet „erlaubt wenn nötig", nicht „immer". Kraft wird auf verbleibende Z2-Tage gelegt (Kraft morgens, Ausdauer abends, ≥3h Abstand). Nur Easy-Tage — kein Hard/HIIT am gleichen Tag (Interferenz-Effekt, Fyfe et al. 2016).

**Ohne Marathon-Ziel:** Endurance und Kraft erhalten gleichwertige Priorität (kein Pre-Reserve, interleaved).

**Limitierung:** Die Hard-Budget-Regel (max. 3 hard/7 Tage, rolling) begrenzt die Gesamtzahl harter Sessions — unabhängig von Frequenz-Einstellungen. Bei 2 absolvierten Hard-Sessions in der letzten Woche ist nur noch 1 Hard-Slot für frühe Wochentage frei.

**Strength-Garantie:** Bei `strengthTarget >= 2` wird mindestens `min(2, strengthTarget)` Slots vorreserviert. Kann trotzdem nur 1 Session entstehen (Hard-Budget, blockierte Tage, Restdays), wird `targets.strengthShortfall: true` gesetzt und eine Recommendation „Kraft-Soll unterschritten“ ausgegeben.

---

### 80/20-Polarized-Ratio (Seiler 2009) — Endurance-only

Blueprint: `polarizedRatio: { scope: 'endurance_only', hard: number, target: 0.2, ok: boolean, hardCount, easyCount, totalCount }`

Die 80/20-Regel gilt **nur für Endurance-Sessions** (LR, Tempo, Intervals, Z2). Kraft und fixedAppointments (z.B. Volleyball) werden **nicht** gezählt — sie folgen eigenen Regeln (Hard-Budget, Recovery).

Anteil harter Endurance-Sessions am Gesamt-Endurance-Plan. Ziel ≤25 %. Bei Überschreitung: Recommendation „80/20 Endurance-Ratio“.
Keine automatische Korrektur, nur Warnung.

---

### Auto-Update longestRecentRunMinutes

Nach Plan-Generierung: längster absolvierter Endurance-Lauf der letzten 14 Tage wird ermittelt.  
Wenn höher als `baseline.longestRecentRunMinutes`, wird intake.json aktualisiert — LR-Progression bleibt kalibriert.

---

## 7. Guardrails

1. **Back-to-back Hard**: Entfernt, falls zwei Hard-Sessions auf benachbarten Tagen
2. **Hard-Budget (per Slot)**: Bereits bei der Platzierung geprüft via Rolling-Fenster [Tag−6 .. Tag] über completed + planned Sessions; kein globaler Wochen-Cut mehr am Ende.

---

## 8. Readiness Gating

Nur wenn **erste geplante Session heute oder morgen** ist (Readiness hat keine Prädiktivkraft für 2+ Tage):

| Readiness | Endurance (erste Session) | Strength (erste Session) |
|-----------|----------------------------|--------------------------|
| > 65 | Keine Änderung | Keine Änderung |
| 50–65 | Tempo, Intervals → Z2 | Keine Änderung |
| < 50 | LR, Tempo, Intervals → Z2 | → Light (2×12–15, ~67% Dauer) |

Bei Downgrade zu Z2: `hardness` und `requiresRecovery` werden auf `easy`/`false` gesetzt — 80/20-Metrik und Guardrails bleiben konsistent.

Bei `dataQuality: insufficient` → kein Gating.

**LR-Carryover:** Wenn LR durch Readiness downgedgradet wird, versucht der Generator, den LR in derselben Woche auf einen späteren Tag zu verschieben. Suchreihenfolge (Maffetone 2010: LR gehört aufs Wochenende):
1. Freier Wochenend-Slot (Sa/So) ohne bestehende Session
2. Z2-Session tauschen an Wochenend-Tag (Sa/So)
3. Z2-Session tauschen an Wochentag (Fallback)

Bedingung je Slot: kein Back-to-Back-Hard, Hard-Budget nicht überschritten.  
Außerdem: Wenn Readiness < 50 und heute ein LR liegt, wird Samstag bei der Strength-Platzierung freigehalten (nicht für Kraft reserviert), damit der Carryover einen freien Wochenend-Slot findet.  
Falls kein Slot verfügbar: Recommendation „Long Run nachholen“ (nächste Woche priorisieren).

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
| Interference Effect (Kraft + Ausdauer) | SRC029 Hickson, SRC030 Wilson |
| Sequenzierung (Kraft vor Ausdauer) | SRC031 Fyfe |
| Block-/Wochenstruktur | SRC032 Issurin |
| Proaktive Deload-Wochen | Bompa |
| 80/20 polarized training | Seiler 2009 |
| Tempo-Gate (composite, signalbasiert) | Hadd, Maffetone |
| LR Wochenend-Präferenz, Puffertag | Maffetone 2010 |
| Strides (neuromuscular work) | Daniels, Canova |

---

*Stand: März 2026*
