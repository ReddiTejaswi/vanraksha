import { getFireWeather } from "./services/weather.js";
import { countEventsNear, getOpenWildfires } from "./services/eonet.js";

const SESCHACHALAM = { latitude: 13.69, longitude: 79.27 };
const DEMO_CONTEXT = {
  temperature: 28,
  humidity: 42,
  wind: 8,
  nearbyWildfires: 2,
  riskScore: 72
};
const sampleCaseFiles = [
  { id: "VF-2026-002", alertId: "CW-104", status: "Prepared", date: "20 Oct 2026" },
  { id: "VF-2026-001", alertId: "CW-103", status: "Under review", date: "19 Oct 2026" }
];
let caseFiles = [...sampleCaseFiles];
let demoMode = true;
let aiConfigured = false;
let contextRequestId = 0;

const style = document.createElement("style");
style.textContent = `
  .nav { cursor:pointer; }
  .nav:focus-visible { outline:2px solid #91c6a4; outline-offset:2px; }
  .demo-toggle { display:flex; align-items:center; gap:6px; color:#40544a; font-size:10px; font-weight:700; cursor:pointer; }
  .demo-toggle input { accent-color:#246747; width:15px; height:15px; margin:0; }
  .workspace-page-heading { display:none; margin:0 0 16px; }
  .workspace-page-heading h1 { font-size:22px; margin:4px 0; }
  .workspace-page-heading p { color:#75837a; font-size:11px; margin:0; }
  .workspace-view { display:none; }
  .workspace-view .panel { overflow:hidden; }
  .workspace-view .ph { font-size:12px; font-weight:700; }
  .case-row, .zone-row { display:grid; grid-template-columns:1fr auto; gap:12px; align-items:center; padding:13px 15px; border-top:1px solid #edf1ee; }
  .case-row strong, .zone-row strong { display:block; font-size:11px; }
  .case-row small, .zone-row small { display:block; color:#75837a; font-size:9px; margin-top:4px; }
  .case-actions { display:flex; gap:6px; }
  .case-actions button { background:white; border:1px solid #e1e9e3; border-radius:6px; color:#40544a; padding:6px 8px; font-size:9px; }
  .empty-state { padding:18px 15px; color:#75837a; font-size:10px; line-height:1.5; }
  .mode-notice { margin-top:9px; padding:8px 10px; background:#fff8e9; border-radius:6px; color:#795f31; font-size:9px; line-height:1.45; }
  body:not([data-page="overview"]) .content > .overview-only { display:none !important; }
  body[data-page="overview"] .workspace-page-heading { display:none; }
  body[data-page="alerts"] .workspace-page-heading, body[data-page="cases"] .workspace-page-heading, body[data-page="zones"] .workspace-page-heading { display:block; }
  body[data-page="alerts"] .content > .grid { display:block !important; }
  body[data-page="alerts"] .map-panel { display:none; }
  body[data-page="alerts"] .alert-panel { max-width:760px; }
  body[data-page="cases"] #sectionCases, body[data-page="zones"] #sectionZones { display:block; }
  body[data-page="cases"] .ai-panel, body[data-page="zones"] .ai-panel { display:none; }
  .btn:disabled, .primary:disabled { opacity:.55; cursor:not-allowed; }
  .live-panel { background:#fff; border:1px solid #e1e9e3; border-radius:11px; margin:-2px 0 14px; overflow:hidden; box-shadow:0 3px 10px #233c2d08; }
  .live-title { padding:11px 15px; display:flex; justify-content:space-between; border-bottom:1px solid #edf1ee; font-size:11px; font-weight:700; }
  .live-source { color:#5c7967; font-size:9px; font-weight:600; }
  .live-grid { display:grid; grid-template-columns:repeat(3, 1fr); }
  .live-grid div { padding:12px 15px; border-right:1px solid #edf1ee; }
  .live-grid div:last-child { border-right:0; }
  .live-grid label, .live-grid small { display:block; font-size:9px; color:#75837a; }
  .live-grid strong { display:block; margin:5px 0 3px; font-size:13px; color:#20332a; }
  .ai-panel { background:#183b2a; border-radius:11px; color:#eff7f1; margin:-2px 0 14px; padding:14px 16px; }
  .ai-heading { display:flex; align-items:start; }
  .ai-heading strong { font-size:13px; }
  .ai-panel p { margin:10px 0; color:#d4e3d8; line-height:1.5; font-size:10px; }
  .ai-actions { display:flex; gap:9px; align-items:center; }
  .ai-actions button { border:0; border-radius:6px; background:#d6eddc; color:#173b28; padding:7px 9px; font-size:9px; font-weight:700; }
  @media(max-width:730px) { .live-grid { grid-template-columns:1fr; } .live-grid div { border-right:0; border-bottom:1px solid #edf1ee; } }
`;
document.head.append(style);

