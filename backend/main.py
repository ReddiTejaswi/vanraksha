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
from fastapi import Depends, FastAPI, Header, HTTPException, Query
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel, Field

from backend.risk_engine import score_alert

ROOT = Path(__file__).resolve().parents[1]
RUNTIME_DIR = ROOT / "runtime"
STATE_FILE = RUNTIME_DIR / "vanraksha-state.json"
load_dotenv(ROOT / ".env")
AI_API_KEY, AI_MODEL = os.getenv("AI_API_KEY", "").strip(), os.getenv("AI_MODEL", "").strip()
AI_BASE_URL = os.getenv("AI_BASE_URL", "").strip().rstrip("/")
SARVAM_API_KEY = os.getenv("SARVAM_API_KEY", "").strip()
SARVAM_MODEL = os.getenv("SARVAM_MODEL", "sarvam-105b-conversations").strip()
SARVAM_BASE_URL = os.getenv("SARVAM_BASE_URL", "https://api.sarvam.ai/v1").strip().rstrip("/")
GEE_PROJECT = os.getenv("GEE_PROJECT", "").strip()
GEE_SERVICE_ACCOUNT = os.getenv("GEE_SERVICE_ACCOUNT", "").strip()
GEE_PRIVATE_KEY = os.getenv("GEE_PRIVATE_KEY", "").replace("\\n", "\n").strip()
GEE_SERVICE_ACCOUNT_JSON = os.getenv("GEE_SERVICE_ACCOUNT_JSON", "").strip()
GOOGLE_MAPS_API_KEY = os.getenv("GOOGLE_MAPS_API_KEY", "").strip()
APP_ADMIN_USERNAME = os.getenv("APP_ADMIN_USERNAME", "admin").strip()
APP_ADMIN_PASSWORD = os.getenv("APP_ADMIN_PASSWORD", "admin").strip()
ACTIVE_SESSIONS: set[str] = set()
app = FastAPI(title="Vanraksha API", version="0.2.0")
LOGGER = logging.getLogger("vanraksha")


def require_session(authorization: str | None = Header(default=None)) -> str:
    """Require the short-lived prototype session for app data routes."""
    token = authorization.removeprefix("Bearer ").strip() if authorization else ""
    if not token or token not in ACTIVE_SESSIONS:
        raise HTTPException(status_code=401, detail="Sign in to access Vanraksha data.")
    return token


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


class ChatRequest(BaseModel):
    alert_id: str
    message: str = Field(min_length=2, max_length=1000)
    history: list[dict[str, str]] = Field(default_factory=list, max_length=12)


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
async def search_locations(q: str = Query(min_length=3, max_length=120), _: str = Depends(require_session)) -> dict[str, Any]:
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
    service_account_configured = bool(GEE_SERVICE_ACCOUNT_JSON or (GEE_SERVICE_ACCOUNT and GEE_PRIVATE_KEY))
    project_configured = bool(GEE_PROJECT)
    if not project_configured:
        mode = "setup_required"
    elif service_account_configured:
        mode = "service_account_configured"
    else:
        mode = "local_oauth_expected"
    missing_settings = []
    if not project_configured:
        missing_settings.append("GEE_PROJECT")
    return {"configured": project_configured, "mode": mode,
            "missing_settings": missing_settings,
            "authentication": "service_account" if service_account_configured else "local_oauth",
            "source": "Google Earth Engine / Sentinel-2 SR Harmonized",
            "cadence": "Sentinel-2 observations are typically available every ~5 days; this is not live video.",
            "note": "Configured means a project ID is present. A successful scan is required to verify access."}


class EarthEngineAuthError(Exception):
    """Earth Engine credentials or project access could not be initialized."""


class EarthEngineDataUnavailable(Exception):
    """The requested periods contain no usable satellite pixels."""


