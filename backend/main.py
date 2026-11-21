"""Vanraksha monitoring API.

The server is deliberately the only place that talks to Earth Engine and an
LLM provider. Browser code never receives an API key or a private key.
"""
from __future__ import annotations

import asyncio
import json
import logging
import math
import os
import secrets
import uuid
from datetime import date, datetime, timedelta, timezone
from pathlib import Path
from typing import Any, Literal

import httpx
from dotenv import load_dotenv
from fastapi import FastAPI, HTTPException, Query
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel, Field

from backend.risk_engine import score_alert

ROOT = Path(__file__).resolve().parents[1]
RUNTIME_DIR = ROOT / "runtime"
STATE_FILE = RUNTIME_DIR / "vanraksha-state.json"
load_dotenv(ROOT / ".env")
AI_API_KEY, AI_MODEL = os.getenv("AI_API_KEY", "").strip(), os.getenv("AI_MODEL", "").strip()
AI_BASE_URL = os.getenv("AI_BASE_URL", "").strip().rstrip("/")
GEE_PROJECT = os.getenv("GEE_PROJECT", "").strip()
GEE_SERVICE_ACCOUNT = os.getenv("GEE_SERVICE_ACCOUNT", "").strip()
GEE_PRIVATE_KEY = os.getenv("GEE_PRIVATE_KEY", "").replace("\\n", "\n").strip()
GOOGLE_MAPS_API_KEY = os.getenv("GOOGLE_MAPS_API_KEY", "").strip()
APP_ADMIN_USERNAME = os.getenv("APP_ADMIN_USERNAME", "admin").strip()
APP_ADMIN_PASSWORD = os.getenv("APP_ADMIN_PASSWORD", "admin").strip()
ACTIVE_SESSIONS: set[str] = set()
app = FastAPI(title="Vanraksha API", version="0.2.0")
LOGGER = logging.getLogger("vanraksha")


def now_iso() -> str:
    return datetime.now(timezone.utc).replace(microsecond=0).isoformat()


def default_state() -> dict[str, Any]:
    return {"zones": [], "alerts": [], "cases": [], "notifications": [], "scan_history": []}


def write_state(state: dict[str, Any]) -> None:
    RUNTIME_DIR.mkdir(exist_ok=True)
    temporary = STATE_FILE.with_suffix(".tmp")
    temporary.write_text(json.dumps(state, indent=2), encoding="utf-8")
    temporary.replace(STATE_FILE)


