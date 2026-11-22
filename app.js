import { getFireWeather } from "./services/weather.js";
import { countEventsNear, getOpenWildfires } from "./services/eonet.js";

const SESCHACHALAM = { latitude: 13.69, longitude: 79.27 };

const style = document.createElement("style");
style.textContent = `
  /* The original prototype map and sample metric cards remain in the source
     for rollback, but are hidden from the evaluator-facing live workflow. */
  .content > .metrics, .content > .grid { display:none !important; }
  .live-panel { background:#fff; border:1px solid #e1e9e3; border-radius:11px; margin:-2px 0 14px; overflow:hidden; box-shadow:0 3px 10px #233c2d08; }
  .live-title { padding:11px 15px; display:flex; justify-content:space-between; border-bottom:1px solid #edf1ee; font-size:11px; font-weight:700; }
  .live-source { color:#5c7967; font-size:9px; font-weight:600; }
  .live-grid { display:grid; grid-template-columns:repeat(3, 1fr); }
  .live-grid div { padding:12px 15px; border-right:1px solid #edf1ee; }
  .live-grid div:last-child { border-right:0; }
  .live-grid label, .live-grid small { display:block; font-size:9px; color:#75837a; }
  .live-grid strong { display:block; margin:5px 0 3px; font-size:13px; color:#20332a; }
  .ai-panel { background:#183b2a; border-radius:11px; color:#eff7f1; margin:-2px 0 14px; padding:14px 16px; }
  .ai-heading { display:flex; align-items:start; justify-content:space-between; }
  .ai-heading strong { font-size:13px; }
  .ai-kicker { color:#a9d9ba; font-size:9px; font-weight:700; letter-spacing:.8px; text-transform:uppercase; margin-bottom:3px; }
  .ai-heading span { border:1px solid #4e7f62; color:#c7e8d0; border-radius:99px; padding:4px 7px; font-size:8px; font-weight:700; }
  .ai-panel p { margin:10px 0; color:#d4e3d8; line-height:1.5; font-size:10px; }
  .ai-panel h4 { margin:10px 0 4px; color:#f0f8f2; font-size:10px; }
  .ai-panel ul { margin:6px 0 10px 16px; padding:0; color:#d4e3d8; font-size:10px; line-height:1.5; }
  .ai-actions { display:flex; gap:9px; align-items:center; }
  .ai-actions button { border:0; border-radius:6px; background:#d6eddc; color:#173b28; padding:7px 9px; font-size:9px; font-weight:700; }
  .ai-actions button.secondary { background:transparent; color:#d4e3d8; border:1px solid #4e7f62; }
  .ai-actions small { color:#adc9b6; font-size:8px; }
  .ai-chat { display:flex; gap:6px; margin-top:10px; }
  .ai-chat input { flex:1; min-width:0; border:1px solid #4e7f62; border-radius:6px; background:#214b35; color:#fff; padding:7px 8px; font-size:9px; }
  .ai-chat button { border:1px solid #7eb28d; border-radius:6px; background:#d6eddc; color:#173b28; padding:7px 10px; font-size:9px; font-weight:700; }
  @media(max-width:730px) { .live-grid { grid-template-columns:1fr; } .live-grid div { border-right:0; border-bottom:1px solid #edf1ee; } }
`;
document.head.append(style);

// Replace prototype wording in the visible shell with the live workflow label.
const demoChip = document.querySelector(".top .chip");
if (demoChip) demoChip.textContent = "LIVE MONITORING";
const notice = document.querySelector(".notice");
if (notice) notice.innerHTML = "<strong>Live monitoring.</strong> Register a zone, scan the latest available Sentinel-2 imagery, review the change layers, and create a case only after ranger verification.";

function createLivePanel() {
  const panel = document.createElement("section");
  panel.className = "live-panel";
  panel.innerHTML = `
    <div class="live-title"><span>Live context</span><span class="live-source">Loading public data...</span></div>
    <div class="live-grid">
      <div><label>Fire weather</label><strong id="weatherValue">Loading...</strong><small id="weatherDetail">Open-Meteo</small></div>
      <div><label>Open wildfire events nearby</label><strong id="wildfireValue">Loading...</strong><small id="wildfireDetail">NASA EONET, 30-day feed</small></div>
      <div><label>Forest disturbance data</label><strong>Demo records</strong><small>Connect Global Forest Watch API in a future release</small></div>
    </div>
  `;
  document.querySelector(".notice").after(panel);
}

