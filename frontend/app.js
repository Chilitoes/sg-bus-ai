"use strict";

// ── Config ────────────────────────────────────────────────────────
const API_BASE          = "";
const REFRESH_INTERVAL  = 30_000;
const ARRIVING_THRESH   = 60;
const SOON_THRESH       = 5 * 60;
const AUTOCOMPLETE_DELAY = 250;  // ms debounce
const FAV_KEY           = "sg_bus_ai_favourites";

// Card header colours (cycles per service)
const CARD_COLORS = 8;

// ── State ─────────────────────────────────────────────────────────
const state = {
  currentStop:    null,
  stopInfo:       null,   // { bus_stop_code, description, road_name }
  arrivalData:    null,
  refreshTimer:   null,
  tickTimer:      null,
  acTimer:        null,   // autocomplete debounce
  favourites:     loadFavourites(),
};

// ── Chart instances ───────────────────────────────────────────────
const charts = { service: null, hour: null, trend: null };

// ── DOM ───────────────────────────────────────────────────────────
const $ = id => document.getElementById(id);
const el = {
  stopInput:       $("stop-input"),
  searchBtn:       $("search-btn"),
  searchClear:     $("search-clear"),
  autocomplete:    $("autocomplete"),
  stopHeader:      $("stop-header"),
  stopCodeDisplay: $("stop-code-display"),
  stopName:        $("stop-name-display"),
  stopRoad:        $("stop-road-display"),
  lastUpdated:     $("last-updated"),
  favBtn:          $("fav-btn"),
  refreshBtn:      $("refresh-btn"),
  arrivalsError:   $("arrivals-error"),
  arrivalsGrid:    $("arrivals-grid"),
  noServices:      $("no-services"),
  legend:          $("legend"),
  chartsSection:   $("charts-section"),
  noStats:         $("no-stats"),
  aiSection:       $("ai-section"),
  modelBadge:      $("model-badge"),
  modelDetail:     $("model-detail"),
  loadingOverlay:  $("loading-overlay"),
  favCount:        $("fav-count"),
  favGrid:         $("fav-grid"),
  favEmpty:        $("fav-empty"),
};

// ── Favourites persistence ────────────────────────────────────────

function loadFavourites() {
  try { return JSON.parse(localStorage.getItem(FAV_KEY)) || []; }
  catch { return []; }
}

function saveFavourites() {
  localStorage.setItem(FAV_KEY, JSON.stringify(state.favourites));
}

function isFavourite(code) {
  return state.favourites.some(f => f.code === code);
}

function addFavourite(code, info = {}) {
  if (!isFavourite(code)) {
    state.favourites.unshift({
      code,
      description: info.description || null,
      road_name:   info.road_name   || null,
    });
    saveFavourites();
  }
}

function removeFavourite(code) {
  state.favourites = state.favourites.filter(f => f.code !== code);
  saveFavourites();
}

// ── Utilities ─────────────────────────────────────────────────────

function show(elRef) { elRef.classList.remove("hidden"); }
function hide(elRef) { elRef.classList.add("hidden"); }
function showLoading()  { show(el.loadingOverlay); }
function hideLoading()  { hide(el.loadingOverlay); }
function showError(msg) { el.arrivalsError.textContent = msg; show(el.arrivalsError); }
function clearError()   { hide(el.arrivalsError); }

function parseUTC(iso) {
  if (!iso) return null;
  return new Date(iso.endsWith("Z") ? iso : iso + "Z");
}

function secsUntil(dt) {
  return dt ? (dt - Date.now()) / 1000 : null;
}

function fmtTime(dt) {
  if (!dt) return "–";
  return dt.toLocaleTimeString("en-SG", { hour: "2-digit", minute: "2-digit", hour12: false });
}

function fmtCountdown(secs) {
  if (secs === null) return "–";
  if (secs <= 0 || secs < ARRIVING_THRESH) return "Arr";
  const mins = Math.floor(secs / 60);
  if (mins < 60) return String(mins);
  return `${Math.floor(mins/60)}h${mins%60}m`;
}

