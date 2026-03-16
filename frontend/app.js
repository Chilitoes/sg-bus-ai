"use strict";

// ── Config ────────────────────────────────────────────────
const API_BASE         = "";
const REFRESH_MS       = 30_000;
const ARRIVING_THRESH  = 60;
const SOON_THRESH      = 5 * 60;
const AC_DEBOUNCE_MS   = 250;
const FAV_KEY          = "sgbusai_favs";
const THEME_KEY        = "sgbusai_theme";
const CARD_COLORS      = 8;

// ── State ─────────────────────────────────────────────────
const S = {
  stop:        null,
  stopInfo:    null,
  arrivals:    null,
  refreshTmr:  null,
  tickTmr:     null,
  acTmr:       null,
  favs:        loadFavs(),
  validStop:   false,
};
const charts = { service: null, hour: null, trend: null };

// ── DOM refs ──────────────────────────────────────────────
const $  = id => document.getElementById(id);
const el = {
  input:        $("stop-input"),
  searchBtn:    $("search-btn"),
  clearBtn:     $("search-clear"),
  ac:           $("autocomplete"),
  stopHeader:   $("stop-header"),
  stopCode:     $("stop-code-display"),
  stopName:     $("stop-name-display"),
  stopRoad:     $("stop-road-display"),
  lastUpd:      $("last-updated"),
  favBtn:       $("fav-btn"),
  refreshBtn:   $("refresh-btn"),
  errBanner:    $("arrivals-error"),
  grid:         $("arrivals-grid"),
  noSvc:        $("no-services"),
  legend:       $("legend"),
  charts:       $("charts-section"),
  noStats:      $("no-stats"),
  aiSection:    $("ai-section"),
  modelBadge:   $("model-badge"),
  modelDetail:  $("model-detail"),
  favCount:     $("fav-count"),
  favEmpty:     $("fav-empty"),
  favGrid:      $("fav-grid"),
  themeBtn:     $("theme-toggle"),
  overlay:      $("loading-overlay"),
  // Data tab
  dataErr:      $("data-error"),
  dataLoading:  $("data-loading"),
  statsGrid:    $("data-stats-grid"),
  monSection:   $("monitored-section"),
  monChips:     $("monitored-chips"),
  monCount:     $("monitored-count"),
  trackSection: $("tracking-section"),
  trackTbody:   $("tracking-tbody"),
  recSection:   $("records-section"),
  recTbody:     $("records-tbody"),
  dataRefresh:  $("data-refresh-btn"),
  quickFavs:    $("quick-favs"),
  quickFavsList: $("quick-favs-list"),
  noResults:    $("search-no-results"),
  monInput:     $("monitor-input"),
  monAddBtn:    $("monitor-add-btn"),
};

// ── Theme ─────────────────────────────────────────────────
function initTheme() {
  const saved = localStorage.getItem(THEME_KEY) || "light";
  setTheme(saved);
}
function setTheme(t) {
  document.documentElement.setAttribute("data-theme", t);
  el.themeBtn.textContent = t === "dark" ? "☀️" : "🌙";
  localStorage.setItem(THEME_KEY, t);
}
function toggleTheme() {
  const cur = document.documentElement.getAttribute("data-theme");
  setTheme(cur === "dark" ? "light" : "dark");
  // Redraw charts with new grid colour
  if (S.arrivals) redrawChartsIfOpen();
}

