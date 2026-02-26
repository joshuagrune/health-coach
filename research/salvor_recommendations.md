# Salvor → Health Coach: Empfehlungen

Empfehlungen von Salvor an den Health Coach, basierend auf der Salvor-Plattform-Implementierung.

## 1. EWMA-basierte Load-Metriken nutzen

**Status:** ✅ Implementiert (plan-generator, load-management)

Salvor berechnet Acute/Chronic Load mit **EWMA** (Exponentially Weighted Moving Average) statt einfacher Rolling-Averages. Williams et al. 2017 [SRC006] zeigt: EWMA ist sensitiver für Load-Spikes.

**API:** `GET /scores/today` und `GET /scores/history` liefern:

```json
{
  "training_load": {
    "acute_load": 450.2,
    "chronic_load": 380.5,
    "ratio": 1.18,
    "ramp_rate": 12.5,
    "method": "ewma",
    "monotony": 2.1,
    "strain": 945.4
  }
}
```

**Empfehlung:** Wenn Salvor-Scores synchronisiert sind (`scores_*.jsonl`), nutze `training_load.ratio` und `training_load.acute_load`/`chronic_load` statt eigener Berechnung aus Workouts. Das gibt dir EWMA-Qualität ohne doppelte Logik.

## 2. Zonengewichtetes TRIMP aus HR-Zeitreihen

Salvor nutzt **HR-Zeitreihen** (alle HR-Samples pro Workout) für zonengewichtetes TRIMP. health-coach nutzt `heart_rate_zones` (Minuten pro Zone) — beides ist Edwards-kompatibel (Z1=1 … Z5=5).

**Empfehlung:** Wenn Salvor Workout-Details mit `heart_rate_zones` liefert (via `GET /health/workouts/{id}` mit Workout-Details-Sync), sind die Zonen bereits HRR-basiert und präziser als Classification-Fallback.

## 3. Recovery Exclusion (bereits abgestimmt)

Beide Systeme schließen jetzt low-intensity active recovery (Yoga, Mobility, Stretch) von der Load aus, wenn RPE < 5, < 5 min Z3+, avgHR < 70% maxHR. Foster 1998 [SRC002].

## 4. Monotony & Strain

Salvor liefert ab 2026 `monotony` und `strain` (Foster 1998) in der Training-Load-API:

- **monotony** = mean(daily_load) / SD(daily_load) über 7 Tage
- **strain** = acute_load × monotony

**Empfehlung:** Nutze `strain` für RULE_MONOTONY_STRAIN — bei hohem Strain vs. Baseline: Deload oder Ruhetag einplanen.

## 5. HRR-Personalisierung

Salvor leitet HRmax aus der Workout-Historie ab (P95/P98, 90 Tage). Das verbessert TRIMP und Zonen-Gewichtung.

**Empfehlung:** Wenn health-coach eigene Load-Berechnung behält (z.B. ohne Salvor-Sync): RHR und HRmax aus Salvor-Vitals oder Intake nutzen für konsistentere Zonen.

## Quellen

- SRC002: Foster 1998 — sRPE, monotony, strain
- SRC004: Gabbett 2016 — ACWR
- SRC006: Williams et al. 2017 — EWMA vs. rolling averages