def initialize_earth_engine(ee: Any) -> None:
    if GEE_SERVICE_ACCOUNT_JSON:
        try:
            key_data = json.loads(GEE_SERVICE_ACCOUNT_JSON)
        except json.JSONDecodeError as error:
            raise EarthEngineAuthError("GEE_SERVICE_ACCOUNT_JSON must contain the downloaded service-account JSON key.") from error
        email = key_data.get("client_email")
        if not email:
            raise EarthEngineAuthError("The service-account JSON is missing client_email.")
        credentials = ee.ServiceAccountCredentials(email, key_data=json.dumps(key_data))
        ee.Initialize(credentials, project=GEE_PROJECT)
        return

    if GEE_SERVICE_ACCOUNT and GEE_PRIVATE_KEY:
        # Build the service-account key JSON expected by the Earth Engine client.
        key_data = {
            "type": "service_account",
            "project_id": GEE_PROJECT,
            "private_key": GEE_PRIVATE_KEY,
            "client_email": GEE_SERVICE_ACCOUNT,
            "token_uri": "https://oauth2.googleapis.com/token",
        }
        credentials = ee.ServiceAccountCredentials(GEE_SERVICE_ACCOUNT, key_data=json.dumps(key_data))
        ee.Initialize(credentials, project=GEE_PROJECT)
        return

    # Local development uses the developer's Earth Engine OAuth credentials.
    # Authenticate once with the Earth Engine CLI on this same machine.
    ee.Initialize(project=GEE_PROJECT)


