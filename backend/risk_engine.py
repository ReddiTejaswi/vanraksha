"""Explainable risk scoring for Vanraksha alert triage.

This is deliberately a decision-support score, not a claim of illegality.
It can be replaced with a supervised satellite-change model after labelled
historical ranger observations are available.
"""

from dataclasses import dataclass


@dataclass
class RiskResult:
    score: int
    level: str
    reasons: list[str]


def score_alert(*, canopy_change: float, temperature_c: float | None,
                humidity_pct: float | None, wind_kmh: float | None,
                nearby_wildfires: int) -> RiskResult:
    """Combine a sample canopy-change feature with live environmental context.

    canopy_change is a 0-1 feature supplied by the prototype's illustrative
    change records. Weather and wildfire fields can be fetched from live APIs.
    """
    score = round(canopy_change * 60)
    reasons = [f"Canopy-change signal: {canopy_change:.0%}"]

    if temperature_c is not None and temperature_c >= 32:
        score += 10
        reasons.append("High temperature can increase fire risk")
    if humidity_pct is not None and humidity_pct <= 35:
        score += 10
        reasons.append("Low humidity can increase fire risk")
    if wind_kmh is not None and wind_kmh >= 20:
        score += 10
        reasons.append("Higher wind can spread fire faster")
    if nearby_wildfires > 0:
        score += min(10, nearby_wildfires * 2)
        reasons.append(f"{nearby_wildfires} open wildfire event(s) in the nearby feed")

    score = min(score, 100)
    level = "high" if score >= 70 else "medium" if score >= 40 else "low"
    return RiskResult(score=score, level=level, reasons=reasons)