function countdownClass(secs) {
  if (secs === null || secs < ARRIVING_THRESH) return "arriving";
  if (secs < SOON_THRESH) return "soon";
  return "later";
}

function adjLabel(sec) {
  if (Math.abs(sec) < 10) return "";
  const sign = sec > 0 ? "+" : "";
  return `${sign}${Math.round(sec)}s`;
}

function adjClass(sec) {
  if (Math.abs(sec) < 10) return "";
  return sec > 0 ? "late" : "early";
}

// ── API ───────────────────────────────────────────────────────────

async function apiFetch(path) {
  const r = await fetch(API_BASE + path);
  if (!r.ok) {
    const b = await r.json().catch(() => ({}));
    throw new Error(b.detail || `HTTP ${r.status}`);
  }
  return r.json();
}

// ── Tabs ──────────────────────────────────────────────────────────

function activateTab(name) {
  document.querySelectorAll(".tab-btn").forEach(b => {
    b.classList.toggle("active", b.dataset.tab === name);
  });
  document.querySelectorAll(".tab-panel").forEach(p => {
    p.classList.toggle("active", p.id === `tab-${name}`);
    p.classList.toggle("hidden", p.id !== `tab-${name}`);
  });
  if (name === "favourites") renderFavGrid();
}

// ── Favourites UI ─────────────────────────────────────────────────

function updateFavBadge() {
  const n = state.favourites.length;
  el.favCount.textContent = n;
  n > 0 ? show(el.favCount) : hide(el.favCount);
}

function renderFavGrid() {
  updateFavBadge();
  if (state.favourites.length === 0) {
    show(el.favEmpty);
    el.favGrid.innerHTML = "";
    return;
  }
  hide(el.favEmpty);
  el.favGrid.innerHTML = state.favourites.map(f => `
    <div class="fav-card" data-code="${f.code}">
      <div class="fav-card-code">${f.code}</div>
      <div class="fav-card-info">
        <div class="fav-card-name">${f.description || "Bus Stop"}</div>
        <div class="fav-card-road">${f.road_name   || ""}</div>
      </div>
      <button class="fav-card-remove" data-code="${f.code}" title="Remove">✕</button>
    </div>
  `).join("");
}

function syncFavBtn() {
  if (!state.currentStop) return;
  if (isFavourite(state.currentStop)) {
    el.favBtn.textContent = "★";
    el.favBtn.classList.add("is-fav");
    el.favBtn.title = "Remove from favourites";
  } else {
    el.favBtn.textContent = "☆";
    el.favBtn.classList.remove("is-fav");
    el.favBtn.title = "Add to favourites";
  }
}

// ── Autocomplete ──────────────────────────────────────────────────

function hideAutocomplete() {
  hide(el.autocomplete);
  el.autocomplete.innerHTML = "";
}

async function doAutocomplete(q) {
  if (!q || q.length < 2) { hideAutocomplete(); return; }
  try {
    const data = await apiFetch(`/api/stops/search?q=${encodeURIComponent(q)}&limit=8`);
    if (!data.results.length) { hideAutocomplete(); return; }
    el.autocomplete.innerHTML = data.results.map(s => `
      <div class="autocomplete-item" data-code="${s.bus_stop_code}">
        <div class="ac-code">${s.bus_stop_code}</div>
        <div class="ac-info">
          <div class="ac-name">${s.description || "Bus Stop"}</div>
          <div class="ac-road">${s.road_name || ""}</div>
        </div>
      </div>
    `).join("");
    show(el.autocomplete);
  } catch { hideAutocomplete(); }
}

// ── Arrivals rendering ────────────────────────────────────────────

