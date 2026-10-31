"""Vanraksha FastAPI service.

Run from the Vanraksha folder with: python -m uvicorn backend.main:app --reload
Then open http://127.0.0.1:8000.
"""

import json
import math
import os
import re
from pathlib import Path
from typing import Any
import asyncio
import httpx
from dotenv import load_dotenv
from fastapi import FastAPI, HTTPException
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel

from backend.risk_engine import score_alert

ROOT = Path(__file__).resolve().parents[1]
load_dotenv(ROOT / ".env")
LOCATION = {"latitude": 13.69, "longitude": 79.27, "name": "Seshachalam Hills sample zone"}
AI_API_KEY = os.getenv("AI_API_KEY", "").strip()
AI_MODEL = os.getenv("AI_MODEL", "").strip()
AI_BASE_URL = os.getenv("AI_BASE_URL", "").strip().rstrip("/")

app = FastAPI(title="Vanraksha API", version="0.1.0")


async def get_weather(client: httpx.AsyncClient) -> dict[str, Any]:
    response = await client.get(
        "https://api.open-meteo.com/v1/forecast",
        params={
            "latitude": LOCATION["latitude"],
            "longitude": LOCATION["longitude"],
            "current": "temperature_2m,relative_humidity_2m,precipitation,wind_speed_10m",
            "daily": "precipitation_probability_max,precipitation_sum,wind_speed_10m_max",
            "timezone": "Asia/Kolkata",
            "forecast_days": 1,
        },
    )
    response.raise_for_status()
    return response.json()


async def get_wildfires(client: httpx.AsyncClient) -> list[dict[str, Any]]:
    response = await client.get(
        "https://eonet.gsfc.nasa.gov/api/v3/events/geojson",
        params={"category": "wildfires", "status": "open", "days": 30, "limit": 100},
    )
    response.raise_for_status()
    return response.json().get("features", [])


def _positions(coordinates: Any) -> list[tuple[float, float]]:
    if not isinstance(coordinates, (list, tuple)):
        return []
    if (
        len(coordinates) >= 2
        and isinstance(coordinates[0], (int, float))
        and isinstance(coordinates[1], (int, float))
    ):
        return [(float(coordinates[0]), float(coordinates[1]))]
    return [point for child in coordinates for point in _positions(child)]


def _distance_km(lon1: float, lat1: float, lon2: float, lat2: float) -> float:
    earth_radius_km = 6371.0
    lat1_rad, lat2_rad = math.radians(lat1), math.radians(lat2)
    delta_lat = lat2_rad - lat1_rad
    delta_lon = math.radians(lon2 - lon1)
    haversine = (
        math.sin(delta_lat / 2) ** 2
        + math.cos(lat1_rad) * math.cos(lat2_rad) * math.sin(delta_lon / 2) ** 2
    )
    return 2 * earth_radius_km * math.asin(math.sqrt(min(1.0, haversine)))


def nearby_event_count(features: list[dict[str, Any]], radius_km: float = 50) -> int:
    count = 0
    for feature in features:
        geometry = feature.get("geometry") or {}
        positions = _positions(geometry.get("coordinates"))
        if any(
            _distance_km(LOCATION["longitude"], LOCATION["latitude"], lon, lat) <= radius_km
            for lon, lat in positions
        ):
            count += 1
    return count


@app.get("/api/health")
async def health() -> dict[str, str]:
    return {"status": "ok", "mode": "prototype"}