def read_state() -> dict[str, Any]:
    RUNTIME_DIR.mkdir(exist_ok=True)
    if not STATE_FILE.exists():
        state = default_state()
        write_state(state)
        return state
    try:
        return json.loads(STATE_FILE.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as error:
        raise HTTPException(status_code=500, detail="Local monitoring state is unreadable.") from error


def find_zone(state: dict[str, Any], zone_id: str) -> dict[str, Any]:
    zone = next((item for item in state["zones"] if item["id"] == zone_id), None)
    if zone is None:
        raise HTTPException(status_code=404, detail="Monitoring zone not found.")
    return zone


def add_notification(state: dict[str, Any], title: str, message: str, *, kind: str = "info") -> None:
    state["notifications"].insert(0, {"id": f"note-{uuid.uuid4().hex[:10]}", "title": title, "message": message,
                                      "kind": kind, "created_at": now_iso(), "read": False})


class ZoneRequest(BaseModel):
    name: str = Field(min_length=3, max_length=80)
    latitude: float = Field(ge=-90, le=90)
    longitude: float = Field(ge=-180, le=180)
    radius_km: int = Field(ge=1, le=50)


class CaseRequest(BaseModel):
    alert_id: str


class OutcomeRequest(BaseModel):
    outcome: Literal["confirmed", "not_confirmed", "insufficient_evidence"]
    reason: str = Field(min_length=5, max_length=1000)


class BriefRequest(BaseModel):
    alert_id: str


class LoginRequest(BaseModel):
    username: str = Field(min_length=1, max_length=80)
    password: str = Field(min_length=1, max_length=200)


async def get_weather(client: httpx.AsyncClient, latitude: float, longitude: float) -> dict[str, Any]:
    response = await client.get("https://api.open-meteo.com/v1/forecast", params={
        "latitude": latitude, "longitude": longitude,
        "current": "temperature_2m,relative_humidity_2m,precipitation,wind_speed_10m",
        "daily": "precipitation_probability_max", "timezone": "Asia/Kolkata", "forecast_days": 1,
    })
    response.raise_for_status()
    return response.json()


async def get_wildfires(client: httpx.AsyncClient) -> list[dict[str, Any]]:
    response = await client.get("https://eonet.gsfc.nasa.gov/api/v3/events/geojson",
                                params={"category": "wildfires", "status": "open", "days": 30, "limit": 100})
    response.raise_for_status()
    return response.json().get("features", [])


@app.post("/api/auth/login")
async def login(request: LoginRequest) -> dict[str, str]:
    """Prototype-only login. Replace with OAuth/SSO before production."""
    if not (secrets.compare_digest(request.username, APP_ADMIN_USERNAME) and
            secrets.compare_digest(request.password, APP_ADMIN_PASSWORD)):
        raise HTTPException(status_code=401, detail="Invalid username or password.")
    token = secrets.token_urlsafe(32)
    ACTIVE_SESSIONS.add(token)
    # This hackathon prototype intentionally has no database. Each new login
    # starts a clean monitoring session rather than showing stale test records.
    write_state(default_state())
    return {"token": token, "username": APP_ADMIN_USERNAME, "role": "Administrator"}


@app.get("/api/locations/search")
async def search_locations(q: str = Query(min_length=3, max_length=120)) -> dict[str, Any]:
    """Search a place using Google Geocoding when configured, otherwise OSM."""
    async with httpx.AsyncClient(timeout=12) as client:
        if GOOGLE_MAPS_API_KEY:
            response = await client.get(
                "https://maps.googleapis.com/maps/api/geocode/json",
                params={"address": q, "key": GOOGLE_MAPS_API_KEY},
            )
            response.raise_for_status()
            payload = response.json()
            results = [
                {
                    "name": item.get("formatted_address", "Unnamed location"),
                    "latitude": item["geometry"]["location"]["lat"],
                    "longitude": item["geometry"]["location"]["lng"],
                }
                for item in payload.get("results", [])[:6]
                if item.get("geometry", {}).get("location")
            ]
            return {"source": "Google Maps Geocoding", "results": results}

        response = await client.get(
            "https://nominatim.openstreetmap.org/search",
            params={"q": q, "format": "jsonv2", "limit": 6},
            headers={"User-Agent": "Vanraksha-Hackathon-Prototype/1.0"},
        )
        response.raise_for_status()
        results = [
            {"name": item.get("display_name", "Unnamed location"), "latitude": float(item["lat"]), "longitude": float(item["lon"])}
            for item in response.json()
        ]
        return {"source": "OpenStreetMap fallback (add GOOGLE_MAPS_API_KEY for Google Maps)", "results": results}


def positions(coordinates: Any) -> list[tuple[float, float]]:
    if not isinstance(coordinates, (list, tuple)):
        return []
    if len(coordinates) >= 2 and isinstance(coordinates[0], (int, float)) and isinstance(coordinates[1], (int, float)):
        return [(float(coordinates[0]), float(coordinates[1]))]
    return [point for child in coordinates for point in positions(child)]


def distance_km(lon1: float, lat1: float, lon2: float, lat2: float) -> float:
    radius = 6371.0
    a = math.sin(math.radians(lat2 - lat1) / 2) ** 2 + math.cos(math.radians(lat1)) * math.cos(math.radians(lat2)) * math.sin(math.radians(lon2 - lon1) / 2) ** 2
    return 2 * radius * math.asin(math.sqrt(min(1, a)))


def nearby_event_count(features: list[dict[str, Any]], latitude: float, longitude: float, radius_km: int = 50) -> int:
    return sum(1 for feature in features if any(distance_km(longitude, latitude, lon, lat) <= radius_km
               for lon, lat in positions((feature.get("geometry") or {}).get("coordinates"))))


def earth_engine_status() -> dict[str, Any]:
    service_account_ready = bool(GEE_SERVICE_ACCOUNT and GEE_PRIVATE_KEY)
    configured = bool(GEE_PROJECT)
    return {"configured": configured, "mode": "ready" if service_account_ready else ("user_auth_required" if configured else "setup_required"),
            "missing_settings": [name for name, value in (("GEE_PROJECT", GEE_PROJECT),) if not value],
            "authentication": "service_account" if service_account_ready else "interactive_google_sign_in",
            "source": "Google Earth Engine / Sentinel-2 SR Harmonized",
            "cadence": "Sentinel-2 observations are typically available every ~5 days; this is not live video."}


def satellite_change(zone: dict[str, Any]) -> dict[str, Any]:
    """Measure before/after NDVI and NBR over a circular monitoring zone."""
    status = earth_engine_status()
    if not status["configured"]:
        raise HTTPException(status_code=503, detail={"message": "Google Earth Engine is not configured.", "earth_engine": status})
    try:
        import ee
        if GEE_SERVICE_ACCOUNT and GEE_PRIVATE_KEY:
            credentials = ee.ServiceAccountCredentials(GEE_SERVICE_ACCOUNT, key_data=GEE_PRIVATE_KEY)
            ee.Initialize(credentials, project=GEE_PROJECT)
        else:
            # Local development uses the developer's Google sign-in.
            # Run earthengine authenticate once before starting the app.
            ee.Initialize(project=GEE_PROJECT)
        region = ee.Geometry.Point([zone["longitude"], zone["latitude"]]).buffer(zone["radius_km"] * 1000)
        end = date.today() - timedelta(days=2)
        recent_start, baseline_start = end - timedelta(days=30), end - timedelta(days=60)
        def clean(image: Any) -> Any:
            scl = image.select("SCL")
            mask = scl.neq(3).And(scl.neq(8)).And(scl.neq(9)).And(scl.neq(10)).And(scl.neq(11))
            return image.updateMask(mask).divide(10000)
        collection = ee.ImageCollection("COPERNICUS/S2_SR_HARMONIZED").filterBounds(region).filter(ee.Filter.lt("CLOUDY_PIXEL_PERCENTAGE", 35))
        recent, baseline = collection.filterDate(str(recent_start), str(end)).map(clean), collection.filterDate(str(baseline_start), str(recent_start)).map(clean)
        counts = ee.Dictionary({"recent": recent.size(), "baseline": baseline.size()}).getInfo()
        if not counts["recent"] or not counts["baseline"]:
            raise ValueError("Not enough cloud-screened Sentinel-2 scenes for a before/after comparison.")
        recent_img, baseline_img = recent.median(), baseline.median()
        ndvi_delta = recent_img.normalizedDifference(["B8", "B4"]).subtract(baseline_img.normalizedDifference(["B8", "B4"]))
        nbr_delta = recent_img.normalizedDifference(["B8", "B12"]).subtract(baseline_img.normalizedDifference(["B8", "B12"]))
        values = ee.Image.cat([ndvi_delta.rename("ndvi_delta"), nbr_delta.rename("nbr_delta")]).reduceRegion(
            reducer=ee.Reducer.mean(), geometry=region, scale=20, maxPixels=10_000_000, bestEffort=True).getInfo()
        return {"source": "Google Earth Engine Sentinel-2 SR Harmonized", "recent_scenes": counts["recent"], "baseline_scenes": counts["baseline"],
                "recent_window": f"{recent_start} to {end}", "baseline_window": f"{baseline_start} to {recent_start}",
                "ndvi_delta": float(values.get("ndvi_delta", 0)), "nbr_delta": float(values.get("nbr_delta", 0))}
    except HTTPException:
        raise
    except Exception as error:
        LOGGER.exception("Earth Engine scan failed for zone %s.", zone.get("name", "unknown"))
        message = str(error).strip()
        if not (GEE_SERVICE_ACCOUNT and GEE_PRIVATE_KEY):
            raise HTTPException(
                status_code=503,
                detail=(
                    "Earth Engine Google sign-in is incomplete or this project is not authorized. "
                    "Run earthengine authenticate in the Vanraksha folder, complete browser consent, "
                    "then restart the server."
                ),
            ) from error
        raise HTTPException(status_code=502, detail=f"Earth Engine scan failed: {message or 'unknown provider error'}") from error


@app.get("/api/health")
async def health() -> dict[str, Any]:
    return {"status": "ok", "earth_engine": earth_engine_status()["mode"]}


@app.get("/api/config/status")
async def config_status() -> dict[str, Any]:
    return {"earth_engine": earth_engine_status(), "ai": {"configured": bool(AI_API_KEY and AI_MODEL and AI_BASE_URL), "model": AI_MODEL or None}}


@app.get("/api/zones")
async def list_zones() -> list[dict[str, Any]]:
    return read_state()["zones"]


@app.post("/api/zones", status_code=201)
async def create_zone(request: ZoneRequest) -> dict[str, Any]:
    state = read_state()
    zone = {"id": f"zone-{uuid.uuid4().hex[:8]}", "name": request.name.strip(), "latitude": request.latitude,
            "longitude": request.longitude, "radius_km": request.radius_km, "created_at": now_iso(), "monitoring": True, "last_scan": None}
    state["zones"].append(zone)
    add_notification(state, "Monitoring started", f"{zone['name']} is saved as a {zone['radius_km']} km monitoring area.")
    write_state(state)
    return zone


@app.post("/api/zones/{zone_id}/scan")
async def scan_zone(zone_id: str) -> dict[str, Any]:
    state = read_state()
    zone = find_zone(state, zone_id)
    async with httpx.AsyncClient(timeout=12) as client:
        weather_result, fire_result = await asyncio.gather(get_weather(client, zone["latitude"], zone["longitude"]), get_wildfires(client), return_exceptions=True)
    weather = None if isinstance(weather_result, Exception) else weather_result.get("current")
    wildfire_count = 0 if isinstance(fire_result, Exception) else nearby_event_count(fire_result, zone["latitude"], zone["longitude"])
    satellite = await asyncio.to_thread(satellite_change, zone)
    canopy_change = max(0, min(1, -satellite["ndvi_delta"] / 0.20))
    risk = score_alert(canopy_change=canopy_change, temperature_c=weather.get("temperature_2m") if weather else None,
                       humidity_pct=weather.get("relative_humidity_2m") if weather else None,
                       wind_kmh=weather.get("wind_speed_10m") if weather else None, nearby_wildfires=wildfire_count)
    is_canopy_change, is_burn_change = satellite["ndvi_delta"] <= -0.08, satellite["nbr_delta"] <= -0.10
    zone["last_scan"] = now_iso()
    result = {"zone_id": zone_id, "scanned_at": zone["last_scan"], "satellite": satellite,
              "risk": {"score": risk.score, "level": risk.level, "reasons": risk.reasons}, "wildfires_nearby": wildfire_count}
    state["scan_history"].insert(0, result)
    if is_canopy_change or is_burn_change:
        kind = "possible burn scar" if is_burn_change else "possible canopy disturbance"
        alert = {"id": f"alert-{uuid.uuid4().hex[:8]}", "zone_id": zone_id, "title": f"{kind.title()} · {zone['name']}", "type": kind,
                 "priority": risk.level, "confidence": round(min(.95, max(.40, abs(satellite["ndvi_delta"]) * 4)), 2),
                 "created_at": now_iso(), "status": "needs_review", "evidence": satellite, "risk": result["risk"]}
        state["alerts"].insert(0, alert)
        add_notification(state, "New monitoring alert", f"{alert['title']} needs ranger review.", kind="alert")
        result["alert"] = alert
    else:
        add_notification(state, "Scan completed", f"No threshold breach was found in {zone['name']}.", kind="scan")
        result["alert"] = None
    write_state(state)
    return result


@app.get("/api/alerts")
async def list_alerts() -> list[dict[str, Any]]:
    return read_state()["alerts"]


@app.post("/api/cases", status_code=201)
async def create_case(request: CaseRequest) -> dict[str, Any]:
    state = read_state()
    alert = next((item for item in state["alerts"] if item["id"] == request.alert_id), None)
    if alert is None:
        raise HTTPException(status_code=404, detail="Alert not found.")
    existing = next((item for item in state["cases"] if item["alert_id"] == request.alert_id), None)
    if existing:
        return existing
    case = {"id": f"case-{uuid.uuid4().hex[:8]}", "alert_id": alert["id"], "title": alert["title"], "created_at": now_iso(),
            "status": "open", "outcome": None, "reason": None, "evidence": alert["evidence"], "review_history": []}
    state["cases"].insert(0, case)
    alert["status"] = "case_opened"
    add_notification(state, "Case file created", f"{case['id']} was created for {alert['title']}.", kind="case")
    write_state(state)
    return case


@app.get("/api/cases")
async def list_cases() -> list[dict[str, Any]]:
    return read_state()["cases"]


@app.post("/api/cases/{case_id}/outcome")
async def record_outcome(case_id: str, request: OutcomeRequest) -> dict[str, Any]:
    state = read_state()
    case = next((item for item in state["cases"] if item["id"] == case_id), None)
    if case is None:
        raise HTTPException(status_code=404, detail="Case file not found.")
    case.update({"status": "closed", "outcome": request.outcome, "reason": request.reason.strip()})
    case["review_history"].append({"at": now_iso(), "outcome": request.outcome, "reason": request.reason.strip()})
    add_notification(state, "Department outcome recorded", f"{case_id} was marked {request.outcome.replace('_', ' ')}.", kind="feedback")
    write_state(state)
    return case


@app.get("/api/notifications")
async def list_notifications() -> list[dict[str, Any]]:
    return read_state()["notifications"][:25]


@app.get("/api/learning/summary")
async def learning_summary() -> dict[str, Any]:
    cases = read_state()["cases"]
    closed = [item for item in cases if item.get("outcome")]
    return {"reviewed_cases": len(closed), "outcomes": {value: sum(item.get("outcome") == value for item in closed) for value in ("confirmed", "not_confirmed", "insufficient_evidence")},
            "message": "Reviewed outcomes can become a governed training dataset after quality checks; this prototype does not auto-retrain or automate enforcement."}


@app.get("/api/ai/status")
async def ai_status() -> dict[str, Any]:
    configured = bool(AI_API_KEY and AI_MODEL and AI_BASE_URL)
    return {"configured": configured, "mode": "live" if configured else "demo",
            "missing_settings": [name for name, value in (("AI_API_KEY", AI_API_KEY), ("AI_MODEL", AI_MODEL), ("AI_BASE_URL", AI_BASE_URL)) if not value]}


@app.post("/api/ai/brief")
async def ai_brief(request: BriefRequest) -> dict[str, str]:
    if not (AI_API_KEY and AI_MODEL and AI_BASE_URL):
        raise HTTPException(status_code=503, detail="AI is not configured; use demo mode.")
    alert = next((item for item in read_state()["alerts"] if item["id"] == request.alert_id), None)
    if alert is None:
        raise HTTPException(status_code=404, detail="Alert not found.")
    payload = {"alert": alert, "instruction": "Write a concise ranger brief. Use only supplied quantitative evidence. State satellite limitations, recommend verification, and never decide legality or enforcement."}
    try:
        async with httpx.AsyncClient(timeout=30) as client:
            response = await client.post(f"{AI_BASE_URL}/chat/completions", headers={"Authorization": f"Bearer {AI_API_KEY}"},
                json={"model": AI_MODEL, "temperature": .2, "messages": [{"role": "system", "content": "You are a cautious forest-monitoring assistant."}, {"role": "user", "content": json.dumps(payload)}]})
            response.raise_for_status()
            brief = response.json()["choices"][0]["message"]["content"]
    except (httpx.HTTPError, KeyError, IndexError, TypeError, ValueError) as error:
        raise HTTPException(status_code=502, detail="Configured AI provider request failed.") from error
    return {"brief": brief.strip()}


app.mount("/", StaticFiles(directory=ROOT, html=True), name="frontend")