// ── Favourites ────────────────────────────────────────────
function loadFavs() {
  try { return JSON.parse(localStorage.getItem(FAV_KEY)) || []; }
  catch { return []; }
}
function saveFavs() { localStorage.setItem(FAV_KEY, JSON.stringify(S.favs)); }
function isFav(code) { return S.favs.some(f => f.code === code); }
function addFav(code, info = {}) {
  if (!isFav(code)) {
    S.favs.unshift({ code, description: info.description||null, road_name: info.road_name||null });
    saveFavs();
    api(`/api/monitor/${code}`, { method: "POST" }).catch(() => {});
  }
}
function removeFav(code) {
  S.favs = S.favs.filter(f => f.code !== code);
  saveFavs();
  api(`/api/monitor/${code}`, { method: "DELETE" }).catch(() => {});
}
function syncFavsToMonitor() {
  S.favs.forEach(f => api(`/api/monitor/${f.code}`, { method: "POST" }).catch(() => {}));
}
function syncFavBtn() {
  if (!S.stop) return;
  const saved = isFav(S.stop);
  el.favBtn.classList.toggle("active", saved);
  el.favBtn.title = saved ? "Remove from favourites" : "Save to favourites";
  const lbl = document.getElementById("fav-btn-label");
  const ico = document.getElementById("fav-btn-icon");
  if (lbl) lbl.textContent = saved ? "Remove" : "Save";
  if (ico) ico.setAttribute("fill", saved ? "currentColor" : "none");
}
function updateFavBadge() {
  const n = S.favs.length;
  el.favCount.textContent = n;
  el.favCount.classList.toggle("hidden", n === 0);
}
function renderFavGrid() {
  updateFavBadge();
  if (!S.favs.length) { show(el.favEmpty); el.favGrid.innerHTML = ""; return; }
  hide(el.favEmpty);
  el.favGrid.innerHTML = S.favs.map(f => `
    <div class="fav-card" data-code="${f.code}">
      <div class="fav-code">${f.code}</div>
      <div class="fav-info">
        <div class="fav-name">${f.description || "Bus Stop"}</div>
        <div class="fav-road">${f.road_name || ""}</div>
      </div>
      <button class="fav-remove" data-code="${f.code}" title="Remove">✕</button>
    </div>`).join("");
}
function renderQuickFavs() {
  if (!S.favs.length) { hide(el.quickFavs); return; }
  show(el.quickFavs);
  el.quickFavsList.innerHTML = S.favs.map(f => `
    <button class="qfav-chip" data-code="${f.code}">
      <span class="qfav-code">${f.code}</span>
      <span class="qfav-name">${f.description || "Bus Stop"}</span>
    </button>`).join("");
}

// ── Utilities ─────────────────────────────────────────────
function show(e) { e && e.classList.remove("hidden"); }
function hide(e) { e && e.classList.add("hidden"); }
function showOverlay()  { show(el.overlay); }
function hideOverlay()  { hide(el.overlay); }
function showErr(msg)   { el.errBanner.textContent = msg; show(el.errBanner); }
function clearErr()     { hide(el.errBanner); }

function parseUTC(iso) {
  if (!iso) return null;
  return new Date(iso.endsWith("Z") ? iso : iso + "Z");
}
function secsUntil(dt) { return dt ? (dt - Date.now()) / 1000 : null; }
function fmtTime(dt) {
  if (!dt) return "–";
  return dt.toLocaleTimeString("en-SG", { hour: "2-digit", minute: "2-digit", hour12: false });
}
function fmtCountdown(s) {
  if (s === null) return "–";
  if (s <= 0 || s < ARRIVING_THRESH) return "Arr";
  const m = Math.floor(s / 60);
  return m < 60 ? String(m) : `${Math.floor(m/60)}h${m%60}m`;
}
function cdClass(s) {
  if (s === null || s < ARRIVING_THRESH) return "arriving";
  return s < SOON_THRESH ? "soon" : "later";
}
function adjLabel(s) {
  if (Math.abs(s) < 10) return "";
  return `${s > 0 ? "+" : ""}${Math.round(s)}s`;
}
function adjClass(s) { return Math.abs(s) < 10 ? "" : s > 0 ? "late" : "early"; }

// ── Search validation ─────────────────────────────────────
function updateSearchBtn() {
  const valid = S.validStop || /^\d{5}$/.test(el.input.value.trim());
  el.searchBtn.disabled = !valid;
}

