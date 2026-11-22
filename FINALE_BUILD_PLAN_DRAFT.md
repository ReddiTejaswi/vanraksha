# Vanraksha Finale Build Plan

## Purpose

Turn the submitted forest-monitoring prototype into a usable MVP that helps forest teams review possible vegetation disturbance and record verified outcomes. The plan extends the existing Vanraksha idea; it does not change the problem statement.

## What makes Vanraksha distinct

Vanraksha is designed around the forest-protection workflow: forest teams monitor selected zones, review possible canopy or burn disturbances, record field verification, and maintain a case history for follow-up.

SIH26227 describes a broader satellite archive discovery platform centered on natural-language and image-to-image search, similar-site discovery, and offline imagery indexing across multiple change types. Vanraksha may use satellite change analysis as an input, but its primary product is the ranger alert-review and case-follow-up workflow.

## Where we are now

The submitted `main` branch is a dashboard prototype with illustrative alerts and map, sample case downloads, an explainable but unvalidated score, and an optional OpenAI-compatible text brief. The `gandharvam-live-monitoring` implementation now adds working Google Earth Engine access through the configured Cloud project, on-demand Sentinel-2 analysis, true-colour and false-colour previews, NDVI and NBR change heatmaps, historical comparison windows, live weather and NASA wildfire context, and explicit source and scene metadata.

The live satellite result is a triage signal, not a validated detection or proof of illegal activity. The current prototype has no database, and local records reset when a new session is started. Sarvam AI is selected for the finale Ranger Brief integration and remains to be integrated.

## What we will deliver by 12 PM, 22 November

1. A live, evaluator-accessible Vanraksha build based on the submitted prototype, with a clearly labelled demo dataset and seeded walkthrough. The primary ranger journey will cover sign in, forest-zone registration, an on-demand satellite scan, review of true-colour and false-colour evidence, inspection of NDVI and NBR change heatmaps, case creation, review outcome recording, and provenance-rich export.
2. A second working journey for a forest control-room supervisor: view a prioritized queue, filter by zone and status, and review case outcomes and unresolved alerts.
3. On-demand satellite comparison for a selected forest zone using Sentinel-2 Surface Reflectance Harmonized imagery. Show source, acquisition windows, cloud-screened scene counts, quality limits, vegetation-change measurements, and threshold rationale. Label the result as an "unvalidated triage signal." Support historical `end_date` and comparison-window inputs. Use similar seasonal windows where feasible and avoid presenting a derived score as probability.
4. Persist records in a real database; enforce authentication on API routes; validate inputs and present actionable errors. If deployment constraints prevent durable storage, disclose that limitation and keep the demo dataset reproducible.
5. Integrate Sarvam AI into the core Ranger Brief flow: generate a concise verification brief from the alert measurements and provide a Telugu version for local-language ranger use. Show the source evidence and retain human review. AI will not detect imagery or decide legality. If the API is unavailable, show a clearly labelled sample brief and disclose the dependency.

## Users and use cases

| Segment | Use cases | MVP status |
|---|---|---|
| Forest ranger / beat officer (primary) | Review a possible canopy or burn change; create a case and record field verification | Working target |
| Forest control-room supervisor | Triage alerts across zones; track open cases and outcomes | Working target |
| Forest department analyst / planning officer | Compare repeat disturbance patterns; export provenance-rich evidence for planning | Partial or planned |

These are proposed segments. We will validate their roles and workflows with at least three people from the target segments during the finale and update the plan after Mentor Round 1 if needed.

## Partner technology

Sarvam AI addresses the language-access need in the primary ranger workflow. The integration must be visible in the live demo, such as a Telugu Ranger Brief generated from the same evidence shown in the case. A brief is assistance for review, not evidence or an enforcement decision.

## Definition of done

An evaluator can independently register a forest zone, inspect a qualified satellite-change result with before or after imagery and source limits, create and close a provenance-bearing case, and obtain a Ranger Brief. A supervisor can review the queue and outcomes.

## Scope and evidence guardrails

We will not claim validated detection, continuous monitoring, production security, or real-time imagery. Sentinel-2 observations are periodic and weather-dependent. Thresholds and derived scores require evaluation against reviewed cases. A possible change does not establish illegality; ranger verification remains required.

User, payer, pricing, market-size, and customer-validation claims belong in the separate Market Fit Canvas and will be supported by named interviews or cited sources rather than invented here.

## Approval

Mentor Round 1 sign-off is required before this plan is locked.