def satellite_change(zone: dict[str, Any], *, comparison_end: str | None = None, window_days: int = 30) -> dict[str, Any]:
    """Measure before/after NDVI and NBR over a circular monitoring zone."""
    status = earth_engine_status()
    if not status["configured"]:
        raise HTTPException(status_code=503, detail={"message": "Google Earth Engine is not configured.", "earth_engine": status})
    try:
        import ee
        try:
            initialize_earth_engine(ee)
        except Exception as error:
            raise EarthEngineAuthError(str(error).strip() or "Earth Engine authentication failed.") from error
        region = ee.Geometry.Point([zone["longitude"], zone["latitude"]]).buffer(zone["radius_km"] * 1000)
        end = date.fromisoformat(comparison_end) if comparison_end else date.today() - timedelta(days=2)
        window_days = max(14, min(window_days, 90))
        recent_start, baseline_start = end - timedelta(days=window_days), end - timedelta(days=window_days * 2)
        def clean(image: Any) -> Any:
            scl = image.select("SCL")
            mask = scl.neq(3).And(scl.neq(8)).And(scl.neq(9)).And(scl.neq(10)).And(scl.neq(11))
            return image.updateMask(mask).divide(10000)
        collection = ee.ImageCollection("COPERNICUS/S2_SR_HARMONIZED").filterBounds(region).filter(ee.Filter.lt("CLOUDY_PIXEL_PERCENTAGE", 35))
        recent, baseline = collection.filterDate(str(recent_start), str(end)).map(clean), collection.filterDate(str(baseline_start), str(recent_start)).map(clean)
        counts = ee.Dictionary({"recent": recent.size(), "baseline": baseline.size()}).getInfo()
        if not counts["recent"] or not counts["baseline"]:
            raise EarthEngineDataUnavailable("Not enough cloud-screened Sentinel-2 scenes in both comparison windows.")
        recent_img, baseline_img = recent.median(), baseline.median()
        ndvi_delta = recent_img.normalizedDifference(["B8", "B4"]).subtract(baseline_img.normalizedDifference(["B8", "B4"]))
        nbr_delta = recent_img.normalizedDifference(["B8", "B12"]).subtract(baseline_img.normalizedDifference(["B8", "B12"]))
        values = ee.Image.cat([ndvi_delta.rename("ndvi_delta"), nbr_delta.rename("nbr_delta")]).reduceRegion(
            reducer=ee.Reducer.mean(), geometry=region, scale=20, maxPixels=10_000_000, bestEffort=True).getInfo()
        if not values or values.get("ndvi_delta") is None or values.get("nbr_delta") is None:
            raise EarthEngineDataUnavailable("No valid pixels remained after cloud and quality masking. Try a different area or scan later.")
        true_colour = {"bands": ["B4", "B3", "B2"], "min": 0, "max": 0.30, "gamma": 1.15}
        infrared = {"bands": ["B8", "B4", "B3"], "min": 0, "max": 0.35, "gamma": 1.15}
        change_style = {"min": -0.30, "max": 0.30, "palette": ["#b2182b", "#ef8a62", "#f7f7f7", "#67a9cf", "#2166ac"]}
        def render(image: Any, style: dict[str, Any]) -> dict[str, Any]:
            thumb = image.getThumbURL({"region": region, "dimensions": 900, "format": "png", **style})
            layer = image.getMapId(style)
            return {"thumbnail_url": thumb, "tile_url": layer.get("tile_fetcher").url_format if layer.get("tile_fetcher") else None}
        true_colour_render = render(recent_img, true_colour)
        baseline_true_colour_render = render(baseline_img, true_colour)
        infrared_render = render(recent_img, infrared)
        ndvi_render = render(ndvi_delta, change_style)
        nbr_render = render(nbr_delta, change_style)
        hotspots = []
        try:
            # Vectorization is deliberately best-effort: large monitoring zones
            # can contain too many changed pixels for a detailed geometry query.
            hotspot_mask = ndvi_delta.lte(-0.08).Or(nbr_delta.lte(-0.10)).selfMask()
            hotspot_image = hotspot_mask.rename("change")
            vector_scale = 60 if zone["radius_km"] >= 20 else 20
            hotspot_vectors = hotspot_image.reduceToVectors(
                geometry=region, scale=vector_scale, geometryType="polygon", eightConnected=True,
                labelProperty="change", maxPixels=2_000_000, bestEffort=True
            ).limit(8)
            hotspot_info = hotspot_vectors.getInfo().get("features", [])
            for feature in hotspot_info:
                geometry = ee.Geometry(feature.get("geometry"))
                coords = geometry.centroid(1).coordinates().getInfo()
                if not isinstance(coords, list) or len(coords) < 2:
                    continue
                hotspots.append({"latitude": round(float(coords[1]), 6), "longitude": round(float(coords[0]), 6),
                                 "approx_area_ha": round(float(geometry.area(1).getInfo()) / 10_000, 2),
                                 "reason": "NDVI or NBR crossed the alert threshold"})
        except Exception as error:
            LOGGER.warning("Hotspot geometry unavailable for zone %s: %s", zone.get("name", "unknown"), error)
        return {"source": "Google Earth Engine Sentinel-2 SR Harmonized", "recent_scenes": counts["recent"], "baseline_scenes": counts["baseline"],
                "recent_window": f"{recent_start} to {end}", "baseline_window": f"{baseline_start} to {recent_start}",
                "ndvi_delta": float(values["ndvi_delta"]), "nbr_delta": float(values["nbr_delta"]),
                "preview": {"true_colour": {**true_colour_render, "label": "Recent true-colour Sentinel-2 composite"},
                            "baseline_true_colour": {**baseline_true_colour_render, "label": "Baseline true-colour Sentinel-2 composite"},
                            "infrared": {**infrared_render, "label": "False-colour near-infrared composite"},
                            "ndvi_change": {**ndvi_render, "label": "NDVI change heatmap (red = decrease)"},
                            "nbr_change": {**nbr_render, "label": "NBR change heatmap (red = decrease)"},
                            "hotspots": hotspots,
                            # Backward-compatible default for existing clients.
                            "thumbnail_url": true_colour_render["thumbnail_url"], "tile_url": true_colour_render["tile_url"],
                            "label": "True-colour Sentinel-2 composite"}}
    except HTTPException:
        raise
    except EarthEngineAuthError as error:
        LOGGER.warning("Earth Engine authentication failed: %s", error)
        raise HTTPException(status_code=503, detail=f"Earth Engine authentication or project access failed: {error}") from error
    except EarthEngineDataUnavailable as error:
        raise HTTPException(status_code=422, detail=str(error)) from error
    except Exception as error:
        LOGGER.exception("Earth Engine scan failed for zone %s.", zone.get("name", "unknown"))
        message = str(error).strip()
        raise HTTPException(status_code=502, detail=f"Earth Engine scan failed while querying Sentinel-2: {message or 'unknown provider error'}") from error


@app.get("/api/health")
async def health() -> dict[str, Any]:
    return {"status": "ok", "earth_engine": earth_engine_status()["mode"]}


@app.get("/api/config/status")
async def config_status() -> dict[str, Any]:
    return {"earth_engine": earth_engine_status(), "ai": {"configured": bool(SARVAM_API_KEY and SARVAM_MODEL) or bool(AI_API_KEY and AI_MODEL and AI_BASE_URL),
            "provider": "Sarvam AI" if SARVAM_API_KEY else ("Generic OpenAI-compatible" if AI_API_KEY else None),
            "model": SARVAM_MODEL if SARVAM_API_KEY else (AI_MODEL or None)}}


@app.get("/api/zones")
async def list_zones(_: str = Depends(require_session)) -> list[dict[str, Any]]:
    return read_state()["zones"]