// ── API ───────────────────────────────────────────────────
async function api(path, opts = {}) {
  const r = await fetch(API_BASE + path, opts);
  if (!r.ok) { const b = await r.json().catch(()=>({})); throw new Error(b.detail || `HTTP ${r.status}`); }
  return r.json();
}

// ── Tabs ──────────────────────────────────────────────────
function activateTab(name) {
  document.querySelectorAll(".tab-btn").forEach(b =>
    b.classList.toggle("active", b.dataset.tab === name));
  document.querySelectorAll(".tab-panel").forEach(p => {
    const active = p.id === `tab-${name}`;
    p.classList.toggle("active", active);
    p.classList.toggle("hidden", !active);
  });
  if (name === "favourites") renderFavGrid();
  if (name === "data")       loadDataTab();
}

// ── Autocomplete ──────────────────────────────────────────
function hideAc() { hide(el.ac); el.ac.innerHTML = ""; }
async function doAc(q) {
  if (!q || q.length < 2) { hideAc(); hide(el.noResults); return; }
  try {
    const d = await api(`/api/stops/search?q=${encodeURIComponent(q)}&limit=8`);
    if (!d.results.length) {
      hideAc();
      show(el.noResults);
      S.validStop = false; updateSearchBtn();
      return;
    }
    hide(el.noResults);
    el.ac.innerHTML = d.results.map(s => `
      <div class="ac-item" data-code="${s.bus_stop_code}">
        <div class="ac-code">${s.bus_stop_code}</div>
        <div><div class="ac-name">${s.description||"Bus Stop"}</div>
             <div class="ac-road">${s.road_name||""}</div></div>
      </div>`).join("");
    show(el.ac);
  } catch { hideAc(); }
}

// ── Arrivals rendering ────────────────────────────────────
function busRowHtml(bus) {
  const aiDt  = parseUTC(bus.ai_arrival);
  const apiDt = parseUTC(bus.api_arrival);
  const secs  = secsUntil(aiDt);
  const adj   = bus.ai_adjustment_sec || 0;
  const load  = bus.load ? `<span class="load-pill ${bus.load}">${bus.load}</span>` : "";
  const adjHtml = adjLabel(adj) ? `<span class="adj ${adjClass(adj)}">${adjLabel(adj)}</span>` : "";
  return `
    <div class="bus-row">
      <div class="slot-badge">${bus.slot}</div>
      <div class="times">
        <div class="time-row time-api"><span class="dot gray"></span>${fmtTime(apiDt)} ${load}</div>
        <div class="time-row time-ai" ><span class="dot blue"></span>${fmtTime(aiDt)} ${adjHtml}</div>
      </div>
      <div class="countdown">
        <div class="cdval ${cdClass(secs)}" data-ai-iso="${bus.ai_arrival}">${fmtCountdown(secs)}</div>
        <span class="cdunit">${secs !== null && secs >= ARRIVING_THRESH ? "min" : ""}</span>
      </div>
    </div>`;
}

function svcCardHtml(svc, idx) {
  const fb   = svc.buses[0] || {};
  const type = fb.type    ? `<span class="type-tag">${fb.type}</span>` : "";
  const wab  = fb.feature === "WAB" ? `<span class="wab-tag">♿</span>` : "";
  const load = fb.load    ? `<span class="load-pill ${fb.load}">${fb.load}</span>` : "";
  const aiDt = parseUTC(fb.ai_arrival);
  const secs = secsUntil(aiDt);
  return `
    <div class="service-card collapsed">
      <button class="card-head c${idx % CARD_COLORS}" onclick="toggleCard(this)">
        <div class="card-head-main">
          <div class="card-svc-no">${svc.service_no}</div>
          <div class="card-operator">${svc.operator||""}</div>
        </div>
        <div class="card-head-meta">
          ${load}
          <div class="card-tags">${type}${wab}</div>
          <div class="card-next">
            <span class="cdval ${cdClass(secs)}" data-ai-iso="${fb.ai_arrival||""}">${fmtCountdown(secs)}</span>
            <span class="cdunit">${secs !== null && secs >= ARRIVING_THRESH ? "min" : ""}</span>
          </div>
          <svg class="expand-chevron" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><polyline points="6 9 12 15 18 9"/></svg>
        </div>
      </button>
      <div class="bus-list">${svc.buses.map(busRowHtml).join("")}</div>
    </div>`;
}

