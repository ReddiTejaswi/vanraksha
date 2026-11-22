# Vanraksha — Forest Change Sentinel

Vanraksha helps forest guards and officers register a monitoring area, examine satellite-derived change signals, receive in-app alerts, and prepare a traceable case file for field verification.

It is a decision-support prototype. It does not prove illegality, identify a person, or initiate enforcement.

## What the prototype does

1. An officer enters a named location, latitude/longitude, and a 5, 10, 20, or 50 km radius.
2. The area is saved locally and can be scanned on demand.
3. Once Google Earth Engine is configured, the Python backend compares two cloud-screened 30-day Sentinel-2 windows over that area.
4. It calculates NDVI (vegetation) and NBR (burn-sensitive) change. Threshold breaches become possible canopy-disturbance or burn-scar alerts.
5. Live weather (Open-Meteo) and open wildfire events (NASA EONET) add context to an explainable priority score.
6. A detected alert creates an in-app notification. A guard can create a case file and the department can close it as confirmed, not confirmed, or insufficient evidence, with a reason.

Runtime records are stored locally in runtime/vanraksha-state.json. That folder is intentionally ignored by Git.

## Important detection scope

Sentinel-2 is suitable for broad vegetation and burn-change monitoring, not for every activity:

- It can flag possible canopy loss, vegetation disturbance, and burn-related changes after imagery becomes available.
- It cannot reliably detect individual people, illegal transport vehicles under forest canopy, poaching/animal killing, or prove that a change is illegal.
- A ranger must verify every alert using imagery review, protected-area rules, and field evidence.

## Run locally

Use the bundled Python or a Python 3.10+ environment. CI is configured to
smoke-test Python 3.10 through 3.15; Python 3.15 is the latest stable release:

~~~powershell
python -m pip install -r requirements.txt
python -m uvicorn backend.main:app --reload
~~~

Open http://127.0.0.1:8000. run.bat is also available on Windows.

## Google Earth Engine setup

Google Earth Engine is the satellite analysis service; Google Earth alone is only a viewer. Earth Engine requires a Google Cloud project with Earth Engine access enabled and registered.

1. Copy .env.example to .env.
2. Create/register a Google Cloud project for Earth Engine and enable the Earth Engine API for it. The account/service account that runs Vanraksha must have permission to use that project.
3. Add its Project ID to .env:

~~~env
GEE_PROJECT=your-google-cloud-project-id
~~~

4. For local development, authenticate Earth Engine once on that machine with the Earth Engine CLI, then sign in in Google's browser flow. Set `GEE_SERVICE_ACCOUNT_JSON` only for a hosted unattended server; use the complete service-account key JSON as a private environment secret, never in source control.
5. Restart the server and run a scan. The status label only describes which settings are present; a successful scan is what confirms credentials and access. Scans compare two cloud-screened 30-day windows from Sentinel-2 SR Harmonized. The source cadence is roughly five days, weather/clouds permitting; it is not real-time video.

For a hosted deployment, register/enable Earth Engine on the Cloud project, create a service account with the minimum required Earth Engine access, and grant that service account access to use the registered project. Put the complete JSON key in the host's secret settings as `GEE_SERVICE_ACCOUNT_JSON` and set `GEE_PROJECT`. Prefer a platform identity/Workload Identity over downloadable keys when the hosting platform supports it. Never paste a private key into chat or commit it.

If any API keys have been shared in chat or other public places, rotate them in their provider consoles and replace them only in local or deployment secret settings.

This secure local sign-in is preferred to creating a downloadable service-account key. Do not commit .env, credentials, or case records.

## AI: where it is and is not used

### Suitable AI use

- Satellite measurement: deterministic cloud masking plus NDVI/NBR before/after change features are the initial detector.
- Optional LLM Ranger Brief: an OpenAI-compatible model receives only a generated alert and quantitative evidence, then writes a short, cautious verification brief.
- Future learning loop: outcome labels and reasons from authorised departmental reviewers can be quality-checked, de-identified where necessary, evaluated for false positives/missed events, and used to retrain the prioritisation model.

For an LLM brief, set AI_API_KEY, AI_MODEL, and AI_BASE_URL in .env. A capable low-cost text model is sufficient because it summarises structured measurements; it should not replace satellite change detection. If later adding visual review of exported before/after chips, use a vision-capable model only as a secondary analyst, not as evidence of illegality.

### Not AI

- Google Earth Engine retrieves/processes satellite data.
- Open-Meteo and NASA EONET retrieve public context.
- Rules create a case file and in-app notification.
- Department outcomes, legality, and enforcement decisions remain human responsibilities.

## Tech stack

- Frontend: HTML, CSS, vanilla JavaScript
- Backend: Python, FastAPI, Uvicorn, HTTPX
- Satellite analysis: Google Earth Engine Python API, Sentinel-2 SR Harmonized
- Context: Open-Meteo + NASA EONET
- Optional assistant: OpenAI-compatible chat-completions endpoint

## Current implementation boundaries

- Monitoring is on-demand in this prototype; production use needs a scheduled worker, user login/roles, a database, secure audit storage, protected-area boundaries, and notification delivery.
- The current 30-day thresholds are starting triage rules, not a validated operational model. They need local calibration and evaluation using ranger-reviewed cases.
- Saved areas are circles. A production version should also support drawing/uploading true forest-boundary polygons.