@app.get("/api/context")
async def context() -> dict[str, Any]:
    """Return live public weather and wildfire context plus an explainable score."""
    async with httpx.AsyncClient(timeout=12) as client:
        weather_result, wildfire_result = await asyncio.gather(
            get_weather(client), get_wildfires(client), return_exceptions=True
        )

    if isinstance(weather_result, Exception):
        return {
            "location": LOCATION,
            "sources": ["Open-Meteo", "NASA EONET"],
            "status": "degraded",
            "message": "Live weather data is temporarily unavailable. The demo remains usable.",
        }

    weather_data = weather_result
    wildfire_features = [] if isinstance(wildfire_result, Exception) else wildfire_result

    current = weather_data["current"]
    nearby_wildfires = nearby_event_count(wildfire_features)
    risk = score_alert(
        canopy_change=0.72,
        temperature_c=current.get("temperature_2m"),
        humidity_pct=current.get("relative_humidity_2m"),
        wind_kmh=current.get("wind_speed_10m"),
        nearby_wildfires=nearby_wildfires,
    )
    return {
        "location": LOCATION,
        "sources": ["Open-Meteo", "NASA EONET"],
        "status": "live" if not isinstance(wildfire_result, Exception) else "weather-only",
        "weather": {
            "temperature_c": current.get("temperature_2m"),
            "humidity_pct": current.get("relative_humidity_2m"),
            "wind_kmh": current.get("wind_speed_10m"),
            "rain_chance_pct": weather_data["daily"]["precipitation_probability_max"][0],
        },
        "nearby_open_wildfire_events": nearby_wildfires,
        "sample_alert_risk": {"score": risk.score, "level": risk.level, "reasons": risk.reasons},
        "limitations": [
            "Weather and wildfire data provide context; they do not confirm forest loss.",
            "The canopy-change value is sample prototype data, not a satellite model output.",
            "All cases require ranger review and field verification.",
        ],
    }


class BriefRequest(BaseModel):
    alert_id: str


@app.get("/api/ai/status")
async def ai_status() -> dict[str, Any]:
    configured = bool(AI_API_KEY and AI_MODEL and AI_BASE_URL)
    return {
        "configured": configured,
        "mode": "live" if configured else "demo",
        "missing_settings": [
            name for name, value in (
                ("AI_API_KEY", AI_API_KEY),
                ("AI_MODEL", AI_MODEL),
                ("AI_BASE_URL", AI_BASE_URL),
            ) if not value
        ],
    }


@app.post("/api/ai/brief")
async def ai_brief(request: BriefRequest) -> dict[str, str]:
    if not (AI_API_KEY and AI_MODEL and AI_BASE_URL):
        raise HTTPException(status_code=503, detail="AI is not configured; use demo mode.")

    if not re.fullmatch(r"CW-\d{3}", request.alert_id):
        raise HTTPException(status_code=400, detail="Unknown alert ID.")

    try:
        alerts = json.loads((ROOT / "data" / "demo-alerts.json").read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as error:
        raise HTTPException(status_code=500, detail="Alert data could not be loaded.") from error

    alert = next((item for item in alerts if item.get("id") == request.alert_id), None)
    if alert is None:
        raise HTTPException(status_code=404, detail="Alert not found.")

    payload = {
        "model": AI_MODEL,
        "temperature": 0.2,
        "messages": [
            {
                "role": "system",
                "content": (
                    "You assist forest rangers with cautious triage. Summarize only the "
                    "provided alert metadata, state that it is illustrative demo data, "
                    "and suggest verification steps. Do not claim to have compared "
                    "satellite images or determine legality."
                ),
            },
            {"role": "user", "content": json.dumps(alert)},
        ],
    }

    try:
        async with httpx.AsyncClient(timeout=30) as client:
            response = await client.post(
                f"{AI_BASE_URL}/chat/completions",
                headers={"Authorization": f"Bearer {AI_API_KEY}"},
                json=payload,
            )
            response.raise_for_status()
            result = response.json()
    except httpx.HTTPError as error:
        raise HTTPException(status_code=502, detail="Configured AI provider request failed.") from error
    except ValueError as error:
        raise HTTPException(status_code=502, detail="Configured AI provider returned invalid JSON.") from error

    try:
        brief = result["choices"][0]["message"]["content"]
    except (KeyError, IndexError, TypeError) as error:
        raise HTTPException(status_code=502, detail="Configured AI provider returned an unexpected response.") from error
    if not isinstance(brief, str) or not brief.strip():
        raise HTTPException(status_code=502, detail="Configured AI provider returned an empty brief.")

    return {"brief": brief.strip()}


app.mount("/", StaticFiles(directory=ROOT, html=True), name="frontend")