function toggleCard(btn) {
  btn.closest(".service-card").classList.toggle("collapsed");
}

function renderArrivals(data) {
  S.arrivals = data; clearErr();
  el.stopCode.textContent = data.bus_stop_code;
  el.lastUpd.textContent  = `Updated ${new Date().toLocaleTimeString("en-SG",
    { hour:"2-digit", minute:"2-digit", hour12:false })}`;
  show(el.stopHeader); show(el.legend); show(el.aiSection);
  if (!data.services?.length) { el.grid.innerHTML = ""; show(el.noSvc); return; }
  hide(el.noSvc);
  el.grid.innerHTML = data.services.map((s,i) => svcCardHtml(s,i)).join("");
  startTicker();
}

// ── Ticker ────────────────────────────────────────────────
function startTicker() {
  clearInterval(S.tickTmr);
  S.tickTmr = setInterval(() => {
    document.querySelectorAll(".cdval[data-ai-iso]").forEach(node => {
      const s    = secsUntil(parseUTC(node.dataset.aiIso));
      node.textContent = fmtCountdown(s);
      node.className   = `cdval ${cdClass(s)}`;
      if (node.nextElementSibling)
        node.nextElementSibling.textContent = s !== null && s >= ARRIVING_THRESH ? "min" : "";
    });
  }, 1000);
}

// ── Charts ────────────────────────────────────────────────
function destroyCharts() {
  Object.keys(charts).forEach(k => { if (charts[k]) { charts[k].destroy(); charts[k] = null; } });
}

