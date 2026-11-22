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