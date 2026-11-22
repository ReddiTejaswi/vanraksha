Register monitoring zone
        ↓
Run satellite scan
        ↓
Store scan result
        ↓
No threshold breach?
   ├─ Yes → show “No significant change detected”
   └─ No → create live alert
                  ↓
          Review satellite evidence
          - Recent image
          - Baseline image
          - Infrared image
          - NDVI/NBR heatmaps
          - Hotspot coordinates
                  ↓
          Generate Sarvam Ranger Brief
                  ↓
          Ranger decides whether to create a case
                  ↓
          Create case file
                  ↓
          Field verification
                  ↓
          Record outcome and reason
                  ↓
          Export final case report



How to read the heatmap
1. Start with the true-colour image to understand the actual landscape.
2. Compare it with the baseline image from the earlier period.
3. Open the NDVI change layer:
   - Red/orange: vegetation greenness decreased
   - Green/blue: vegetation increased or remained stable
4. Open the NBR change layer:
   - Red areas: possible burn-related or canopy-surface change
   - Neutral areas: little detected change



NDVI = (NIR − Red) / (NIR + Red)

NDVI delta = Recent NDVI − Baseline NDVI


NBR = (NIR − SWIR2) / (NIR + SWIR2)

NBR delta = Recent NBR − Baseline NBR


Index	Main purpose	Bands used
NDVI	Vegetation greenness and density	NIR (B8) + Red (B4)
NBR	Burn-sensitive vegetation and exposed soil change	NIR (B8) + SWIR2 (B12)

NDVI = (B8 − B4) / (B8 + B4)
NBR  = (B8 − B12) / (B8 + B12)

NDVI is more focused on plant health. NBR is more sensitive to burn scars, dry vegetation, and exposed soil.

For example:
- A healthy forest may have high NDVI and high NBR.
- A burn scar may cause both NDVI and NBR to decrease.
- Moisture or exposed soil may affect NBR more strongly than NDVI.
- Seasonal greenness changes may affect NDVI without indicating fire.
So the maps may visually overlap, but the underlying values and physical interpretation are differen


NDVI: Normalized Difference Vegetation Index
NBR: Normalized Burn Ratio
NIR: Near-Infrared
SWIR: Short-Wave Infrared
SR: Surface Reflectance
SCL: Scene Classification Layer


Band mapping:
- B4 = Red band, approximately 665 nm
- B8 = Near-Infrared band, approximately 842 nm
- B12 = Short-Wave Infrared 2 band, approximately 2,190 nm

Sentinel‑2 band use cases:
- B4 — Red: Helps measure chlorophyll absorption and vegetation density. Used with B8 for NDVI.
- B8 — Near-Infrared: Healthy vegetation strongly reflects it. Used to distinguish healthy vegetation from stressed or sparse vegetation.
- B12 — Short-Wave Infrared 2: Sensitive to moisture, dry vegetation, exposed soil, and burn scars. Used with B8 for NBR.






Techniques used in Vanraksha

1. Multi-temporal satellite comparison
We compare two Sentinel‑2 time windows:
- Recent observation period
- Earlier baseline period
This helps identify changes instead of evaluating only one image.
2. Cloud and quality masking
Before analysis, Sentinel‑2 pixels are filtered using:
- Cloud percentage metadata
- Scene Classification Layer (SCL)
- Cloud, shadow, cirrus, and snow masking
This reduces false signals caused by poor imagery.
3. Median image compositing
For each time window, multiple valid scenes are combined using a median composite.

This reduces:
- Cloud remnants
- Atmospheric noise
- Single-image anomalies
4. NDVI calculation
NDVI = (B8 − B4) / (B8 + B4)
Used to estimate vegetation greenness and canopy health.
5. NBR calculation
NBR = (B8 − B12) / (B8 + B12)
Used to detect burn-sensitive vegetation and surface changes.
6. Change-delta analysis
NDVI delta = Recent NDVI − Baseline NDVI
NBR delta  = Recent NBR − Baseline NBR
Negative values indicate a decrease compared with the baseline period.
7. Rule-based alert detection
An alert is created when either condition is met:
NDVI delta ≤ −0.08
or
NBR delta ≤ −0.10
This is a transparent threshold method. It is not a trained machine-learning classifier.
8. Hotspot extraction
Pixels crossing the thresholds are grouped into approximate polygons using Earth Engine vectorization.

For each hotspot, Vanraksha reports:
- Latitude
- Longitude
- Approximate area
- Threshold-crossing reason
9. Explainable risk score
The risk score combines:
- Canopy-change signal
- NDVI decrease
- Weather conditions
- Nearby wildfire reports
It produces a low, medium, or high priority for review. It is a triage score, not a probability of fire.
10. Contextual data integration
Vanraksha supplements satellite evidence with:
- Weather from Open‑Meteo
- Wildfire events from NASA EONET
- Optional location search through OpenStreetMap or Google Maps
These sources provide context and do not replace satellite or field verification.
Use of Sarvam AI
Sarvam AI is used after the satellite analysis.

It helps with:
- Generating a concise Ranger Brief
- Explaining NDVI and NBR in simple language
- Summarizing the evidence and limitations
- Recommending field-verification actions
- Answering ranger follow-up questions
- Producing English, Telugu, and Hindi responses
Sarvam AI does not:
- Process the raw satellite pixels
- Calculate NDVI or NBR
- Confirm that a fire occurred
- Decide whether an activity is illegal
- Replace a ranger’s field inspection
The workflow is:
Sentinel‑2 imagery
        ↓
Earth Engine analysis
        ↓
NDVI/NBR change and alert
        ↓
Sarvam AI explanation
        ↓
Human field verification
How to describe the alert technique
Vanraksha uses explainable, threshold-based multi-temporal change detection. It compares cloud-screened Sentinel‑2 median composites from recent and baseline periods, calculates NDVI and NBR deltas, and creates a possible-disturbance alert when the measured decrease crosses predefined thresholds. The alert is a triage signal that supports field verification; it is not a confirmed fire or legal determination.