function renderCharts(stats) {
  destroyCharts(); show(el.charts);
  if (!stats || stats.total_records === 0) { show(el.noStats); return; }
  hide(el.noStats);

  const dark = document.documentElement.getAttribute("data-theme") === "dark";
  const c = {
    grid:         dark ? "rgba(255,255,255,.05)" : "rgba(0,0,0,.06)",
    zeroLine:     dark ? "rgba(255,255,255,.18)" : "rgba(0,0,0,.18)",
    late:         "rgba(239,68,68,.75)",
    lateSolid:    "#ef4444",
    early:        "rgba(59,130,246,.75)",
    earlySolid:   "#3b82f6",
    peak:         "rgba(249,115,22,.8)",
    offpeak:      "rgba(99,102,241,.65)",
    trend:        "#8b5cf6",
    trendFill:    dark ? "rgba(139,92,246,.15)" : "rgba(139,92,246,.1)",
    text:         dark ? "#94a3b8" : "#6b7280",
    tooltipBg:    dark ? "#1e293b" : "#ffffff",
    tooltipBorder:dark ? "#334155" : "#e2e8f0",
    tooltipTitle: dark ? "#f1f5f9" : "#0f172a",
    tooltipBody:  dark ? "#94a3b8" : "#475569",
    pointBorder:  dark ? "#1e293b" : "#ffffff",
  };

  const fmtDelay = (v) => {
    if (v === null || v === undefined) return "No data";
    const abs = Math.abs(v);
    const m = Math.floor(abs / 60), s = Math.round(abs % 60);
    const t = m > 0 ? `${m}m ${s}s` : `${s}s`;
    if (Math.abs(v) < 5) return "On time";
    return v > 0 ? `▲ ${t} late` : `▼ ${t} early`;
  };

  const tooltip = {
    backgroundColor: c.tooltipBg,
    titleColor: c.tooltipTitle,
    bodyColor: c.tooltipBody,
    borderColor: c.tooltipBorder,
    borderWidth: 1,
    padding: { x: 12, y: 8 },
    cornerRadius: 8,
    displayColors: false,
  };

  const yScale = {
    grid: {
      color: (ctx) => ctx.tick.value === 0 ? c.zeroLine : c.grid,
      lineWidth: (ctx) => ctx.tick.value === 0 ? 1.5 : 1,
    },
    border: { dash: [3, 3], display: false },
    ticks: {
      color: c.text, font: { size: 11 },
      callback: (v) => { const r = Math.round(v); return r === 0 ? "0s" : `${r > 0 ? "+" : ""}${r}s`; },
    },
  };
  const xScale = {
    grid: { display: false },
    border: { display: false },
    ticks: { color: c.text, font: { size: 11 } },
  };

  // ── Chart 1: Delay by route (sorted worst-first) ───────
  if (stats.by_service?.length) {
    const sorted = [...stats.by_service].sort((a, b) => b.avg_delay_sec - a.avg_delay_sec);
    charts.service = new Chart($("chart-service"), {
      type: "bar",
      data: {
        labels: sorted.map(s => s.service),
        datasets: [{
          data: sorted.map(s => s.avg_delay_sec),
          backgroundColor: sorted.map(s => s.avg_delay_sec >= 0 ? c.late : c.early),
          borderColor:     sorted.map(s => s.avg_delay_sec >= 0 ? c.lateSolid : c.earlySolid),
          borderWidth: 1.5, borderRadius: 6, borderSkipped: false,
        }],
      },
      options: {
        responsive: true, maintainAspectRatio: false,
        interaction: { mode: "index", intersect: false },
        plugins: {
          legend: { display: false },
          tooltip: { ...tooltip, callbacks: {
            title: (i) => `Bus ${i[0].label}`,
            label: (i) => ` ${fmtDelay(i.raw)}`,
          }},
        },
        scales: { y: yScale, x: xScale },
      },
    });
  }

  // ── Chart 2: Delay by hour ─────────────────────────────
  if (stats.by_hour) {
    const isPeak = (h) => (h >= 7 && h < 9) || (h >= 17 && h < 19);
    const noService = (h) => h >= 1 && h <= 4;  // SGT 1–5am: no buses
    const hlabel = (h) => h === 0 ? "12am" : h === 12 ? "12pm" : h < 12 ? `${h}am` : `${h - 12}pm`;
    const labels = Array.from({ length: 24 }, (_, i) => hlabel(i));
    charts.hour = new Chart($("chart-hour"), {
      type: "bar",
      data: {
        labels,
        datasets: [{
          data: stats.by_hour.map((v, i) => noService(i) ? null : v),
          backgroundColor: labels.map((_, i) => noService(i) ? "transparent" : isPeak(i) ? c.peak : c.offpeak),
          borderRadius: 4, borderSkipped: false,
        }],
      },
      options: {
        responsive: true, maintainAspectRatio: false,
        interaction: { mode: "index", intersect: false },
        plugins: {
          legend: { display: false },
          tooltip: { ...tooltip, callbacks: {
            title: (i) => {
              const h = i[0].dataIndex;
              return `${hlabel(h)} – ${hlabel(h < 23 ? h + 1 : 0)}${isPeak(h) ? " · Peak" : ""}`;
            },
            label: (i) => ` ${fmtDelay(i.raw)}`,
          }},
        },
        scales: {
          y: yScale,
          x: { ...xScale, ticks: { ...xScale.ticks, maxTicksLimit: 8 } },
        },
      },
    });
  }

  // ── Chart 3: 14-day trend ──────────────────────────────
  if (stats.trend?.length) {
    const dlabel = (d) => {
      const dt = new Date(d + "T00:00:00");
      return dt.toLocaleDateString("en-SG", { weekday: "short", day: "numeric", month: "short" });
    };
    // Update trend badge with direction
    const vals = stats.trend.map(t => t.avg_delay_sec).filter(v => v !== null);
    if (vals.length >= 2) {
      const first = vals.slice(0, Math.ceil(vals.length / 2)).reduce((a, b) => a + b, 0) / Math.ceil(vals.length / 2);
      const last  = vals.slice(-Math.ceil(vals.length / 2)).reduce((a, b) => a + b, 0) / Math.ceil(vals.length / 2);
      const badge = $("trend-badge");
      if (badge) badge.textContent = last < first ? "✓ Improving" : last > first ? "⚠ Worsening" : "Stable";
    }
    charts.trend = new Chart($("chart-trend"), {
      type: "line",
      data: {
        labels: stats.trend.map(t => dlabel(t.date)),
        datasets: [{
          data: stats.trend.map(t => t.avg_delay_sec),
          borderColor: c.trend, backgroundColor: c.trendFill,
          fill: true, tension: 0.4, borderWidth: 2.5,
          pointRadius: 4, pointHoverRadius: 7,
          pointBackgroundColor: c.trend,
          pointBorderColor: c.pointBorder, pointBorderWidth: 2,
        }],
      },
      options: {
        responsive: true, maintainAspectRatio: false,
        interaction: { mode: "index", intersect: false },
        plugins: {
          legend: { display: false },
          tooltip: { ...tooltip, callbacks: {
            title: (i) => i[0].label,
            label: (i) => ` ${fmtDelay(i.raw)}`,
          }},
        },
        scales: { y: yScale, x: xScale },
      },
    });
  }
}
function redrawChartsIfOpen() {
  // Only redraw if charts section is visible and we have cached stats
  if (el.charts.classList.contains("hidden")) return;
  // Re-request stats and redraw
  if (S.stop) api(`/api/stats/${S.stop}`).then(renderCharts).catch(()=>{});
}