function renderBusRow(bus, idx) {
  const apiDt = parseUTC(bus.api_arrival);
  const aiDt  = parseUTC(bus.ai_arrival);
  const aiSec = secsUntil(aiDt);
  const adj   = bus.ai_adjustment_sec || 0;
  const loadHtml = bus.load
    ? `<span class="load-pill ${bus.load}">${bus.load}</span>` : "";
  const adjHtml = adjLabel(adj)
    ? `<span class="adj-tag ${adjClass(adj)}">${adjLabel(adj)}</span>` : "";

  return `
    <div class="bus-row" data-ai-iso="${bus.ai_arrival}">
      <div class="slot-no">${bus.slot}</div>
      <div class="times">
        <div class="api-row">
          <span class="dot dot-gray"></span>
          <span class="time-val">${fmtTime(apiDt)}</span>
          ${loadHtml}
        </div>
        <div class="ai-row">
          <span class="dot dot-blue"></span>
          <span class="time-val">${fmtTime(aiDt)}</span>
          ${adjHtml}
        </div>
      </div>
      <div class="countdown-col">
        <div class="countdown-val ${countdownClass(aiSec)}" data-ai-iso="${bus.ai_arrival}">
          ${fmtCountdown(aiSec)}
        </div>
        <span class="countdown-unit">${aiSec !== null && aiSec >= ARRIVING_THRESH ? "min" : ""}</span>
      </div>
    </div>`;
}

function renderServiceCard(svc, idx) {
  const colorClass = `card-color-${idx % CARD_COLORS}`;
  const firstBus   = svc.buses[0] || {};
  const typeTag    = firstBus.type    ? `<span class="type-tag">${firstBus.type}</span>`   : "";
  const wabTag     = firstBus.feature === "WAB" ? `<span class="wab-tag">♿</span>` : "";
  return `
    <div class="service-card">
      <div class="card-header ${colorClass}">
        <div>
          <div class="card-service-no">${svc.service_no}</div>
          <div class="card-operator">${svc.operator || ""}</div>
        </div>
        <div class="card-tags">${typeTag}${wabTag}</div>
      </div>
      <div class="bus-list">${svc.buses.map((b, i) => renderBusRow(b, i)).join("")}</div>
    </div>`;
}

function renderArrivals(data) {
  state.arrivalData = data;
  clearError();

  el.stopCodeDisplay.textContent = data.bus_stop_code;
  el.lastUpdated.textContent = `Updated ${new Date().toLocaleTimeString("en-SG",
    { hour: "2-digit", minute: "2-digit", hour12: false })}`;

  show(el.stopHeader);
  show(el.legend);
  show(el.aiSection);

  if (!data.services?.length) {
    el.arrivalsGrid.innerHTML = "";
    show(el.noServices);
    return;
  }
  hide(el.noServices);
  el.arrivalsGrid.innerHTML = data.services.map((s, i) => renderServiceCard(s, i)).join("");
  startTicker();
}

// ── Countdown ticker ──────────────────────────────────────────────

function startTicker() {
  if (state.tickTimer) clearInterval(state.tickTimer);
  state.tickTimer = setInterval(() => {
    document.querySelectorAll(".countdown-val[data-ai-iso]").forEach(el => {
      const dt   = parseUTC(el.dataset.aiIso);
      const secs = secsUntil(dt);
      el.textContent = fmtCountdown(secs);
      el.className   = `countdown-val ${countdownClass(secs)}`;
      const unit = el.nextElementSibling;
      if (unit) unit.textContent = secs !== null && secs >= ARRIVING_THRESH ? "min" : "";
    });
  }, 1000);
}

// ── Charts ────────────────────────────────────────────────────────

function destroyCharts() {
  Object.keys(charts).forEach(k => { if (charts[k]) { charts[k].destroy(); charts[k] = null; } });
}