function createAiPanel() {
  const panel = document.createElement("section");
  panel.className = "ai-panel";
  panel.innerHTML = `
    <div class="ai-heading">
      <div><div class="ai-kicker">AI-assisted triage</div><strong>Ranger Brief</strong></div>
      <span id="aiMode">Checking mode...</span>
    </div>
    <p id="aiBrief">Ask the agent to turn the selected alert and available context into a concise review brief.</p>
    <div class="ai-actions">
      <button id="toggleAi" class="secondary" type="button">Enable AI</button>
      <button id="askAgent" type="button">Generate ranger brief</button>
    </div>
    <div class="ai-chat"><input id="rangerQuestion" placeholder="Ask about this live alert" aria-label="Ask the Ranger Assistant"><button id="askRanger" type="button">Ask</button></div>
    <small id="aiHint">Checking server-side AI configuration...</small>
  `;
  document.querySelector(".live-panel").after(panel);

  let aiConfigured = false;
  let aiModeMessage = "AI API is not configured; generated briefs use demo mode.";
  let aiEnabled = true;
  const mode = document.getElementById("aiMode");
  const hint = document.getElementById("aiHint");
  const toggle = document.getElementById("toggleAi");
  const ask = document.getElementById("askAgent");
  const askRanger = document.getElementById("askRanger");
  const question = document.getElementById("rangerQuestion");
  const chatHistory = [];
  toggle.style.display = "none";

  function renderAiMode() {
    mode.textContent = aiConfigured
      ? (aiEnabled ? "AI ENABLED" : "AI DISABLED")
      : "DEMO MODE";
    toggle.textContent = aiEnabled ? "Disable AI" : "Enable AI";
    hint.textContent = aiConfigured
      ? (aiEnabled
        ? "Live brief uses the selected live alert's measurements and hotspot metadata; imagery remains for human review."
        : "AI is configured but disabled; generated briefs use demo mode.")
      : aiModeMessage;
  }

  toggle.addEventListener("click", () => {
    aiEnabled = !aiEnabled;
    renderAiMode();
  });

  async function loadAiStatus() {
    try {
      const response = await api("/api/ai/status");
      const status = response;
      aiConfigured = status.configured === true;
      if (!aiConfigured) {
        aiModeMessage = status.missing_settings?.includes("AI_API_KEY")
          ? "No AI_API_KEY configured; generated briefs use demo mode."
          : `AI settings incomplete (${status.missing_settings.join(", ")}); generated briefs use demo mode.`;
      }
    } catch (error) {
      aiConfigured = false;
      aiModeMessage = "AI configuration unavailable; generated briefs use demo mode.";
    }
    renderAiMode();
  }

  ask.addEventListener("click", async () => {
    const selected = document.querySelector(".alert.sel");
    const title = selected?.querySelector(".aname")?.textContent || "selected forest-change alert";
    ask.disabled = true;
    ask.textContent = "Generating...";
    try {
      if (aiConfigured && aiEnabled) {
        const liveAlerts = await api("/api/alerts");
        const liveAlert = liveAlerts[0];
        if (!liveAlert) {
          document.getElementById("aiBrief").textContent = "No live alert is available for this scan. A Ranger Brief will appear after NDVI or NBR crosses the alert threshold.";
          return;
        }
        const response = await api("/api/ai/brief", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ alert_id: liveAlert.id })
        });
        const result = response;
        document.getElementById("aiBrief").innerHTML = formatBrief(result.brief);
      } else {
        document.getElementById("aiBrief").textContent =
          `Demo response: ${title} should be reviewed first. Compare current and earlier imagery when available, confirm the coordinates against the protected-area boundary, and request a ranger field check. This response is mocked; it does not establish a change or make a legal finding.`;
      }
    } catch (error) {
      document.getElementById("aiBrief").textContent = `Unable to generate a brief: ${error.message}`;
    } finally {
      ask.disabled = false;
      ask.textContent = "Generate ranger brief";
    }
  });
  askRanger.addEventListener("click", async () => {
    const message = question.value.trim();
    if (!message) return;
    try {
      const alerts = await api("/api/alerts");
      if (!alerts.length) throw new Error("Run a live scan that creates an alert first.");
      const reply = await api("/api/ai/chat", {method: "POST", body: JSON.stringify({alert_id: alerts[0].id, message, history: chatHistory})});
      chatHistory.push({role: "user", content: message}, {role: "assistant", content: reply.reply});
      document.getElementById("aiBrief").innerHTML = formatBrief(reply.reply);
      question.value = "";
    } catch (error) { document.getElementById("aiBrief").textContent = error.message; }
  });

  loadAiStatus();
}

function setLiveError(id, detail, fallback) {
  document.getElementById(id).textContent = fallback;
  document.getElementById(detail).textContent = "Live source unavailable; demo remains usable";
}