// ── Model badge ───────────────────────────────────────────
async function loadModelBadge() {
  try {
    const s = await api("/api/model/status");
    el.modelBadge.textContent = `AI · MAE ${s.mae_seconds??'–'}s · ${s.training_rows} rows`;
    el.modelBadge.classList.add("ready");
    if (el.modelDetail) el.modelDetail.innerHTML = `
      <strong>Algorithm:</strong> ${s.algorithm}<br>
      <strong>Training rows:</strong> ${s.training_rows}<br>
      <strong>MAE:</strong> ${s.mae_seconds??'–'} s<br>
      <strong>Last trained:</strong> ${s.last_trained
        ? new Date(s.last_trained+"Z").toLocaleString("en-SG") : "–"}`;
  } catch { el.modelBadge.textContent = "AI model"; }
}

// ── Main load ─────────────────────────────────────────────
async function loadStop(code) {
  code = code.trim(); if (!code) return;
  clearInterval(S.refreshTmr); clearInterval(S.tickTmr);
  S.stop = code; hideAc(); clearErr(); showOverlay();
  try {
    const [arrivals, stats, stopInfo] = await Promise.all([
      api(`/api/arrivals/${code}`),
      api(`/api/stats/${code}`).catch(()=>null),
      api(`/api/stops/${code}`).catch(()=>null),
    ]);
    S.stopInfo = stopInfo;
    el.stopName.textContent = stopInfo?.description || "";
    el.stopRoad.textContent = stopInfo?.road_name   || "";
    renderArrivals(arrivals);
    renderCharts(stats);
    syncFavBtn(); updateFavBadge(); renderQuickFavs();
    activateTab("search");
    location.hash = code;
    S.refreshTmr = setInterval(() => refreshStop(code), REFRESH_MS);
  } catch (err) {
    show(el.stopHeader); el.stopCode.textContent = code;
    showErr(`Could not load arrivals: ${err.message}`);
  } finally { hideOverlay(); }
}

async function refreshStop(code) {
  try {
    const arrivals = await api(`/api/arrivals/${code}`);
    renderArrivals(arrivals); clearErr();
  } catch (err) { showErr(`Refresh failed: ${err.message}`); }
}