function renderCharts(stats) {
  destroyCharts();
  show(el.chartsSection);
  if (!stats || stats.total_records === 0) { show(el.noStats); return; }
  hide(el.noStats);

  const gridColor  = "#e2e8f0";
  const brandColor = "rgba(230,57,70,.8)";
  const blueColor  = "rgba(0,119,182,.7)";

  // By service
  if (stats.by_service?.length) {
    charts.service = new Chart($("chart-service"), {
      type: "bar",
      data: {
        labels:   stats.by_service.map(s => `${s.service}`),
        datasets: [{
          data:            stats.by_service.map(s => s.avg_delay_sec),
          backgroundColor: stats.by_service.map(s => s.avg_delay_sec > 0 ? brandColor : blueColor),
          borderRadius: 4,
        }],
      },
      options: {
        responsive: true, maintainAspectRatio: false,
        plugins: { legend: { display: false } },
        scales: {
          y: { title: { display: true, text: "seconds" }, grid: { color: gridColor } },
          x: { grid: { display: false } },
        },
      },
    });
  }

  // By hour
  if (stats.by_hour) {
    const labels = Array.from({ length: 24 }, (_, i) => `${i}h`);
    charts.hour = new Chart($("chart-hour"), {
      type: "bar",
      data: {
        labels,
        datasets: [{
          data: stats.by_hour,
          backgroundColor: labels.map((_, i) =>
            (i >= 7 && i < 9) || (i >= 17 && i < 19) ? brandColor : blueColor),
          borderRadius: 2,
        }],
      },
      options: {
        responsive: true, maintainAspectRatio: false,
        plugins: { legend: { display: false },
          tooltip: { callbacks: { title: items => {
            const h = items[0].dataIndex;
            return `${h}:00 — ${(h>=7&&h<9)||(h>=17&&h<19) ? "Peak" : "Off-peak"}`;
          }}},
        },
        scales: {
          y: { title: { display: true, text: "seconds" }, grid: { color: gridColor } },
          x: { grid: { display: false }, ticks: { maxTicksLimit: 12 } },
        },
      },
    });
  }

  // Trend
  if (stats.trend?.length) {
    charts.trend = new Chart($("chart-trend"), {
      type: "line",
      data: {
        labels: stats.trend.map(t => t.date),
        datasets: [{
          data:            stats.trend.map(t => t.avg_delay_sec),
          borderColor:     "rgba(0,119,182,1)",
          backgroundColor: "rgba(0,119,182,.1)",
          fill: true, tension: 0.35,
          pointRadius: 4, pointBackgroundColor: "rgba(0,119,182,1)",
        }],
      },
      options: {
        responsive: true, maintainAspectRatio: false,
        plugins: { legend: { display: false } },
        scales: {
          y: { title: { display: true, text: "seconds" }, grid: { color: gridColor } },
          x: { grid: { display: false } },
        },
      },
    });
  }
}

// ── Model badge ───────────────────────────────────────────────────

async function loadModelStatus() {
  try {
    const s = await apiFetch("/api/model/status");
    el.modelBadge.textContent = `AI · MAE ${s.mae_seconds ?? "–"}s · ${s.training_rows} rows`;
    el.modelBadge.classList.add("ready");
    if (el.modelDetail) el.modelDetail.innerHTML = `
      <strong>Algorithm:</strong> ${s.algorithm}<br>
      <strong>Training rows:</strong> ${s.training_rows}<br>
      <strong>MAE:</strong> ${s.mae_seconds ?? "–"} s<br>
      <strong>Last trained:</strong> ${s.last_trained
        ? new Date(s.last_trained + "Z").toLocaleString("en-SG") : "–"}
    `;
  } catch { el.modelBadge.textContent = "AI model"; }
}

// ── Stop info ─────────────────────────────────────────────────────

async function loadStopInfo(code) {
  try {
    const info = await apiFetch(`/api/stops/${code}`);
    state.stopInfo = info;
    el.stopName.textContent = info.description || "";
    el.stopRoad.textContent = info.road_name   || "";
    return info;
  } catch { return null; }
}

// ── Main load ─────────────────────────────────────────────────────

async function loadStop(code) {
  code = code.trim();
  if (!code) return;
  if (state.refreshTimer)  clearInterval(state.refreshTimer);
  if (state.tickTimer)     clearInterval(state.tickTimer);
  state.currentStop = code;

  hideAutocomplete();
  clearError();
  showLoading();

  try {
    const [arrivals, stats, info] = await Promise.all([
      apiFetch(`/api/arrivals/${code}`),
      apiFetch(`/api/stats/${code}`).catch(() => null),
      loadStopInfo(code),
    ]);

    renderArrivals(arrivals);
    renderCharts(stats);
    syncFavBtn();
    updateFavBadge();

    // Auto-refresh
    state.refreshTimer = setInterval(() => refreshArrivals(code), REFRESH_INTERVAL);

    // Switch to search tab if on favourites
    activateTab("search");

    // Update URL hash for shareability
    window.location.hash = code;

  } catch (err) {
    show(el.stopHeader);
    el.stopCodeDisplay.textContent = code;
    showError(`Could not load arrivals: ${err.message}`);
  } finally {
    hideLoading();
  }
}