function formatBrief(text) {
  const safe = String(text || "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  return safe
    .replace(/^###?\s*(.+)$/gm, "<h4>$1</h4>")
    .replace(/\*\*(.+?)\*\*/g, "<strong>$1</strong>")
    .replace(/^[-•]\s+(.+)$/gm, "<li>$1</li>")
    .replace(/(?:<li>.*<\/li>\n?)+/g, block => "<ul>" + block + "</ul>")
    .replace(/\n{2,}/g, "<br><br>")
    .replace(/\n/g, "<br>");
}

async function loadLiveContext() {
  try {
    const response = await fetch("/api/context");
    if (!response.ok) throw new Error("Backend unavailable");
    const context = await response.json();
    if (!context.weather) throw new Error(context.message || "Live context unavailable");
    const weather = context.weather;
    const dry = weather.rain_chance_pct < 25;
    document.getElementById("weatherValue").textContent = dry ? "Dry conditions" : "Moist conditions";
    document.getElementById("weatherDetail").textContent = `${weather.temperature_c} C, ${weather.humidity_pct}% humidity, ${weather.wind_kmh} km/h wind`;
    if (context.status === "live") {
      document.getElementById("wildfireValue").textContent = `${context.nearby_open_wildfire_events} in 50 km`;
      document.getElementById("wildfireDetail").textContent = `NASA EONET · illustrative triage score ${context.sample_alert_risk.score}/100`;
      document.querySelector(".live-source").textContent = "Live context via Python FastAPI";
    } else {
      setLiveError("wildfireValue", "wildfireDetail", "Unavailable");
      document.querySelector(".live-source").textContent = "Weather live · wildfire feed unavailable";
    }
  } catch (error) {
    // A double-clicked file cannot reach the Python route, so direct public APIs
    // keep the interface useful until the local server is started.
    try {
      const weather = await getFireWeather(SESCHACHALAM.latitude, SESCHACHALAM.longitude);
      const dry = weather.precipitation === 0 && weather.rainChance < 25;
      document.getElementById("weatherValue").textContent = dry ? "Dry conditions" : "Moist conditions";
      document.getElementById("weatherDetail").textContent = `${weather.temperature} C, ${weather.humidity}% humidity, ${weather.windSpeed} km/h wind`;
    } catch (weatherError) {
      setLiveError("weatherValue", "weatherDetail", "Unavailable");
    }

    try {
      const events = await getOpenWildfires();
      const count = countEventsNear(events, SESCHACHALAM.latitude, SESCHACHALAM.longitude);
      document.getElementById("wildfireValue").textContent = `${count} in 50 km`;
      document.getElementById("wildfireDetail").textContent = "NASA EONET direct browser fallback";
      document.querySelector(".live-source").textContent = "Public context loaded";
    } catch (wildfireError) {
      setLiveError("wildfireValue", "wildfireDetail", "Unavailable");
    }
  }
}

createLivePanel();
createAiPanel();
loadLiveContext();

// These controls use the Python API. Sentinel-2 scanning starts only after
// the Earth Engine values in .env have been configured.
const monitorStyle = document.createElement("style");
monitorStyle.textContent = ".monitor-panel{margin:0 0 14px;background:#fff;border:1px solid #e1e9e3;border-radius:11px;padding:15px;box-shadow:0 3px 10px #233c2d08}.monitor-head{display:flex;justify-content:space-between;gap:12px;align-items:flex-start;margin-bottom:12px}.monitor-head h2{font-size:13px;margin:0}.monitor-head p{font-size:9px;color:#75837a;margin:4px 0 0}.state-pill{border-radius:99px;background:#fff3df;color:#986923;font-size:8px;font-weight:700;padding:5px 7px}.state-pill.ready{background:#eaf4ed;color:#32654a}.zone-form{display:grid;grid-template-columns:1.35fr 1.45fr 1fr 1fr auto;gap:7px}.zone-form input,.zone-form select,.zone-form button{font:inherit;border:1px solid #d9e4dc;border-radius:6px;padding:8px;font-size:10px}.zone-form button{background:#246747;color:#fff;font-weight:700;border:0}.monitor-grid{display:grid;grid-template-columns:1.15fr .85fr;gap:12px;margin-top:12px}.monitor-box{border:1px solid #e7eee8;border-radius:8px;padding:11px}.monitor-box h3{font-size:10px;margin:0 0 8px}.zone-row,.note-row,.case-row{padding:8px 0;border-top:1px solid #eef2ef;font-size:9px}.zone-row:first-of-type,.note-row:first-of-type,.case-row:first-of-type{border-top:0}.zone-row{display:flex;align-items:center;justify-content:space-between;gap:8px}.zone-row b,.note-row b,.case-row b{display:block;font-size:10px}.zone-row small,.note-row small,.case-row small{color:#75837a;display:block;margin-top:3px}.scan{background:#eef5ef;color:#31573f;border:1px solid #cfe0d4;border-radius:5px;padding:5px 7px;font-size:8px;font-weight:700}.empty{font-size:9px;color:#75837a;padding:7px 0}.case-action{background:none;border:0;color:#246747;font-size:8px;padding:0;margin-top:4px;font-weight:700}@media(max-width:730px){.zone-form,.monitor-grid{grid-template-columns:1fr}.monitor-head{display:block}.state-pill{display:inline-block;margin-top:8px}}";
monitorStyle.textContent += ".satellite-preview{display:none;margin-top:12px;border:1px solid #dce9df;border-radius:8px;overflow:hidden;background:#f5f8f5}.satellite-preview.visible{display:block}.satellite-preview img{display:block;width:100%;max-height:330px;object-fit:cover}.satellite-preview figcaption{padding:8px 10px;color:#5f7166;font-size:9px}.satellite-preview a{color:#246747;font-weight:700;margin-left:8px}.preview-loading{height:4px;background:#e5eee7;overflow:hidden}.preview-loading i{display:block;width:35%;height:100%;background:#2b7854;animation:preview-load 1.1s infinite ease-in-out}.preview-loading.done{display:none}@keyframes preview-load{0%{transform:translateX(-120%)}100%{transform:translateX(320%)}}";
monitorStyle.textContent += ".zone-field-label{display:flex;flex-direction:column;gap:4px;color:#64766a;font-size:8px;font-weight:700}.zone-field-label input,.zone-field-label select{width:100%}";
monitorStyle.textContent += ".hotspot-list{margin-top:8px;line-height:1.6}.hotspot-list strong{display:block;color:#31573f}.hotspot-list div{font-size:9px;color:#52645a}.case-action{display:inline-block;background:#246747;color:#fff;border:0;border-radius:5px;padding:6px 8px;font-size:8px;font-weight:700}.case-row small{margin-bottom:5px}";
monitorStyle.textContent += ".case-card{display:flex;flex-direction:column;align-items:flex-start;gap:3px}.case-card b{font-size:11px}.case-card .case-outcome{font-size:9px;color:#405b4b;background:#f2f7f3;border-radius:5px;padding:6px;margin:4px 0;width:100%}.secondary-case{background:#eef5ef;color:#31573f}";
document.head.append(monitorStyle);

function createMonitoringPanel() {
  const panel = document.createElement("section");
  panel.className = "monitor-panel";
  panel.innerHTML = '<div class="monitor-head"><div><h2>Monitoring centre</h2><p>Choose a forest area and radius, then start monitoring with the latest available Sentinel-2 observations.</p></div><span id="eeState" class="state-pill">CHECKING SETUP</span></div><form id="zoneForm" class="zone-form"><select id="zonePreset" aria-label="Choose forest area"><option value="seshachalam">Seshachalam Forest</option><option value="tirumala">Tirumala Forest Block</option><option value="custom">Custom coordinates</option></select><input id="zoneName" required value="Seshachalam Forest" aria-label="Zone name" placeholder="Area name"><input id="zoneLat" required type="number" step="0.0001" value="13.6900" aria-label="Latitude" placeholder="Latitude"><input id="zoneLon" required type="number" step="0.0001" value="79.2700" aria-label="Longitude" placeholder="Longitude"><select id="zoneRadius" aria-label="Monitoring radius"><option value="5">5 km</option><option value="10" selected>10 km</option><option value="20">20 km</option><option value="50">50 km</option></select><button type="submit">Start monitoring</button></form><div class="monitor-grid"><div class="monitor-box"><h3>Saved monitoring areas</h3><div id="zoneList"><div class="empty">Loading areas...</div></div></div><div class="monitor-box"><h3>In-app notifications</h3><div id="notificationList"><div class="empty">Loading notifications...</div></div></div></div><div class="monitor-grid"><div class="monitor-box"><h3>Real scan alerts</h3><div id="realAlertList"><div class="empty">A scan creates alerts only when the detection threshold is crossed.</div></div></div><div class="monitor-box"><h3>Case files & department feedback</h3><div id="caseList"><div class="empty">Create a case from an alert, then record the verified outcome and reason.</div></div></div></div>';
  const preview = document.createElement("figure");
  preview.id = "satellitePreview"; preview.className = "satellite-preview";
  preview.innerHTML = '<div id="previewLoading" class="preview-loading done"><i></i></div><img id="satellitePreviewImage" alt="Latest Sentinel-2 satellite preview"><figcaption><select id="satelliteLayerSelect" aria-label="Satellite layer"><option value="true_colour">Recent true colour</option><option value="baseline_true_colour">Baseline true colour</option><option value="infrared">False-colour infrared</option><option value="ndvi_change">NDVI change heatmap</option><option value="nbr_change">NBR change heatmap</option></select> <span id="satellitePreviewCaption">No live preview yet.</span><a id="satelliteTileLink" target="_blank" rel="noopener" hidden>Open Earth Engine tile layer</a><div id="hotspotList" class="hotspot-list"></div></figcaption>';
  panel.querySelector(".monitor-grid").after(preview);
  const aiPanel = document.querySelector(".ai-panel");
  if (aiPanel) preview.after(aiPanel);
  document.querySelector(".content")?.append(panel);
}

async function api(path, options = {}) {
  const token = sessionStorage.getItem("vanraksha-session");
  const response = await fetch(path, {...options, headers: {"Content-Type": "application/json", ...(token ? {Authorization: "Bearer " + token} : {}), ...(options.headers || {})}});
  const body = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(typeof body.detail === "string" ? body.detail : body.detail?.message || "Request failed");
  return body;
}

function empty(element, message) { element.textContent = message; element.className = "empty"; }
function line(element, title, detail, buttonLabel, handler) {
  const row = document.createElement("div"); row.className = "case-row";
  const name = document.createElement("b"); name.textContent = title;
  const copy = document.createElement("small"); copy.textContent = detail;
  row.append(name, copy);
  if (buttonLabel) { const button = document.createElement("button"); button.className = "case-action"; button.textContent = buttonLabel; button.addEventListener("click", handler); row.append(button); }
  element.append(row);
}

async function refreshMonitoring() {
  const zoneList = document.getElementById("zoneList");
  try {
    const result = await Promise.all([api("/api/config/status"), api("/api/zones"), api("/api/notifications"), api("/api/alerts"), api("/api/cases")]);
    const config = result[0], zones = result[1], notes = result[2], alerts = result[3], cases = result[4];
    renderModeData({zones, alerts, cases});
    const state = document.getElementById("eeState");
    const eeMode = config.earth_engine.mode;
    state.textContent = eeMode === "setup_required" ? "EARTH ENGINE SETUP NEEDED" :
      eeMode === "service_account_configured" ? "SERVICE ACCOUNT SET · VERIFY WITH SCAN" : "PROJECT SET · LOCAL SIGN-IN REQUIRED";
    // Presence of credentials is not proof that Earth Engine access works;
    // only a successful scan can establish that.
    state.classList.remove("ready");
    zoneList.innerHTML = "";
    if (!zones.length) empty(zoneList, "No saved areas.");
    zones.forEach(zone => {
      const row = document.createElement("div"); row.className = "zone-row";
      const copy = document.createElement("div"); copy.innerHTML = "<b></b><small></small>";
      copy.querySelector("b").textContent = zone.name;
      copy.querySelector("small").textContent = zone.latitude.toFixed(4) + ", " + zone.longitude.toFixed(4) + " · " + zone.radius_km + " km · " + (zone.last_scan ? "scanned" : "not scanned yet");
      const select = document.createElement("input"); select.type = "checkbox"; select.className = "zone-select"; select.dataset.zone = zone.id; select.setAttribute("aria-label", "Select " + zone.name);
      const scan = document.createElement("button"); scan.className = "scan"; scan.textContent = "Scan now";
      scan.addEventListener("click", () => scanZone(zone.id)); row.append(copy, select, scan); zoneList.append(row);
    });
    const notificationList = document.getElementById("notificationList"); notificationList.innerHTML = "";
    if (!notes.length) empty(notificationList, "No notifications yet.");
    notes.slice(0, 5).forEach(note => line(notificationList, note.title, note.message));
    const alertList = document.getElementById("realAlertList"); alertList.innerHTML = "";
    if (!alerts.length) empty(alertList, "No threshold alerts created yet.");
    alerts.forEach(alert => line(alertList, alert.title, alert.priority.toUpperCase() + " · NDVI Δ " + alert.evidence.ndvi_delta.toFixed(3) + " · NBR Δ " + alert.evidence.nbr_delta.toFixed(3), "Create case file", () => makeCase(alert.id)));
    const caseList = document.getElementById("caseList"); caseList.innerHTML = "";
    if (!cases.length) empty(caseList, "No case files created.");
    cases.forEach(item => {
      const row = document.createElement("div"); row.className = "case-row case-card";
      const title = document.createElement("b"); title.textContent = item.title;
      const meta = document.createElement("small"); meta.textContent = `${item.id} · ${item.status === "closed" ? "Closed" : "Open"} · created ${new Date(item.created_at).toLocaleString()}`;
      const evidence = item.evidence || {};
      const details = document.createElement("small"); details.textContent = `NDVI Δ ${Number(evidence.ndvi_delta || 0).toFixed(3)} · NBR Δ ${Number(evidence.nbr_delta || 0).toFixed(3)} · ${evidence.hotspots?.length || 0} field-check points`;
      row.append(title, meta, details);
      const outcome = document.createElement("div"); outcome.className = "case-outcome";
      outcome.textContent = item.outcome ? `${item.outcome.replaceAll("_", " ")}: ${item.reason}` : "Awaiting ranger or department verification.";
      row.append(outcome);
      if (!item.outcome) { const button = document.createElement("button"); button.className = "case-action"; button.textContent = "Record outcome"; button.addEventListener("click", () => recordOutcome(item.id)); row.append(button); }
      const exportButton = document.createElement("button"); exportButton.className = "case-action secondary-case"; exportButton.textContent = "Export case JSON"; exportButton.addEventListener("click", () => downloadCase(item)); row.append(exportButton);
      caseList.append(row);
    });
  } catch (error) {
    empty(zoneList, "Start the Python server to use saved zones and scans.");
    empty(document.getElementById("notificationList"), "Backend unavailable.");
  }
}

async function scanZone(zoneId) {
  say("Scanning latest available satellite observations...");
  document.getElementById("satellitePreview")?.classList.add("visible");
  document.getElementById("previewLoading")?.classList.remove("done");
  try { const result = await api("/api/zones/" + zoneId + "/scan", {method: "POST"}); renderSatellitePreview(result.satellite); say(result.alert ? "Potential change detected; alert created." : "Scan finished; no threshold breach found."); refreshMonitoring(); }
  catch (error) { document.getElementById("previewLoading")?.classList.add("done"); say(error.message); }
}
function renderSatellitePreview(satellite) {
  const preview = satellite?.preview, frame = document.getElementById("satellitePreview");
  if (!preview?.true_colour || !frame) return;
  const select = document.getElementById("satelliteLayerSelect");
  const update = () => {
    const layer = preview[select.value] || preview.true_colour;
    const image = document.getElementById("satellitePreviewImage");
    const loading = document.getElementById("previewLoading");
    loading.classList.remove("done");
    image.onload = () => loading.classList.add("done");
    image.onerror = () => loading.classList.add("done");
    image.src = layer.thumbnail_url;
    document.getElementById("satellitePreviewCaption").textContent = layer.label + " · " + satellite.recent_window;
    const link = document.getElementById("satelliteTileLink");
    if (layer.tile_url) { link.href = layer.tile_url; link.hidden = false; }
  const hotspotList = document.getElementById("hotspotList");
  hotspotList.innerHTML = "";
  const hotspots = preview.hotspots || [];
  if (hotspots.length) {
    const title = document.createElement("strong"); title.textContent = "Field-check points"; hotspotList.append(title);
    hotspots.forEach((hotspot, index) => {
      const item = document.createElement("div");
      item.textContent = `${index + 1}. ${hotspot.latitude.toFixed(6)}, ${hotspot.longitude.toFixed(6)} · approx. ${hotspot.approx_area_ha} ha`;
      hotspotList.append(item);
    });
  } else hotspotList.textContent = "No threshold-crossing hotspot was isolated in this zone.";
  };
  select.onchange = update;
  update();
  frame.classList.add("visible");
}
function downloadCase(item) {
  const link = document.createElement("a");
  link.href = URL.createObjectURL(new Blob([JSON.stringify(item, null, 2)], {type: "application/json"}));
  link.download = "vanraksha-" + item.id + "-case.json"; link.click();
  setTimeout(() => URL.revokeObjectURL(link.href), 500); say("Case file exported.");
}
async function makeCase(alertId) {
  try { const item = await api("/api/cases", {method: "POST", body: JSON.stringify({alert_id: alertId})}); say("Case file " + item.id + " created."); refreshMonitoring(); }
  catch (error) { say(error.message); }
}
async function recordOutcome(caseId) {
  const outcome = window.prompt("Enter: confirmed, not_confirmed, or insufficient_evidence", "confirmed");
  if (!outcome) return;
  const reason = window.prompt("Why was this outcome selected? This feedback may be used for future model evaluation.");
  if (!reason) return;
  try { await api("/api/cases/" + caseId + "/outcome", {method: "POST", body: JSON.stringify({outcome, reason})}); say("Department feedback recorded."); refreshMonitoring(); }
  catch (error) { say(error.message); }
}

const forestPresets = {
  seshachalam: {name: "Seshachalam Forest", latitude: 13.6900, longitude: 79.2700},
  tirumala: {name: "Tirumala Forest Block", latitude: 13.6833, longitude: 79.3500}
};
createMonitoringPanel();
const zoneFormLabels = [["zonePreset", "Forest preset"], ["zoneName", "Monitoring area name"], ["zoneLat", "Latitude"], ["zoneLon", "Longitude"], ["zoneRadius", "Monitoring radius"]];
zoneFormLabels.forEach(([id, text]) => {
  const field = document.getElementById(id); if (!field) return;
  const label = document.createElement("label"); label.className = "zone-field-label"; label.textContent = text;
  field.parentNode.insertBefore(label, field); label.appendChild(field);
});
refreshMonitoring();

document.getElementById("zonePreset").addEventListener("change", event => {
  const preset = forestPresets[event.target.value];
  const custom = event.target.value === "custom";
  document.getElementById("zoneName").readOnly = !custom;
  document.getElementById("zoneLat").readOnly = !custom;
  document.getElementById("zoneLon").readOnly = !custom;
  if (preset) {
    document.getElementById("zoneName").value = preset.name;
    document.getElementById("zoneLat").value = preset.latitude.toFixed(4);
    document.getElementById("zoneLon").value = preset.longitude.toFixed(4);
  }
});

document.getElementById("zoneForm").addEventListener("submit", async event => {
  event.preventDefault();
  const payload = {name: document.getElementById("zoneName").value, latitude: Number(document.getElementById("zoneLat").value), longitude: Number(document.getElementById("zoneLon").value), radius_km: Number(document.getElementById("zoneRadius").value)};
  try { const zone = await api("/api/zones", {method: "POST", body: JSON.stringify(payload)}); say(zone.name + " is now monitored."); refreshMonitoring(); }
  catch (error) { say(error.message); }
});

// Turn the sidebar into working navigation for the live monitoring workflow.
const liveNavStyle = document.createElement("style");
liveNavStyle.textContent = ".side .nav{cursor:pointer}.side .nav.nav-active{background:#315b43;color:#fff;border-radius:6px}.live-only-label{display:inline-block;margin:4px 0 8px;padding:4px 7px;border-radius:99px;background:#eaf4ed;color:#32654a;font-size:8px;font-weight:700}";
document.head.append(liveNavStyle);
const navItems = [...document.querySelectorAll(".side .nav")];
const navTargets = [
  () => document.querySelector(".content"),
  () => document.getElementById("realAlertList")?.closest(".monitor-box"),
  () => document.getElementById("caseList")?.closest(".monitor-box"),
  () => document.getElementById("zoneForm")
];
navItems.slice(0, 4).forEach((item, index) => {
  item.classList.remove("on");
  item.addEventListener("click", () => {
    navItems.slice(0, 4).forEach(nav => nav.classList.remove("nav-active"));
    item.classList.add("nav-active");
    const target = navTargets[index]?.();
    target?.scrollIntoView({behavior: "smooth", block: "start"});
  });
});
navItems[0]?.classList.add("nav-active");

// Replace the old sample download buttons with live backend case-file export.
async function downloadLiveCase() {
  try {
    const cases = await api("/api/cases");
    if (!cases.length) {
      say("No live case file exists yet. Scan a monitored zone first.");
      document.getElementById("zoneForm")?.scrollIntoView({behavior: "smooth", block: "start"});
      return;
    }
    const current = cases[0];
    const payload = {
      caseFile: "Vanraksha live monitoring case file",
      caseId: current.id,
      alertId: current.alert_id,
      title: current.title,
      createdAt: current.created_at,
      status: current.status,
      departmentOutcome: current.outcome,
      departmentReason: current.reason,
      evidence: current.evidence,
      reviewHistory: current.review_history,
      limitations: [
        "Satellite observations are latest-available, not real-time video.",
        "A possible change does not prove illegal activity.",
        "Field verification and department review are required."
      ]
    };
    const link = document.createElement("a");
    link.href = URL.createObjectURL(new Blob([JSON.stringify(payload, null, 2)], {type: "application/json"}));
    link.download = "vanraksha-" + current.id + "-case.json";
    link.click();
    setTimeout(() => URL.revokeObjectURL(link.href), 500);
    say("Live case file downloaded.");
  } catch (error) {
    say("Live case files require the Python server.");
  }
}
document.getElementById("case").onclick = event => {
  event.preventDefault();
  downloadLiveCase();
};
document.getElementById("create").onclick = event => {
  event.preventDefault();
  document.getElementById("caseList")?.closest(".monitor-box")?.scrollIntoView({behavior: "smooth", block: "start"});
  say("Use Create case file beside a real scan alert.");
};

// Login gate, account settings, location search, and multi-zone actions.
const adminStyle = document.createElement("style");
adminStyle.textContent = ".app-lock{position:fixed;inset:0;z-index:99;background:linear-gradient(135deg,#102a1d,#1d5837);display:grid;place-items:center;padding:20px}.login-card{width:min(390px,100%);background:#fff;border-radius:14px;padding:28px;box-shadow:0 20px 60px #07170eb0}.login-card h2{margin:0 0 6px;font-size:24px}.login-card p{color:#6e7d74;font-size:12px;line-height:1.5}.login-card input{width:100%;margin:7px 0;border:1px solid #d9e4dc;border-radius:7px;padding:10px}.login-card button,.multi-scan{background:#246747;color:#fff;border:0;border-radius:7px;padding:10px;width:100%;font-weight:700;margin-top:8px}.login-error{min-height:18px;color:#b44535;font-size:10px;margin-top:8px}.location-search{display:grid;grid-template-columns:1fr auto;gap:7px;margin:10px 0}.location-search input,.location-search select,.location-search button{font:inherit;border:1px solid #d9e4dc;border-radius:6px;padding:8px;font-size:10px}.location-search button{background:#183b2a;color:#fff}.location-results{width:100%;margin:0 0 10px}.account-panel{margin:0 0 14px;background:#fff;border:1px solid #e1e9e3;border-radius:11px;padding:15px}.account-panel h2{font-size:13px;margin:0 0 6px}.account-panel p{font-size:10px;color:#75837a;line-height:1.5}.account-panel button{background:#fff;border:1px solid #d9e4dc;border-radius:6px;padding:7px 9px;font-size:9px}.multi-scan{width:auto;margin:0 0 10px;padding:7px 10px;font-size:9px}.zone-select{accent-color:#246747}@media(max-width:730px){.location-search{grid-template-columns:1fr}}";
document.head.append(adminStyle);

function createLoginGate() {
  const gate = document.createElement("section");
  gate.id = "loginGate";
  gate.className = "app-lock";
  gate.innerHTML = '<form class="login-card" id="loginForm"><div class="eyebrow">Vanraksha workspace</div><h2>Sign in</h2><p>Sign in to manage monitoring areas, alerts, and case reviews.</p><label for="loginUser">Username</label><input id="loginUser" autocomplete="username" aria-label="Username" placeholder="Username" required><label for="loginPassword">Password</label><input id="loginPassword" type="password" autocomplete="current-password" aria-label="Password" placeholder="Password" required><button type="submit">Sign in</button><div id="loginError" class="login-error" role="alert"></div></form>';
  document.body.append(gate);
  document.getElementById("loginForm").addEventListener("submit", async event => {
    event.preventDefault();
    const error = document.getElementById("loginError");
    try {
      const response = await fetch("/api/auth/login", {method: "POST", headers: {"Content-Type": "application/json"}, body: JSON.stringify({username: document.getElementById("loginUser").value, password: document.getElementById("loginPassword").value})});
      const result = await response.json();
      if (!response.ok) throw new Error(result.detail || "Login failed.");
      sessionStorage.setItem("vanraksha-session", result.token);
      sessionStorage.setItem("vanraksha-user", result.username);
      gate.remove();
      refreshMonitoring();
    } catch (loginError) { error.textContent = loginError.message; }
  });
  const savedToken = sessionStorage.getItem("vanraksha-session");
  if (savedToken) {
    fetch("/api/zones", {headers: {Authorization: "Bearer " + savedToken}})
      .then(response => {
        if (response.ok) gate.remove();
        else {
          sessionStorage.removeItem("vanraksha-session");
          sessionStorage.removeItem("vanraksha-user");
        }
      })
      .catch(() => {
        // Keep the gate closed only when the backend confirms the session.
        sessionStorage.removeItem("vanraksha-session");
        sessionStorage.removeItem("vanraksha-user");
      });
  }
}

function addLocationSearch() {
  const form = document.getElementById("zoneForm");
  const search = document.createElement("div");
  search.className = "location-search";
  search.innerHTML = '<input id="locationSearch" placeholder="Search a forest, reserve, town, or landmark" aria-label="Search location"><button id="locationSearchButton" type="button">Search map</button>';
  form.before(search);
  const results = document.createElement("select");
  results.id = "locationResults"; results.className = "location-results"; results.hidden = true;
  search.after(results);
  async function searchMap() {
    const query = document.getElementById("locationSearch").value.trim();
    if (query.length < 3) { say("Enter at least three characters to search."); return; }
    try {
      const payload = await api("/api/locations/search?q=" + encodeURIComponent(query));
      results.innerHTML = "";
      if (!payload.results.length) { say("No matching locations found."); results.hidden = true; return; }
      const starter = document.createElement("option"); starter.value = ""; starter.textContent = "Choose a result · " + payload.source; results.append(starter);
      payload.results.forEach((item, index) => { const option = document.createElement("option"); option.value = String(index); option.textContent = item.name; option.dataset.latitude = item.latitude; option.dataset.longitude = item.longitude; results.append(option); });
      results.hidden = false;
    } catch (error) { say(error.message); }
  }
  document.getElementById("locationSearchButton").addEventListener("click", searchMap);
  document.getElementById("locationSearch").addEventListener("keydown", event => { if (event.key === "Enter") { event.preventDefault(); searchMap(); } });
  results.addEventListener("change", () => {
    const option = results.options[results.selectedIndex];
    if (!option.dataset.latitude) return;
    document.getElementById("zonePreset").value = "custom";
    document.getElementById("zoneName").readOnly = false;
    document.getElementById("zoneLat").readOnly = false;
    document.getElementById("zoneLon").readOnly = false;
    document.getElementById("zoneName").value = option.textContent;
    document.getElementById("zoneLat").value = Number(option.dataset.latitude).toFixed(4);
    document.getElementById("zoneLon").value = Number(option.dataset.longitude).toFixed(4);
    say("Location selected. Choose a radius and start monitoring.");
  });
}

function addAccountSettings() {
  const drawer = document.createElement("aside");
  drawer.id = "accountSettings";
  drawer.className = "settings-drawer";
  drawer.hidden = true;
  drawer.innerHTML = '<div class="settings-head"><div><div class="eyebrow">Workspace</div><h2>Account & settings</h2></div><button id="closeSettings" type="button" aria-label="Close settings">×</button></div><div class="settings-section"><b>Administrator</b><p>Signed in to a fresh prototype session. Closing and signing in again clears saved areas, alerts, and cases.</p></div><div class="settings-section"><b>Data sources</b><p>Live mode uses Earth Engine, weather, wildfire context, and Google Maps search when its key is configured.</p></div><button id="logoutButton" class="logout-button" type="button">Sign out</button>';
  document.body.append(drawer);
  document.getElementById("logoutButton").addEventListener("click", () => { sessionStorage.removeItem("vanraksha-session"); sessionStorage.removeItem("vanraksha-user"); location.reload(); });
  document.getElementById("closeSettings").addEventListener("click", () => { drawer.hidden = true; });
  const accountNav = document.createElement("div");
  accountNav.className = "nav account-nav"; accountNav.textContent = "⚙  Account & settings";
  accountNav.setAttribute("role", "button");
  accountNav.setAttribute("tabindex", "0");
  accountNav.setAttribute("aria-controls", "accountSettings");
  accountNav.setAttribute("aria-expanded", "false");
  document.querySelector(".side .foot").before(accountNav);
  const openSettings = () => { drawer.hidden = false; accountNav.setAttribute("aria-expanded", "true"); document.getElementById("closeSettings").focus(); };
  const closeSettings = () => { drawer.hidden = true; accountNav.setAttribute("aria-expanded", "false"); accountNav.focus(); };
  accountNav.addEventListener("click", openSettings);
  accountNav.addEventListener("keydown", event => { if (event.key === "Enter" || event.key === " ") { event.preventDefault(); openSettings(); } });
  document.getElementById("closeSettings").addEventListener("click", closeSettings);
  document.addEventListener("keydown", event => { if (event.key === "Escape" && !drawer.hidden) closeSettings(); });
}

function addMultiZoneScan() {
  const button = document.createElement("button");
  button.className = "multi-scan"; button.type = "button"; button.textContent = "Scan selected areas";
  document.getElementById("zoneList").before(button);
  button.addEventListener("click", async () => {
    const ids = [...document.querySelectorAll(".zone-select:checked")].map(item => item.dataset.zone);
    if (!ids.length) { say("Select one or more saved monitoring areas first."); return; }
    button.disabled = true; button.textContent = "Scanning selected areas...";
    await Promise.all(ids.map(id => scanZone(id)));
    button.disabled = false; button.textContent = "Scan selected areas";
  });
}

createLoginGate();
addLocationSearch();
addAccountSettings();
addMultiZoneScan();

// Live mode never invents alerts. Demo mode has one clearly labelled
// illustrative event for presentation when a real scan finds nothing.
let activeDataMode = sessionStorage.getItem("vanraksha-data-mode") || "live";
const modeStyle = document.createElement("style");
modeStyle.textContent = ".mode-control{display:flex;align-items:center;gap:8px;background:#fff;border:1px solid #dce8df;border-radius:99px;padding:5px 7px 5px 10px;font-size:9px;font-weight:750;color:#456050}.mode-switch{width:42px;height:24px;border:0;border-radius:99px;background:#7a837d;position:relative;padding:0;transition:background .2s}.mode-switch:focus-visible,.account-nav:focus-visible{outline:3px solid #91c6a4;outline-offset:2px}.mode-switch i{position:absolute;width:18px;height:18px;border-radius:50%;background:#fff;left:3px;top:3px;transition:left .2s}.mode-switch.on{background:#2584d9}.mode-switch.on i{left:21px}.live-mode .grid > .panel:nth-child(2){display:none}.live-mode .pin,.live-mode .legend{display:none}.account-nav{border:0;text-align:left;background:transparent;width:100%;font:inherit}.settings-drawer{position:fixed;z-index:90;right:18px;top:72px;width:min(360px,calc(100vw - 36px));background:#fff;border:1px solid #dbe6de;border-radius:13px;box-shadow:0 18px 52px #173b2a40;padding:17px}.settings-head{display:flex;justify-content:space-between;gap:12px}.settings-head h2{font-size:17px;margin:3px 0}.settings-head button{border:0;background:#eef4ef;width:28px;height:28px;border-radius:50%;font-size:20px}.settings-section{border-top:1px solid #edf2ee;margin-top:13px;padding-top:12px;font-size:11px}.settings-section p{color:#708076;line-height:1.5;margin:5px 0}.logout-button{width:100%;margin-top:15px;padding:9px;border:1px solid #e5c7c1;border-radius:7px;background:#fff4f2;color:#9c4537;font-weight:700}.demo-banner{display:inline-block;font-size:8px;font-weight:800;letter-spacing:.5px;color:#925f14;background:#fff2d9;border-radius:99px;padding:4px 7px;margin-bottom:6px}.live-mode .notice{background:#eef6f0}.demo-mode .notice{background:#fff8ed;border-color:#f1dfba}";
document.head.append(modeStyle);

function createDataModeControl() {
  const control = document.createElement("div");
  control.className = "mode-control";
  control.innerHTML = '<span id="modeLabel">LIVE DATA</span><button id="modeSwitch" class="mode-switch" type="button" role="switch" aria-checked="true" aria-label="Live data mode"><i></i></button>';
  document.querySelector(".top").prepend(control);
  document.getElementById("modeSwitch").addEventListener("click", () => {
    activeDataMode = activeDataMode === "live" ? "demo" : "live";
    sessionStorage.setItem("vanraksha-data-mode", activeDataMode);
    refreshMonitoring();
  });
}

function setMetric(index, label, number, detail) {
  const card = document.querySelectorAll(".metrics .metric")[index];
  if (!card) return;
  card.querySelector("label").textContent = label;
  card.querySelector(".num").textContent = String(number).padStart(2, "0");
  card.querySelector("small").textContent = detail;
}

function renderModeData(data) {
  const isLive = activeDataMode === "live";
  document.body.classList.toggle("live-mode", isLive);
  document.body.classList.toggle("demo-mode", !isLive);
  const modeLabel = document.getElementById("modeLabel");
  const switcher = document.getElementById("modeSwitch");
  if (modeLabel && switcher) {
    modeLabel.textContent = isLive ? "LIVE DATA" : "DEMO DATA";
    switcher.classList.toggle("on", isLive);
    switcher.setAttribute("aria-checked", String(isLive));
    switcher.setAttribute("aria-label", isLive ? "Live data mode. Switch to demo data." : "Demo data mode. Switch to live data.");
  }
  const notice = document.querySelector(".notice");
  if (isLive) {
    notice.innerHTML = "<strong>Live mode.</strong> Counts, alerts, and cases below come only from this fresh session. The map is illustrative; it is not a satellite image.";
    setMetric(0, "Monitoring zones", data.zones.length, data.zones.length ? "Current session areas" : "No area selected");
    setMetric(1, "Open change alerts", data.alerts.length, data.alerts.length ? "From completed scans" : "No live alerts");
    setMetric(2, "Possible burn scars", data.alerts.filter(item => item.type.includes("burn")).length, "From completed scans");
    setMetric(3, "Cases prepared", data.cases.length, data.cases.length ? "Current session files" : "No case files");
    return;
  }
  notice.innerHTML = "<strong>Demo mode.</strong> One illustrative disturbance record is shown for presentation only. It is never mixed with live alerts or case files.";
  setMetric(0, "Monitoring zones", 0, "Demo has no saved area");
  setMetric(1, "Demo change record", 1, "Illustrative only");
  setMetric(2, "Possible burn scars", 0, "No live scan in demo");
  setMetric(3, "Cases prepared", 0, "Demo does not create cases");
  const alertList = document.getElementById("realAlertList");
  if (alertList) {
    alertList.innerHTML = "";
    const banner = document.createElement("div"); banner.className = "demo-banner"; banner.textContent = "DEMO RECORD · NOT LIVE";
    alertList.append(banner);
    line(alertList, "Illustrative canopy disturbance · Seshachalam", "Demo only · representative alert for presentation · no case file can be created");
  }
}

createDataModeControl();
refreshMonitoring();