function createLivePanel() {
  const panel = document.createElement("section");
  panel.className = "live-panel overview-only";
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
      <strong>Ranger Brief</strong>
    </div>
    <p id="aiBrief">Generate a concise review brief for the selected alert.</p>
    <div class="ai-actions">
      <button id="askAgent" type="button">Generate ranger brief</button>
    </div>
  `;
  document.querySelector(".live-panel").after(panel);

  const mode = document.getElementById("briefMode");
  const ask = document.getElementById("askAgent");

  function renderBriefMode() {
    mode.textContent = demoMode ? "DEMO DATA" : aiConfigured ? "AI LIVE" : "AI NOT CONFIGURED";
  }

  async function loadAiStatus() {
    try {
      const response = await fetch("/api/ai/status");
      if (!response.ok) throw new Error("AI configuration status is unavailable.");
      const status = await response.json();
      aiConfigured = status.configured === true;
    } catch (error) {
      aiConfigured = false;
    }
    renderBriefMode();
  }

  ask.addEventListener("click", async () => {
    const selected = document.querySelector(".alert.sel");
    const title = selected?.querySelector(".aname")?.textContent || "selected forest-change alert";
    ask.disabled = true;
    ask.textContent = "Generating...";
    try {
      if (!demoMode && aiConfigured) {
        const response = await fetch("/api/ai/brief", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ alert_id: selected?.dataset.id })
        });
        const result = await response.json();
        if (!response.ok) throw new Error(result.detail || "AI brief request failed.");
        document.getElementById("aiBrief").textContent = result.brief;
      } else if (demoMode) {
        document.getElementById("aiBrief").textContent =
          `${title} should be reviewed first. Compare current and earlier imagery when available, confirm the coordinates against the protected-area boundary, and request a ranger field check.`;
      } else {
        throw new Error("AI is not configured. Set AI_API_KEY, AI_MODEL, and AI_BASE_URL in .env, then restart the server.");
      }
    } catch (error) {
      document.getElementById("aiBrief").textContent = `Unable to generate a brief: ${error.message}`;
    } finally {
      ask.disabled = false;
      ask.textContent = "Generate ranger brief";
    }
  });

  loadAiStatus();
  return { renderBriefMode };
}

function setLiveError(id, detail, fallback) {
  document.getElementById(id).textContent = fallback;
  document.getElementById(detail).textContent = "Live source unavailable; demo remains usable";
}

async function loadLiveContext() {
  const requestId = ++contextRequestId;
  if (demoMode) {
    return;
  }

  try {
    const response = await fetch("/api/context");
    if (!response.ok) throw new Error("Backend unavailable");
    const context = await response.json();
    if (requestId !== contextRequestId || demoMode) return;
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
      if (requestId !== contextRequestId || demoMode) return;
      const dry = weather.precipitation === 0 && weather.rainChance < 25;
      document.getElementById("weatherValue").textContent = dry ? "Dry conditions" : "Moist conditions";
      document.getElementById("weatherDetail").textContent = `${weather.temperature} C, ${weather.humidity}% humidity, ${weather.windSpeed} km/h wind`;
    } catch (weatherError) {
      setLiveError("weatherValue", "weatherDetail", "Unavailable");
    }

    try {
      const events = await getOpenWildfires();
      if (requestId !== contextRequestId || demoMode) return;
      const count = countEventsNear(events, SESCHACHALAM.latitude, SESCHACHALAM.longitude);
      document.getElementById("wildfireValue").textContent = `${count} in 50 km`;
      document.getElementById("wildfireDetail").textContent = "NASA EONET direct browser fallback";
      document.querySelector(".live-source").textContent = "Public context loaded";
    } catch (wildfireError) {
      setLiveError("wildfireValue", "wildfireDetail", "Unavailable");
    }
  }
}

function addWorkspaceViews() {
  const content = document.querySelector(".content");
  const notice = document.querySelector(".notice");
  const grid = document.querySelector(".grid");
  const [mapPanel, alertPanel] = grid.querySelectorAll(":scope > .panel");
  mapPanel.classList.add("map-panel", "overview-only");
  alertPanel.classList.add("alert-panel");
  document.querySelector(".head").classList.add("overview-only");
  notice.classList.add("overview-only");
  document.querySelector(".metrics").classList.add("overview-only");
  grid.classList.add("overview-only");
  document.querySelector(".bottom").classList.add("overview-only");

  const heading = document.createElement("section");
  heading.className = "workspace-page-heading";
  heading.innerHTML = '<div class="eyebrow">Forest monitoring</div><h1></h1><p></p>';
  content.prepend(heading);

  const cases = document.createElement("section");
  cases.id = "sectionCases";
  cases.className = "workspace-view";
  cases.innerHTML = `
    <div class="panel">
      <div class="ph">Case files <span class="sub" id="caseFileCount"></span></div>
      <div id="caseFileList"></div>
    </div>
  `;
  content.append(cases);

  const zones = document.createElement("section");
  zones.id = "sectionZones";
  zones.className = "workspace-view";
  zones.innerHTML = `
    <div class="panel">
      <div class="ph">Monitoring zones <span class="sub">4 sample areas</span></div>
      <div class="zone-row"><div><strong>Seshachalam Hills</strong><small>Active · 128 km² · Andhra Pradesh</small></div><span class="badge low">ACTIVE</span></div>
      <div class="zone-row"><div><strong>North ridge buffer</strong><small>Sample boundary · 42 km² · Last checked 20 Oct 2026</small></div><span class="badge med">MONITORING</span></div>
      <div class="zone-row"><div><strong>East buffer</strong><small>Sample boundary · 36 km² · Last checked 19 Oct 2026</small></div><span class="badge med">MONITORING</span></div>
      <div class="zone-row"><div><strong>South path reserve</strong><small>Sample boundary · 27 km² · Last checked 18 Oct 2026</small></div><span class="badge low">ACTIVE</span></div>
      <div class="mode-notice">These zone names and boundaries are illustrative demo records, not operational monitoring areas.</div>
    </div>
  `;
  content.append(zones);
}

function renderCaseFiles() {
  const list = document.getElementById("caseFileList");
  const count = document.getElementById("caseFileCount");
  list.replaceChildren();

  if (!demoMode) {
    count.textContent = "(0)";
    const empty = document.createElement("div");
    empty.className = "empty-state";
    empty.textContent = "AI mode does not create or verify case evidence. Sample case files are hidden; use the AI Ranger Brief on an alert for triage only.";
    list.append(empty);
    return;
  }

  count.textContent = `(${caseFiles.length})`;
  if (caseFiles.length === 0) {
    const empty = document.createElement("div");
    empty.className = "empty-state";
    empty.textContent = "No case files yet. Select an alert and prepare a sample case file.";
    list.append(empty);
    return;
  }

  for (const file of caseFiles) {
    const alert = document.querySelector(`.alert[data-id="${file.alertId}"]`);
    const row = document.createElement("div");
    row.className = "case-row";
    const description = document.createElement("div");
    const title = document.createElement("strong");
    title.textContent = file.id;
    const details = document.createElement("small");
    details.textContent = `${alert?.querySelector(".aname")?.textContent || file.alertId} · ${file.date} · ${file.status}`;
    description.append(title, details);

    const actions = document.createElement("div");
    actions.className = "case-actions";
    const open = document.createElement("button");
    open.type = "button";
    open.textContent = "Open alert";
    open.addEventListener("click", () => {
      showPage("alerts");
      document.querySelector(`.alert[data-id="${file.alertId}"]`)?.click();
    });
    actions.append(open);
    row.append(description, actions);
    list.append(row);
  }
}

const pageDetails = {
  overview: ["Overview", "Review monitoring activity and recent sample alerts."],
  alerts: ["Change alerts", "Inspect illustrative forest-change observations and review status."],
  cases: ["Case files", "Review prepared sample files and open their associated alerts."],
  zones: ["Monitoring zones", "Browse the illustrative areas configured for this prototype."]
};

function showPage(page) {
  const [title, description] = pageDetails[page] || pageDetails.overview;
  document.body.dataset.page = page in pageDetails ? page : "overview";
  document.querySelector(".top > span").innerHTML = `Monitoring &nbsp;/&nbsp; <b>${title}</b>`;
  const heading = document.querySelector(".workspace-page-heading");
  heading.querySelector("h1").textContent = title;
  heading.querySelector("p").textContent = description;

  document.querySelectorAll(".side .nav").forEach((item) => {
    const key = item.dataset.page;
    item.classList.toggle("on", key === document.body.dataset.page);
    item.setAttribute("aria-current", key === document.body.dataset.page ? "page" : "false");
  });
}

function setupNavigation() {
  const navPages = new Map([
    ["Overview", "overview"],
    ["Change alerts", "alerts"],
    ["Case files", "cases"],
    ["Monitoring zones", "zones"],
    ["Seshachalam Hills⌄", "zones"]
  ]);
  document.querySelectorAll(".side .nav").forEach((item) => {
    const labelElement = item.cloneNode(true);
    labelElement.querySelector("span")?.remove();
    const label = labelElement.textContent.replace(/\s+/g, " ").trim();
    const page = navPages.get(label);
    if (!page) return;
    item.dataset.page = page;
    item.setAttribute("role", "button");
    item.tabIndex = 0;
    item.addEventListener("click", () => showPage(page));
    item.addEventListener("keydown", (event) => {
      if (event.key === "Enter" || event.key === " ") {
        event.preventDefault();
        showPage(page);
      }
    });
  });
  showPage("overview");
}

function setDemoMode(enabled, briefMode) {
  demoMode = enabled;
  const toggle = document.getElementById("demoToggle");
  toggle.checked = demoMode;
  toggle.setAttribute("aria-checked", String(demoMode));
  try {
    localStorage.setItem("vanraksha-demo-mode", String(demoMode));
  } catch (error) {
    console.warn("Demo mode preference could not be saved.", error);
  }
  const notice = document.querySelector(".notice");
  notice.innerHTML = demoMode
    ? "<strong>Demo mode is on.</strong> Sample alerts, case files, and context are illustrative and are not live satellite findings."
    : "<strong>AI mode is on.</strong> The Ranger Brief uses configured AI. Alert records remain illustrative; AI does not detect forest changes or verify evidence.";

  if (demoMode) {
    document.getElementById("weatherValue").textContent = "Dry conditions";
    document.getElementById("weatherDetail").textContent = `${DEMO_CONTEXT.temperature} C, ${DEMO_CONTEXT.humidity}% humidity, ${DEMO_CONTEXT.wind} km/h wind · demo`;
    document.getElementById("wildfireValue").textContent = `${DEMO_CONTEXT.nearbyWildfires} in 50 km`;
    document.getElementById("wildfireDetail").textContent = `Demo events · illustrative triage score ${DEMO_CONTEXT.riskScore}/100`;
    document.querySelector(".live-source").textContent = "Illustrative demo context";
  } else {
    document.querySelector(".live-source").textContent = "Loading live public data...";
    loadLiveContext();
  }

  const caseButtons = [document.getElementById("case"), document.getElementById("create")];
  for (const button of caseButtons) {
    button.disabled = !demoMode;
    button.title = demoMode ? "" : "Switch Demo on to create an illustrative case file.";
  }
  renderCaseFiles();
  briefMode.renderBriefMode();
}

function setupDemoToggle(briefMode) {
  const topActions = document.querySelector(".top > div");
  const toggleLabel = document.createElement("label");
  toggleLabel.className = "demo-toggle";
  toggleLabel.innerHTML = '<input id="demoToggle" type="checkbox" aria-label="Demo mode"><span>Demo</span>';
  topActions.prepend(toggleLabel);

  let storedMode = null;
  try {
    storedMode = localStorage.getItem("vanraksha-demo-mode");
  } catch (error) {
    console.warn("Saved demo mode preference could not be read.", error);
  }
  const initialMode = storedMode === null ? true : storedMode === "true";
  toggleLabel.querySelector("input").addEventListener("change", (event) => {
    setDemoMode(event.currentTarget.checked, briefMode);
  });
  setDemoMode(initialMode, briefMode);
}

function trackPreparedCaseFiles() {
  const addCaseFile = () => {
    if (!demoMode) return;
    const alertId = document.querySelector(".alert.sel")?.dataset.id || "CW-104";
    const sequence = caseFiles.length + 1;
    caseFiles.unshift({
      id: `VF-2026-${String(sequence).padStart(3, "0")}`,
      alertId,
      status: "Prepared",
      date: new Intl.DateTimeFormat("en-GB", { day: "2-digit", month: "short", year: "numeric" }).format(new Date())
    });
    renderCaseFiles();
  };
  document.getElementById("case").addEventListener("click", addCaseFile);
  document.getElementById("create").addEventListener("click", addCaseFile);
}

createLivePanel();
const briefMode = createAiPanel();
addWorkspaceViews();
setupNavigation();
setupDemoToggle(briefMode);
trackPreparedCaseFiles();
renderCaseFiles();
