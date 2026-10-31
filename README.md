# Vanraksha - Forest change monitoring prototype

Vanraksha is a prototype for requesting forest-area monitoring, reviewing potential changes, and preparing evidence for ranger follow-up. The current build is a demonstration, not an operational satellite-monitoring service.

## Run the prototype

From this folder, run `run.bat`, then open http://127.0.0.1:8000. The first run installs the packages in `requirements.txt`.

You can also open `index.html` directly. Direct-file mode shows sample alerts and tries public weather and wildfire feeds in the browser. Use the `Demo` switch in the header to choose between sample context and live context with AI-generated briefs.

## AI brief mode

Use the `Demo` checkbox in the header to switch between illustrative sample context and AI briefs. Demo mode is on by default and its preference is saved in this browser. Turn it off to request an AI-generated Ranger Brief; this requires all provider settings below. If AI is not configured, the brief reports that clearly rather than silently switching back to a demo response. The Change alerts and Monitoring zones are still illustrative records in either mode: AI does not detect forest changes, verify evidence, or create live notifications.

1. Copy `.env.example` to `.env`.
2. Set `AI_API_KEY`, `AI_MODEL`, and `AI_BASE_URL` (for example, `https://api.openai.com/v1`).
3. Restart the server.

The key is read by the backend and is never sent to the browser. The live brief endpoint currently sends only the selected sample alert's metadata. It does **not** compare satellite images, detect a real change, or create live notifications.

## Intended monitoring workflow

1. A ranger requests a monitoring zone by drawing or uploading a boundary and setting a monitoring period.
2. The system validates the area and schedules satellite-image acquisition for that area.
3. A change-detection pipeline compares cloud-screened, time-aligned imagery and flags candidate changes. A computer-vision/change-detection model should produce measurable evidence; a language model should not be treated as the image detector.
4. The system records evidence and provenance (source, acquisition dates, boundary, affected area, model/version, confidence, and quality limitations) and sends a configurable alert.
5. A ranger reviews the alert, adds field observations, and exports a case file containing the evidence and review history.

Alerts are decision support only. AI must not decide whether activity is illegal or initiate enforcement. Human review and field verification remain required.

## Current prototype coverage

- Three hard-coded sample alerts and an illustrative map.
- Review toggle and JSON download for a sample case file.
- Public Open-Meteo weather and NASA EONET wildfire context.
- Explainable sample risk score; it is not a trained or validated satellite model.
- Optional AI-generated text brief from sample alert metadata, controlled by the `Demo` toggle.
- Sidebar views for Overview, Change alerts, Case files, and Monitoring zones.

## Known gaps before operational use

- Users cannot yet submit or persist monitoring zones; the map, boundary, coordinates, alerts, and confidence values are illustrative.
- There is no satellite imagery ingestion, before/after image comparison, validated change-detection model, scheduled monitoring, or notification delivery.
- Case files are downloads generated from fixed demo records; cases and review status are not stored in a database.
- Weather and wildfire context do not validate forest loss. External imagery/data access, cloud masking, seasonal normalization, accuracy evaluation, retention/privacy controls, and ranger field verification still need to be designed and tested.

## Stack

- Frontend: HTML, CSS, and vanilla JavaScript
- Backend: Python, FastAPI, Uvicorn, and HTTPX
- Optional AI text brief: server-side OpenAI-compatible chat-completions API
- Public context: Open-Meteo and NASA EONET