async function refreshArrivals(code) {
  try {
    const arrivals = await apiFetch(`/api/arrivals/${code}`);
    renderArrivals(arrivals);
    clearError();
  } catch (err) {
    showError(`Refresh failed: ${err.message}`);
  }
}

// ── Event listeners ───────────────────────────────────────────────

// Tab switching
document.querySelectorAll(".tab-btn").forEach(btn => {
  btn.addEventListener("click", () => activateTab(btn.dataset.tab));
});

// Search form
document.getElementById("search-form") && document.getElementById("search-form")
  .addEventListener("submit", e => { e.preventDefault(); loadStop(el.stopInput.value); });
el.searchBtn.addEventListener("click", () => loadStop(el.stopInput.value));

// Autocomplete typing
el.stopInput.addEventListener("input", () => {
  const val = el.stopInput.value.trim();
  val.length > 0 ? show(el.searchClear) : hide(el.searchClear);
  clearTimeout(state.acTimer);
  state.acTimer = setTimeout(() => doAutocomplete(val), AUTOCOMPLETE_DELAY);
});

el.stopInput.addEventListener("keydown", e => {
  if (e.key === "Enter") { loadStop(el.stopInput.value); hideAutocomplete(); }
  if (e.key === "Escape") { hideAutocomplete(); }
});

// Search clear
el.searchClear.addEventListener("click", () => {
  el.stopInput.value = "";
  hide(el.searchClear);
  hideAutocomplete();
  el.stopInput.focus();
});

// Click outside autocomplete
document.addEventListener("click", e => {
  if (!el.autocomplete.contains(e.target) && e.target !== el.stopInput) hideAutocomplete();
});

// Autocomplete item click (event delegation)
el.autocomplete.addEventListener("click", e => {
  const item = e.target.closest(".autocomplete-item");
  if (!item) return;
  const code = item.dataset.code;
  el.stopInput.value = code;
  loadStop(code);
});

// Refresh
el.refreshBtn.addEventListener("click", () => {
  if (state.currentStop) loadStop(state.currentStop);
});

// Favourite toggle
el.favBtn.addEventListener("click", () => {
  if (!state.currentStop) return;
  if (isFavourite(state.currentStop)) {
    removeFavourite(state.currentStop);
  } else {
    addFavourite(state.currentStop, state.stopInfo || {});
  }
  syncFavBtn();
  updateFavBadge();
});

// Quick chips
document.querySelectorAll(".chip").forEach(btn => {
  btn.addEventListener("click", () => {
    el.stopInput.value = btn.dataset.stop;
    loadStop(btn.dataset.stop);
  });
});

// Favourite grid (event delegation — load or remove)
el.favGrid.addEventListener("click", e => {
  const removeBtn = e.target.closest(".fav-card-remove");
  if (removeBtn) {
    e.stopPropagation();
    removeFavourite(removeBtn.dataset.code);
    renderFavGrid();
    if (state.currentStop === removeBtn.dataset.code) syncFavBtn();
    updateFavBadge();
    return;
  }
  const card = e.target.closest(".fav-card");
  if (card) {
    el.stopInput.value = card.dataset.code;
    loadStop(card.dataset.code);
  }
});

// Cleanup on page hide
window.addEventListener("pagehide", () => {
  clearInterval(state.refreshTimer);
  clearInterval(state.tickTimer);
});

// ── Init ──────────────────────────────────────────────────────────
(async () => {
  updateFavBadge();
  loadModelStatus();

  // Load from URL hash e.g. /#83139
  const hash = location.hash.replace("#", "").trim();
  if (hash && /^\d+$/.test(hash)) {
    el.stopInput.value = hash;
    loadStop(hash);
  }
})();