// ── Data tab ──────────────────────────────────────────────
async function loadDataTab() {
  show(el.dataLoading); hide(el.dataErr); hide(el.statsGrid);
  hide(el.monSection); hide(el.trackSection); hide(el.recSection);
  try {
    const d = await api("/api/data");

    // Stat cards
    const db = d.database;
    const isPostgres = db.type === "PostgreSQL";
    $("stat-db-type-val").textContent  = db.type;
    $("stat-db-type-val").className    = "stat-value " + (isPostgres ? "stat-ok" : "stat-warn");
$("stat-arrivals").textContent     = db.arrival_records.toLocaleString();
    $("stat-labeled").textContent      = db.labeled_records.toLocaleString();
    $("stat-stops").textContent        = db.bus_stops.toLocaleString();
    $("stat-mae").textContent          = d.model.mae_seconds ?? "–";
    $("stat-train-rows").textContent   = d.model.training_rows.toLocaleString();
    hide(el.dataLoading); show(el.statsGrid);

    // Monitored stops
    el.monCount.textContent = d.monitored_stops?.length || 0;
    el.monChips.innerHTML   = (d.monitored_stops || [])
      .map(s => `<span class="monitor-chip">${s}<button class="mon-remove" data-code="${s}" title="Stop monitoring">✕</button></span>`)
      .join("");
    show(el.monSection);

    // Tracking table
    if (d.recent_tracking?.length) {
      el.trackTbody.innerHTML = d.recent_tracking.map(t => {
        const dc = t.delay_seconds === null ? "delay-nil"
                 : t.delay_seconds > 0 ? "delay-pos" : "delay-neg";
        const dv = t.delay_seconds !== null ? `${t.delay_seconds > 0?"+":""}${t.delay_seconds}s` : "–";
        return `<tr>
          <td>${t.bus_stop_code}</td>
          <td>${t.bus_service}</td>
          <td>${t.first_seen ? t.first_seen.slice(0,16).replace("T"," ") : "–"}</td>
          <td class="${dc}">${dv}</td>
        </tr>`;
      }).join("");
      show(el.trackSection);
    }

    // Records table
    if (d.recent_records?.length) {
      el.recTbody.innerHTML = d.recent_records.map(r => {
        const dc = r.delay_seconds === null ? "delay-nil"
                 : r.delay_seconds > 0 ? "delay-pos" : "delay-neg";
        const dv = r.delay_seconds !== null ? `${r.delay_seconds > 0?"+":""}${r.delay_seconds}s` : "–";
        return `<tr>
          <td>${r.bus_stop_code}</td>
          <td>${r.bus_service}</td>
          <td>${r.collection_time ? r.collection_time.slice(0,16).replace("T"," ") : "–"}</td>
          <td>${r.wait_seconds ?? "–"}</td>
          <td class="${dc}">${dv}</td>
          <td>${r.bus_load ? `<span class="load-pill ${r.bus_load}">${r.bus_load}</span>` : "–"}</td>
          <td>${r.is_peak ? "✓" : "–"}</td>
        </tr>`;
      }).join("");
      show(el.recSection);
    }
  } catch (err) {
    hide(el.dataLoading);
    el.dataErr.textContent = `Failed to load data: ${err.message}`;
    show(el.dataErr);
  }
}

// ── Event listeners ───────────────────────────────────────

// Theme
el.themeBtn.addEventListener("click", toggleTheme);

// Tabs
document.querySelectorAll(".tab-btn").forEach(b =>
  b.addEventListener("click", () => activateTab(b.dataset.tab)));