@app.post("/api/zones", status_code=201)
async def create_zone(request: ZoneRequest, _: str = Depends(require_session)) -> dict[str, Any]:
    state = read_state()
    zone = {"id": f"zone-{uuid.uuid4().hex[:8]}", "name": request.name.strip(), "latitude": request.latitude,
            "longitude": request.longitude, "radius_km": request.radius_km, "created_at": now_iso(), "monitoring": True, "last_scan": None}
    state["zones"].append(zone)
    add_notification(state, "Monitoring started", f"{zone['name']} is saved as a {zone['radius_km']} km monitoring area.")
    write_state(state)
    return zone


@app.post("/api/zones/{zone_id}/scan")
async def scan_zone(zone_id: str, end_date: str | None = Query(default=None, alias="end_date"), window_days: int = Query(default=30, ge=14, le=90), _: str = Depends(require_session)) -> dict[str, Any]:
    state = read_state()
    zone = find_zone(state, zone_id)
    async with httpx.AsyncClient(timeout=12) as client:
        weather_result, fire_result = await asyncio.gather(get_weather(client, zone["latitude"], zone["longitude"]), get_wildfires(client), return_exceptions=True)
    weather = None if isinstance(weather_result, Exception) else weather_result.get("current")
    wildfire_count = None if isinstance(fire_result, Exception) else nearby_event_count(fire_result, zone["latitude"], zone["longitude"])
    satellite = await asyncio.to_thread(satellite_change, zone, comparison_end=end_date, window_days=window_days)
    canopy_change = max(0, min(1, -satellite["ndvi_delta"] / 0.20))
    risk = score_alert(canopy_change=canopy_change, temperature_c=weather.get("temperature_2m") if weather else None,
                       humidity_pct=weather.get("relative_humidity_2m") if weather else None,
                       wind_kmh=weather.get("wind_speed_10m") if weather else None, nearby_wildfires=wildfire_count)
    is_canopy_change, is_burn_change = satellite["ndvi_delta"] <= -0.08, satellite["nbr_delta"] <= -0.10
    zone["last_scan"] = now_iso()
    result = {"zone_id": zone_id, "scanned_at": zone["last_scan"], "satellite": satellite,
              "risk": {"score": risk.score, "level": risk.level, "reasons": risk.reasons},
              "context": {"weather": {"status": "available" if weather else "unavailable", "source": "Open-Meteo"},
                          "wildfires": {"status": "available" if wildfire_count is not None else "unavailable",
                                        "source": "NASA EONET", "nearby_count": wildfire_count}}}
    state["scan_history"].insert(0, result)
    if is_canopy_change or is_burn_change:
        kind = "possible burn scar" if is_burn_change else "possible canopy disturbance"
        alert = {"id": f"alert-{uuid.uuid4().hex[:8]}", "zone_id": zone_id, "title": f"{kind.title()} · {zone['name']}", "type": kind,
                 "priority": risk.level,
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
async def list_alerts(_: str = Depends(require_session)) -> list[dict[str, Any]]:
    return read_state()["alerts"]


@app.post("/api/cases", status_code=201)
async def create_case(request: CaseRequest, _: str = Depends(require_session)) -> dict[str, Any]:
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
async def list_cases(_: str = Depends(require_session)) -> list[dict[str, Any]]:
    return read_state()["cases"]


@app.post("/api/cases/{case_id}/outcome")
async def record_outcome(case_id: str, request: OutcomeRequest, _: str = Depends(require_session)) -> dict[str, Any]:
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
async def list_notifications(_: str = Depends(require_session)) -> list[dict[str, Any]]:
    return read_state()["notifications"][:25]


@app.get("/api/learning/summary")
async def learning_summary(_: str = Depends(require_session)) -> dict[str, Any]:
    cases = read_state()["cases"]
    closed = [item for item in cases if item.get("outcome")]
    return {"reviewed_cases": len(closed), "outcomes": {value: sum(item.get("outcome") == value for item in closed) for value in ("confirmed", "not_confirmed", "insufficient_evidence")},
            "message": "Reviewed outcomes can become a governed training dataset after quality checks; this prototype does not auto-retrain or automate enforcement."}


@app.get("/api/ai/status")
async def ai_status() -> dict[str, Any]:
    sarvam_configured = bool(SARVAM_API_KEY and SARVAM_MODEL)
    generic_configured = bool(AI_API_KEY and AI_MODEL and AI_BASE_URL)
    return {"configured": sarvam_configured or generic_configured,
            "provider": "Sarvam AI" if sarvam_configured else ("Generic OpenAI-compatible" if generic_configured else None),
            "mode": "live" if sarvam_configured or generic_configured else "demo",
            "model": SARVAM_MODEL if sarvam_configured else (AI_MODEL or None),
            "missing_settings": [] if sarvam_configured or generic_configured else ["SARVAM_API_KEY", "SARVAM_MODEL"]}


@app.post("/api/ai/brief")
async def ai_brief(request: BriefRequest, _: str = Depends(require_session)) -> dict[str, str]:
    use_sarvam = bool(SARVAM_API_KEY and SARVAM_MODEL)
    if not use_sarvam and not (AI_API_KEY and AI_MODEL and AI_BASE_URL):
        raise HTTPException(status_code=503, detail="AI is not configured; use demo mode.")
    alert = next((item for item in read_state()["alerts"] if item["id"] == request.alert_id), None)
    if alert is None:
        raise HTTPException(status_code=404, detail="Alert not found.")
    payload = {"alert": alert, "instruction": "Write a concise ranger brief. Use only supplied quantitative evidence. State satellite limitations, recommend verification, and never decide legality or enforcement."}
    try:
        base_url = SARVAM_BASE_URL if use_sarvam else AI_BASE_URL
        headers = {"api-subscription-key": SARVAM_API_KEY} if use_sarvam else {"Authorization": f"Bearer {AI_API_KEY}"}
        async with httpx.AsyncClient(timeout=30) as client:
            response = await client.post(f"{base_url}/chat/completions", headers=headers,
                json={"model": SARVAM_MODEL if use_sarvam else AI_MODEL, "temperature": .2,
                      "max_tokens": 500, "reasoning_effort": None,
                      "messages": [{"role": "system", "content": "You are a cautious forest-monitoring assistant. Write a concise ranger verification brief. Never claim a fire or illegality as proven."}, {"role": "user", "content": json.dumps(payload)}]})
            response.raise_for_status()
            brief = response.json()["choices"][0]["message"]["content"]
    except (httpx.HTTPError, KeyError, IndexError, TypeError, ValueError) as error:
        raise HTTPException(status_code=502, detail="Configured AI provider request failed.") from error
    return {"brief": brief.strip()}


@app.post("/api/ai/chat")
async def ai_chat(request: ChatRequest, _: str = Depends(require_session)) -> dict[str, str]:
    """Answer a ranger question using only one live alert's evidence."""
    use_sarvam = bool(SARVAM_API_KEY and SARVAM_MODEL)
    if not use_sarvam and not (AI_API_KEY and AI_MODEL and AI_BASE_URL):
        return {"reply": "The Ranger Assistant is not configured. Review the alert layers and field-check points manually."}
    alert = next((item for item in read_state()["alerts"] if item["id"] == request.alert_id), None)
    if alert is None:
        raise HTTPException(status_code=404, detail="Live alert not found.")
    base_url = SARVAM_BASE_URL if use_sarvam else AI_BASE_URL
    headers = {"api-subscription-key": SARVAM_API_KEY} if use_sarvam else {"Authorization": f"Bearer {AI_API_KEY}"}
    messages = [{"role": "system", "content": "You are Vanraksha's cautious ranger assistant. Use only the supplied alert evidence. Answer briefly and clearly. Never invent coordinates, claim a fire or illegality is proven, or replace field verification."}]
    messages.extend(request.history[-10:])
    messages.append({"role": "user", "content": json.dumps({"alert": alert, "question": request.message})})
    try:
        async with httpx.AsyncClient(timeout=30) as client:
            response = await client.post(f"{base_url}/chat/completions", headers=headers,
                json={"model": SARVAM_MODEL if use_sarvam else AI_MODEL, "temperature": .2, "max_tokens": 500, "reasoning_effort": None, "messages": messages})
            response.raise_for_status()
            return {"reply": response.json()["choices"][0]["message"]["content"]}
    except (httpx.HTTPError, KeyError, IndexError, TypeError, ValueError) as error:
        raise HTTPException(status_code=502, detail="Configured AI provider request failed.") from error


app.mount("/", StaticFiles(directory=ROOT, html=True), name="frontend")