// Search
el.searchBtn.addEventListener("click", () => loadStop(el.input.value));
el.input.addEventListener("keydown", e => {
  if (e.key === "Enter")  { loadStop(el.input.value); hideAc(); }
  if (e.key === "Escape") { hideAc(); }
});
el.input.addEventListener("input", () => {
  const v = el.input.value.trim();
  v.length ? show(el.clearBtn) : hide(el.clearBtn);
  S.validStop = false; hide(el.noResults); updateSearchBtn();
  clearTimeout(S.acTmr);
  S.acTmr = setTimeout(() => doAc(v), AC_DEBOUNCE_MS);
});
el.clearBtn.addEventListener("click", () => {
  el.input.value = ""; hide(el.clearBtn); hideAc();
  S.validStop = false; hide(el.noResults); updateSearchBtn();
  el.input.focus();
});
document.addEventListener("click", e => {
  if (!el.ac.contains(e.target) && e.target !== el.input) hideAc();
});
el.ac.addEventListener("click", e => {
  const item = e.target.closest(".ac-item");
  if (item) {
    el.input.value = item.dataset.code;
    S.validStop = true; hide(el.noResults); updateSearchBtn();
    loadStop(item.dataset.code);
  }
});

// Quick chips
document.querySelectorAll(".chip[data-stop]").forEach(c =>
  c.addEventListener("click", () => {
    el.input.value = c.dataset.stop;
    S.validStop = true; hide(el.noResults); updateSearchBtn();
    loadStop(c.dataset.stop);
  }));

// Stop header actions
el.refreshBtn.addEventListener("click", () => { if (S.stop) loadStop(S.stop); });
el.favBtn.addEventListener("click", () => {
  if (!S.stop) return;
  isFav(S.stop) ? removeFav(S.stop) : addFav(S.stop, S.stopInfo || {});
  syncFavBtn(); updateFavBadge(); renderQuickFavs();
});

// Fav grid (delegation)
el.favGrid.addEventListener("click", e => {
  const rem = e.target.closest(".fav-remove");
  if (rem) {
    e.stopPropagation();
    removeFav(rem.dataset.code);
    renderFavGrid(); renderQuickFavs();
    if (S.stop === rem.dataset.code) syncFavBtn();
    return;
  }
  const card = e.target.closest(".fav-card");
  if (card) { el.input.value = card.dataset.code; loadStop(card.dataset.code); }
});

// ── Monitor management ────────────────────────────────────
async function addMonitor(code) {
  code = code.trim().toUpperCase();
  if (!code) return;
  try { await api(`/api/monitor/${code}`, { method: "POST" }); loadDataTab(); }
  catch (err) { alert(`Could not add monitor: ${err.message}`); }
}
async function removeMonitor(code) {
  try { await api(`/api/monitor/${code}`, { method: "DELETE" }); loadDataTab(); }
  catch (err) { alert(`Could not remove monitor: ${err.message}`); }
}

// Monitored chips delegation (remove)
el.monChips.addEventListener("click", e => {
  const btn = e.target.closest(".mon-remove");
  if (btn) removeMonitor(btn.dataset.code);
});

// Monitor add button
el.monAddBtn && el.monAddBtn.addEventListener("click", () => {
  addMonitor(el.monInput.value);
  el.monInput.value = "";
});
el.monInput && el.monInput.addEventListener("keydown", e => {
  if (e.key === "Enter") { addMonitor(el.monInput.value); el.monInput.value = ""; }
});

// Quick-favs delegation
el.quickFavsList.addEventListener("click", e => {
  const chip = e.target.closest(".qfav-chip");
  if (chip) { el.input.value = chip.dataset.code; loadStop(chip.dataset.code); }
});

// Data tab refresh
el.dataRefresh && el.dataRefresh.addEventListener("click", loadDataTab);

// Cleanup
window.addEventListener("pagehide", () => {
  clearInterval(S.refreshTmr); clearInterval(S.tickTmr);
});

// ── Init ──────────────────────────────────────────────────
initTheme();
updateFavBadge();
renderQuickFavs();
loadModelBadge();
syncFavsToMonitor();
const hash = location.hash.replace("#","").trim();
if (hash && /^\d+$/.test(hash)) { el.input.value = hash; loadStop(hash); }
