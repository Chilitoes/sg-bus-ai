"use strict";

/* SG Bus — app logic
   Views: arrivals / saved / data. Favourites live in localStorage and sync
   to the account (bearer token) when logged in. */

// ── Config ────────────────────────────────────────────────
const API_BASE   = "";
const REFRESH_MS = 30_000;
const DUE_SECS   = 45;
const FAV_KEY    = "sgbus_favs";
const RECENT_KEY = "sgbus_recent";
const THEME_KEY  = "sgbus_theme";
const TOKEN_KEY  = "sgbus_token";
const USER_KEY   = "sgbus_user";

const POPULAR = [
  { code: "83139", description: "Bedok Int" },
  { code: "01012", description: "Hotel Grand Pacific" },
  { code: "03222", description: "Raffles Place" },
  { code: "09022", description: "Orchard Stn" },
];

const LOAD_LABEL = { SEA: "Seats", SDA: "Standing", LSD: "Crowded" };

// ── State ─────────────────────────────────────────────────
const S = {
  view: "arrivals",
  stop: null,
  stopInfo: null,
  stats: null,
  favs: readJSON(FAV_KEY, []),
  recent: readJSON(RECENT_KEY, []),
  token: localStorage.getItem(TOKEN_KEY) || null,
  username: localStorage.getItem(USER_KEY) || null,
  authMode: "login",
  refreshTmr: null,
  tickTmr: null,
  acTmr: null,
  chartsDirty: false,
};
const charts = { service: null, hour: null, trend: null };

// ── Tiny helpers ──────────────────────────────────────────
const $ = (id) => document.getElementById(id);
function readJSON(key, fallback) {
  try { return JSON.parse(localStorage.getItem(key)) ?? fallback; }
  catch { return fallback; }
}
function writeJSON(key, val) { localStorage.setItem(key, JSON.stringify(val)); }
function show(el) { el && el.classList.remove("hidden"); }
function hide(el) { el && el.classList.add("hidden"); }
function esc(s) {
  return String(s ?? "").replace(/[&<>"']/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

let toastTmr = null;
function toast(msg) {
  const t = $("toast");
  t.textContent = msg;
  show(t);
  clearTimeout(toastTmr);
  toastTmr = setTimeout(() => hide(t), 2200);
}

function parseUTC(iso) {
  if (!iso) return null;
  return new Date(iso.endsWith("Z") ? iso : iso + "Z");
}
function secsUntil(dt) { return dt ? (dt - Date.now()) / 1000 : null; }
function fmtMin(s) {
  if (s === null) return "–";
  if (s < DUE_SECS) return "Due";
  return String(Math.max(1, Math.floor(s / 60)));
}
function fmtClock(dt) {
  if (!dt) return "–";
  return dt.toLocaleTimeString("en-SG", { hour: "2-digit", minute: "2-digit", hour12: false });
}

// ── API ───────────────────────────────────────────────────
async function api(path, opts = {}) {
  opts.headers = { ...(opts.headers || {}) };
  if (opts.body && !(opts.body instanceof FormData)) {
    opts.headers["Content-Type"] = "application/json";
  }
  if (S.token) opts.headers["Authorization"] = `Bearer ${S.token}`;
  const r = await fetch(API_BASE + path, opts);
  if (!r.ok) {
    if (r.status === 401 && S.token && path.startsWith("/api/auth/me")) clearAuth();
    const b = await r.json().catch(() => ({}));
    throw new Error(b.detail || `HTTP ${r.status}`);
  }
  return r.json();
}

// ── Theme ─────────────────────────────────────────────────
function applyTheme(t) {
  document.documentElement.setAttribute("data-theme", t);
  localStorage.setItem(THEME_KEY, t);
}
function initTheme() {
  const saved = localStorage.getItem(THEME_KEY);
  const system = matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
  applyTheme(saved || system);
}
$("theme-btn").addEventListener("click", () => {
  const cur = document.documentElement.getAttribute("data-theme");
  applyTheme(cur === "dark" ? "light" : "dark");
  if (S.stats) renderCharts(S.stats);
});

// ── Auth ──────────────────────────────────────────────────
function setAuth(token, username) {
  S.token = token; S.username = username;
  localStorage.setItem(TOKEN_KEY, token);
  localStorage.setItem(USER_KEY, username);
  syncAccountUI();
}
function clearAuth() {
  S.token = null; S.username = null;
  localStorage.removeItem(TOKEN_KEY);
  localStorage.removeItem(USER_KEY);
  syncAccountUI();
}
function syncAccountUI() {
  const loggedIn = !!S.token;
  $("account-dot").classList.toggle("hidden", !loggedIn);
  $("auth-forms").classList.toggle("hidden", loggedIn);
  $("auth-profile").classList.toggle("hidden", !loggedIn);
  if (loggedIn) {
    $("profile-name").textContent = S.username;
    $("profile-avatar").textContent = (S.username || "?")[0];
  }
  $("saved-sync-note").textContent = loggedIn
    ? `Synced to ${S.username}'s account · monitored 24/7 for sharper predictions`
    : "Saved on this device only. Log in to sync across devices — saved stops are monitored 24/7, which makes their predictions more accurate.";
}

function openSheet() {
  show($("sheet-backdrop")); show($("account-sheet"));
  hide($("auth-error"));
  if (S.token)

    api("/api/auth/me")
      .then((me) => {
        const since = new Date(me.created_at + "Z").toLocaleDateString("en-SG",
          { day: "numeric", month: "short", year: "numeric" });
        $("profile-meta").textContent = `${me.favourite_count} saved stops · joined ${since}`;
      })
      .catch(() => {});
}
function closeSheet() { hide($("sheet-backdrop")); hide($("account-sheet")); }

$("account-btn").addEventListener("click", openSheet);
$("sheet-backdrop").addEventListener("click", closeSheet);

function setAuthMode(mode) {
  S.authMode = mode;
  $("seg-login").classList.toggle("active", mode === "login");
  $("seg-register").classList.toggle("active", mode === "register");
  $("auth-submit").textContent = mode === "login" ? "Log in" : "Create account";
  $("auth-password").setAttribute("autocomplete",
    mode === "login" ? "current-password" : "new-password");
  hide($("auth-error"));
}
$("seg-login").addEventListener("click", () => setAuthMode("login"));
$("seg-register").addEventListener("click", () => setAuthMode("register"));

$("auth-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  const username = $("auth-username").value.trim();
  const password = $("auth-password").value;
  if (!username || !password) return;
  $("auth-submit").disabled = true;
  try {
    const res = await api(`/api/auth/${S.authMode}`, {
      method: "POST",
      body: JSON.stringify({ username, password }),
    });
    setAuth(res.token, res.username);
    // Merge any local favourites into the account, adopt the merged list
    try {
      const merged = await api("/api/favourites/sync", {
        method: "POST",
        body: JSON.stringify({ favourites: S.favs }),
      });
      S.favs = merged.favourites;
      writeJSON(FAV_KEY, S.favs);
    } catch { /* favourites stay local */ }
    afterFavsChanged();
    closeSheet();
    toast(S.authMode === "login" ? `Welcome back, ${res.username}` : "Account created");
    $("auth-password").value = "";
  } catch (err) {
    const el = $("auth-error");
    el.textContent = err.message.startsWith("HTTP") || err.message.includes("fetch")
      ? "Account service unavailable right now." : err.message;
    show(el);
  } finally {
    $("auth-submit").disabled = false;
  }
});

$("logout-btn").addEventListener("click", async () => {
  try { await api("/api/auth/logout", { method: "POST" }); } catch {}
  clearAuth();
  closeSheet();
  toast("Logged out");
});

async function hydrateServerFavs() {
  if (!S.token) return;
  try {
    const res = await api("/api/favourites");
    S.favs = res.favourites;
    writeJSON(FAV_KEY, S.favs);
    afterFavsChanged();
  } catch { /* keep local cache */ }
}

// ── Favourites ────────────────────────────────────────────
function isFav(code) { return S.favs.some((f) => f.code === code); }

function addFav(code, info = {}) {
  if (isFav(code)) return;
  S.favs.unshift({
    code,
    description: info.description || null,
    road_name: info.road_name || null,
  });
  writeJSON(FAV_KEY, S.favs);
  if (S.token) {
    api(`/api/favourites/${code}`, {
      method: "POST",
      body: JSON.stringify({ description: info.description, road_name: info.road_name }),
    }).catch(() => toast("Saved on this device (sync failed)"));
  } else {
    api(`/api/monitor/${code}`, { method: "POST" }).catch(() => {});
  }
  afterFavsChanged();
}

function removeFav(code) {
  S.favs = S.favs.filter((f) => f.code !== code);
  writeJSON(FAV_KEY, S.favs);
  if (S.token) api(`/api/favourites/${code}`, { method: "DELETE" }).catch(() => {});
  afterFavsChanged();
}

function afterFavsChanged() {
  const n = S.favs.length;
  const badge = $("nav-saved-count");
  badge.textContent = n;
  badge.classList.toggle("hidden", n === 0);
  renderChips();
  syncSaveBtn();
  if (S.view === "saved") renderSaved();
}

function syncSaveBtn() {
  if (!S.stop) return;
  const saved = isFav(S.stop);
  $("save-btn").classList.toggle("saved", saved);
  $("save-label").textContent = saved ? "Saved" : "Save";
}

$("save-btn").addEventListener("click", () => {
  if (!S.stop) return;
  if (isFav(S.stop)) { removeFav(S.stop); toast("Removed from saved stops"); }
  else { addFav(S.stop, S.stopInfo || {}); toast("Saved — now monitored for better predictions"); }
  syncSaveBtn();
});

// ── Recents ───────────────────────────────────────────────
function pushRecent(code, info) {
  S.recent = [{ code, description: info?.description || null },
    ...S.recent.filter((r) => r.code !== code)].slice(0, 5);
  writeJSON(RECENT_KEY, S.recent);
}

// ── Chips (saved > recent > popular) ──────────────────────
function renderChips() {
  const area = $("chips-area");
  const groups = [];
  if (S.favs.length) groups.push(["Saved", S.favs.slice(0, 8)]);
  if (S.recent.length) groups.push(["Recent", S.recent.filter((r) => !isFav(r.code)).slice(0, 4)]);
  if (!S.favs.length && !S.recent.length) groups.push(["Popular", POPULAR]);
  area.innerHTML = groups
    .filter(([, items]) => items.length)
    .map(([label, items]) => `
      <div class="chips-label">${label}</div>
      <div class="chips-row">${items.map((f) => `
        <button class="chip" data-code="${esc(f.code)}">
          <span class="chip-code">${esc(f.code)}</span>
          ${f.description ? `<span class="chip-name">${esc(f.description)}</span>` : ""}
        </button>`).join("")}
      </div>`).join("");
}
$("chips-area").addEventListener("click", (e) => {
  const chip = e.target.closest(".chip");
  if (chip) loadStop(chip.dataset.code);
});

// ── Views / bottom nav ────────────────────────────────────
function switchView(name) {
  S.view = name;
  document.querySelectorAll(".nav-item").forEach((b) =>
    b.classList.toggle("active", b.dataset.view === name));
  document.querySelectorAll(".view").forEach((v) =>
    v.classList.toggle("active", v.id === `view-${name}`));
  if (name === "saved") renderSaved();
  if (name === "data") loadData();
}
document.querySelectorAll(".nav-item").forEach((b) =>
  b.addEventListener("click", () => switchView(b.dataset.view)));

// ── Search + autocomplete ─────────────────────────────────
const input = $("stop-input");

function hideAc() { hide($("autocomplete")); $("autocomplete").innerHTML = ""; }

async function runAc(q) {
  if (!q || q.length < 2) { hideAc(); return; }
  try {
    const d = await api(`/api/stops/search?q=${encodeURIComponent(q)}&limit=8`);
    const box = $("autocomplete");
    if (!d.results.length) {
      box.innerHTML = `<div class="ac-empty">No stops match “${esc(q)}”.</div>`;
    } else {
      box.innerHTML = d.results.map((s) => `
        <div class="ac-item" data-code="${esc(s.bus_stop_code)}">
          <span class="ac-code">${esc(s.bus_stop_code)}</span>
          <div>
            <div class="ac-name">${esc(s.description || "Bus stop")}</div>
            <div class="ac-road">${esc(s.road_name || "")}</div>
          </div>
        </div>`).join("");
    }
    show(box);
  } catch { hideAc(); }
}

input.addEventListener("input", () => {
  const v = input.value.trim();
  v ? show($("search-clear")) : hide($("search-clear"));
  clearTimeout(S.acTmr);
  S.acTmr = setTimeout(() => runAc(v), 220);
});
input.addEventListener("keydown", (e) => {
  if (e.key === "Enter") {
    const v = input.value.trim();
    if (/^\d{5}$/.test(v)) { loadStop(v); input.blur(); }
    hideAc();
  }
  if (e.key === "Escape") hideAc();
});
$("search-clear").addEventListener("click", () => {
  input.value = ""; hide($("search-clear")); hideAc(); input.focus();
});
$("autocomplete").addEventListener("click", (e) => {
  const item = e.target.closest(".ac-item");
  if (item) { input.value = ""; hide($("search-clear")); hideAc(); loadStop(item.dataset.code); input.blur(); }
});
document.addEventListener("click", (e) => {
  if (!$("autocomplete").contains(e.target) && e.target !== input) hideAc();
});

// ── Arrivals ──────────────────────────────────────────────
function skeletons(n = 4) {
  $("rows").innerHTML = Array.from({ length: n }, () => `<div class="skel"></div>`).join("");
}

function adjChip(adj) {
  if (Math.abs(adj) < 10) return `<span class="adj ontime">on time</span>`;
  const cls = adj > 0 ? "late" : "early";
  const sign = adj > 0 ? "+" : "−";
  return `<span class="adj ${cls}">${sign}${Math.abs(Math.round(adj))}s</span>`;
}

function busLine(bus) {
  const ai = parseUTC(bus.ai_arrival);
  const lta = parseUTC(bus.api_arrival);
  const load = bus.load
    ? `<span class="load-pill ${esc(bus.load)}">${LOAD_LABEL[bus.load] || esc(bus.load)}</span>` : "";
  return `
    <div class="bus-line">
      <span class="slot">${bus.slot === 1 ? "next" : bus.slot === 2 ? "2nd" : "3rd"}</span>
      <span class="bus-times">
        <span class="bus-time-ai" data-iso="${esc(bus.ai_arrival)}">${fmtClock(ai)}</span>
        ${adjChip(bus.ai_adjustment_sec || 0)}
        <span class="bus-time-lta">LTA ${fmtClock(lta)}</span>
      </span>
      ${load}
    </div>`;
}

function svcCard(svc) {
  const next = svc.buses[0] || {};
  const next2 = svc.buses[1];
  const secs = secsUntil(parseUTC(next.ai_arrival));
  const due = secs !== null && secs < DUE_SECS;
  const tags = [
    next.type && next.type !== "SD" ? `<span class="tag">${esc(next.type)}</span>` : "",
    next.feature === "WAB" ? `<span class="tag">♿</span>` : "",
    next.load ? `<span class="load-dot ${esc(next.load)}" title="${LOAD_LABEL[next.load] || ""}"></span>` : "",
  ].join("");
  return `
    <div class="svc" data-svc="${esc(svc.service_no)}">
      <button class="svc-head">
        <span class="route-badge">${esc(svc.service_no)}</span>
        <span class="svc-mid">
          <span class="svc-op">${esc(svc.operator || "")}</span>
          <span class="svc-tags">${tags}</span>
        </span>
        <span class="svc-eta">
          <span class="eta-now ${due ? "due" : ""}" data-eta-iso="${esc(next.ai_arrival || "")}">${fmtMin(secs)}${due ? "" : `<span class="eta-unit">min</span>`}</span>
          ${next2 ? `<span class="eta-next" data-next-iso="${esc(next2.ai_arrival)}">then ${fmtMin(secsUntil(parseUTC(next2.ai_arrival)))} min</span>` : `<span class="eta-next">last bus</span>`}
        </span>
        <svg class="chev" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="6 9 12 15 18 9"/></svg>
      </button>
      <div class="svc-detail"><div class="svc-detail-inner">
        ${svc.buses.map(busLine).join("")}
      </div></div>
    </div>`;
}

function renderArrivals(data) {
  hide($("arrivals-error"));
  const open = new Set([...document.querySelectorAll(".svc.open")].map((c) => c.dataset.svc));
  if (!data.services?.length) {
    $("rows").innerHTML = "";
    show($("no-services"));
    return;
  }
  hide($("no-services"));
  $("rows").innerHTML = data.services.map(svcCard).join("");
  document.querySelectorAll(".svc").forEach((c) => {
    if (open.has(c.dataset.svc)) c.classList.add("open");
  });
  $("updated-at").textContent = `Updated ${new Date().toLocaleTimeString("en-SG",
    { hour: "2-digit", minute: "2-digit", hour12: false })}`;
  startTicker();
}

$("rows").addEventListener("click", (e) => {
  const head = e.target.closest(".svc-head");
  if (head) head.closest(".svc").classList.toggle("open");
});

function startTicker() {
  clearInterval(S.tickTmr);
  S.tickTmr = setInterval(() => {
    document.querySelectorAll("[data-eta-iso]").forEach((node) => {
      const s = secsUntil(parseUTC(node.dataset.etaIso));
      const due = s !== null && s < DUE_SECS;
      node.classList.toggle("due", due);
      node.innerHTML = `${fmtMin(s)}${due ? "" : `<span class="eta-unit">min</span>`}`;
    });
    document.querySelectorAll("[data-next-iso]").forEach((node) => {
      node.textContent = `then ${fmtMin(secsUntil(parseUTC(node.dataset.nextIso)))} min`;
    });
  }, 1000);
}

async function loadStop(code) {
  code = String(code).trim();
  if (!code) return;
  switchView("arrivals");
  clearInterval(S.refreshTmr);
  clearInterval(S.tickTmr);
  S.stop = code;
  hideAc();
  hide($("arrivals-error"));
  hide($("no-services"));
  show($("stop-card"));
  $("stop-name").textContent = "Loading…";
  $("stop-road").textContent = "";
  $("stop-code").textContent = code;
  $("updated-at").textContent = "";
  skeletons();
  try {
    const [arrivals, stats, info] = await Promise.all([
      api(`/api/arrivals/${code}`),
      api(`/api/stats/${code}`).catch(() => null),
      api(`/api/stops/${code}`).catch(() => null),
    ]);
    S.stopInfo = info;
    S.stats = stats;
    $("stop-name").textContent = info?.description || "Bus stop";
    $("stop-road").textContent = info?.road_name || "";
    renderArrivals(arrivals);
    show($("stats-details"));
    show($("about-details"));
    prepareStats(stats);
    syncSaveBtn();
    pushRecent(code, info);
    renderChips();
    location.hash = code;
    S.refreshTmr = setInterval(() => refreshStop(code), REFRESH_MS);
  } catch (err) {
    $("rows").innerHTML = "";
    $("stop-name").textContent = "Bus stop";
    const el = $("arrivals-error");
    el.textContent = `Couldn't load arrivals: ${err.message}`;
    show(el);
  }
}

async function refreshStop(code) {
  $("rows").classList.add("refreshing");
  try {
    const arrivals = await api(`/api/arrivals/${code}`);
    renderArrivals(arrivals);
  } catch (err) {
    const el = $("arrivals-error");
    el.textContent = `Refresh failed: ${err.message}`;
    show(el);
  } finally {
    $("rows").classList.remove("refreshing");
  }
}

$("refresh-btn").addEventListener("click", () => { if (S.stop) refreshStop(S.stop); });

// ── Charts ────────────────────────────────────────────────
function prepareStats(stats) {
  S.chartsDirty = true;
  if ($("stats-details").open) renderCharts(stats);
}
$("stats-details").addEventListener("toggle", () => {
  if ($("stats-details").open && S.chartsDirty && S.stats) renderCharts(S.stats);
});

function destroyCharts() {
  Object.keys(charts).forEach((k) => { charts[k]?.destroy(); charts[k] = null; });
}

function renderCharts(stats) {
  if (typeof Chart === "undefined") return;
  S.chartsDirty = false;
  destroyCharts();
  if (!stats || stats.total_records === 0) {
    show($("no-stats")); hide($("charts-wrap"));
    return;
  }
  hide($("no-stats")); show($("charts-wrap"));

  const css = getComputedStyle(document.documentElement);
  const ink2 = css.getPropertyValue("--ink-2").trim();
  const ink3 = css.getPropertyValue("--ink-3").trim();
  const line = css.getPropertyValue("--line").trim();
  const accent = css.getPropertyValue("--accent").trim();
  const good = css.getPropertyValue("--good").trim();
  const warn = css.getPropertyValue("--warn").trim();

  const fmtDelay = (v) => {
    if (v === null || v === undefined) return "no data";
    const a = Math.abs(v);
    if (a < 5) return "on time";
    const m = Math.floor(a / 60), s = Math.round(a % 60);
    const t = m ? `${m}m ${s}s` : `${s}s`;
    return v > 0 ? `${t} late` : `${t} early`;
  };
  const yScale = {
    grid: { color: line }, border: { display: false },
    ticks: { color: ink3, font: { size: 10 },
      callback: (v) => (Math.round(v) === 0 ? "0" : `${v > 0 ? "+" : ""}${Math.round(v)}s`) },
  };
  const xScale = { grid: { display: false }, border: { display: false },
    ticks: { color: ink3, font: { size: 10 } } };
  const base = {
    responsive: true, maintainAspectRatio: false,
    animation: { duration: 400 },
    plugins: { legend: { display: false },
      tooltip: { displayColors: false, callbacks: { label: (i) => ` ${fmtDelay(i.raw)}` } } },
    scales: { y: yScale, x: xScale },
  };

  if (stats.by_service?.length) {
    const sorted = [...stats.by_service].sort((a, b) => b.avg_delay_sec - a.avg_delay_sec);
    charts.service = new Chart($("chart-service"), {
      type: "bar",
      data: { labels: sorted.map((s) => s.service),
        datasets: [{ data: sorted.map((s) => s.avg_delay_sec),
          backgroundColor: sorted.map((s) => (s.avg_delay_sec >= 0 ? accent : good)),
          borderRadius: 4 }] },
      options: base,
    });
  }

  if (stats.by_hour) {
    const isPeak = (h) => (h >= 7 && h < 9) || (h >= 17 && h < 19);
    const noBus = (h) => h >= 1 && h <= 4;
    const hl = (h) => (h === 0 ? "12a" : h === 12 ? "12p" : h < 12 ? `${h}a` : `${h - 12}p`);
    charts.hour = new Chart($("chart-hour"), {
      type: "bar",
      data: { labels: Array.from({ length: 24 }, (_, i) => hl(i)),
        datasets: [{ data: stats.by_hour.map((v, i) => (noBus(i) ? null : v)),
          backgroundColor: Array.from({ length: 24 }, (_, i) => (isPeak(i) ? warn : ink2)),
          borderRadius: 3 }] },
      options: { ...base,
        scales: { y: yScale, x: { ...xScale, ticks: { ...xScale.ticks, maxTicksLimit: 8 } } } },
    });
  }

  if (stats.trend?.length) {
    const vals = stats.trend.map((t) => t.avg_delay_sec).filter((v) => v !== null);
    if (vals.length >= 2) {
      const half = Math.ceil(vals.length / 2);
      const a = vals.slice(0, half).reduce((x, y) => x + y, 0) / half;
      const b = vals.slice(-half).reduce((x, y) => x + y, 0) / half;
      $("trend-dir").textContent = b < a - 2 ? "(improving)" : b > a + 2 ? "(worsening)" : "(stable)";
    }
    charts.trend = new Chart($("chart-trend"), {
      type: "line",
      data: { labels: stats.trend.map((t) =>
          new Date(t.date + "T00:00:00").toLocaleDateString("en-SG", { day: "numeric", month: "short" })),
        datasets: [{ data: stats.trend.map((t) => t.avg_delay_sec),
          borderColor: accent, backgroundColor: "transparent",
          tension: .35, borderWidth: 2, pointRadius: 3, pointBackgroundColor: accent }] },
      options: base,
    });
  }
}

// ── Model info ────────────────────────────────────────────
async function loadModelInfo() {
  try {
    const s = await api("/api/model/status");
    $("model-info").innerHTML =
      `Model: ${esc(s.algorithm || "gradient boosting")}<br>` +
      `Trained on ${Number(s.training_rows || 0).toLocaleString()} samples · ` +
      `typical error ±${esc(s.mae_seconds ?? "–")}s<br>` +
      `Last trained: ${s.last_trained
        ? new Date(s.last_trained + "Z").toLocaleString("en-SG") : "–"}`;
  } catch { /* panel just stays generic */ }
}

// ── Saved view ────────────────────────────────────────────
function renderSaved() {
  const list = $("saved-list");
  syncAccountUI();
  if (!S.favs.length) { show($("saved-empty")); list.innerHTML = ""; return; }
  hide($("saved-empty"));
  list.innerHTML = S.favs.map((f) => `
    <div class="saved-card" data-code="${esc(f.code)}">
      <div class="saved-card-top">
        <div>
          <div class="saved-name">${esc(f.description || "Bus stop")} <span class="stop-code">${esc(f.code)}</span></div>
          <div class="saved-road">${esc(f.road_name || "")}</div>
        </div>
        <button class="saved-remove" data-remove="${esc(f.code)}" aria-label="Remove">
          <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M18 6 6 18M6 6l12 12"/></svg>
        </button>
      </div>
      <div class="saved-previews" data-preview="${esc(f.code)}">
        <span class="preview-loading">loading arrivals…</span>
      </div>
    </div>`).join("");
  loadSavedPreviews();
}

async function loadSavedPreviews() {
  const targets = S.favs.slice(0, 8);
  await Promise.allSettled(targets.map(async (f) => {
    const box = document.querySelector(`[data-preview="${CSS.escape(f.code)}"]`);
    if (!box) return;
    try {
      const d = await api(`/api/arrivals/${f.code}`);
      const top = (d.services || []).slice(0, 4);
      box.innerHTML = top.length
        ? top.map((svc) => {
            const s = secsUntil(parseUTC(svc.buses[0]?.ai_arrival));
            const due = s !== null && s < DUE_SECS;
            return `<span class="preview-pill"><b>${esc(svc.service_no)}</b>
              <span class="pv-min ${due ? "due" : ""}">${fmtMin(s)}${due ? "" : "m"}</span></span>`;
          }).join("")
        : `<span class="preview-loading">no buses right now</span>`;
    } catch {
      box.innerHTML = `<span class="preview-loading">unavailable</span>`;
    }
  }));
}

$("saved-list").addEventListener("click", (e) => {
  const rm = e.target.closest("[data-remove]");
  if (rm) {
    removeFav(rm.dataset.remove);
    if (S.stop === rm.dataset.remove) syncSaveBtn();
    toast("Removed");
    return;
  }
  const card = e.target.closest(".saved-card");
  if (card) loadStop(card.dataset.code);
});

// ── Data view ─────────────────────────────────────────────
async function loadData() {
  hide($("data-error"));
  $("data-grid").innerHTML = Array.from({ length: 6 }, () => `<div class="skel" style="height:70px"></div>`).join("");
  try {
    const d = await api("/api/data");
    const cards = [
      ["Database", d.database.type, ""],
      ["Snapshots", Number(d.database.arrival_records).toLocaleString(), "arrival records"],
      ["Labeled", Number(d.database.labeled_records).toLocaleString(), "with measured delay"],
      ["Stops known", Number(d.database.bus_stops).toLocaleString(), "in directory"],
      ["Model error", `±${d.model.mae_seconds ?? "–"}s`, "mean absolute error"],
      ["Training set", Number(d.model.training_rows).toLocaleString(), "samples"],
    ];
    $("data-grid").innerHTML = cards.map(([l, v, s]) => `
      <div class="stat-card">
        <div class="stat-label">${l}</div>
        <div class="stat-value">${v}</div>
        ${s ? `<div class="stat-sub">${s}</div>` : ""}
      </div>`).join("");

    const mon = d.monitored_stops || [];
    $("mon-count").textContent = mon.length;
    $("mon-chips").innerHTML = mon.map((c) => `<span class="mon-chip">${esc(c)}</span>`).join("");
    $("monitored-block").classList.toggle("hidden", !mon.length);

    const fmtWhen = (iso) => (iso ? iso.slice(5, 16).replace("T", " ") : "–");
    const delayCell = (v) => v === null || v === undefined ? `<td class="num">–</td>`
      : `<td class="num ${v > 0 ? "delay-pos" : "delay-neg"}">${v > 0 ? "+" : ""}${Math.round(v)}s</td>`;

    const trk = d.recent_tracking || [];
    $("tracking-tbody").innerHTML = trk.map((t) => `
      <tr><td>${esc(t.bus_stop_code)}</td><td>${esc(t.bus_service)}</td>
      <td>${fmtWhen(t.first_seen)}</td>${delayCell(t.delay_seconds)}</tr>`).join("");
    $("tracking-block").classList.toggle("hidden", !trk.length);

    const rec = d.recent_records || [];
    $("records-tbody").innerHTML = rec.map((r) => `
      <tr><td>${esc(r.bus_stop_code)}</td><td>${esc(r.bus_service)}</td>
      <td>${fmtWhen(r.collection_time)}</td>${delayCell(r.delay_seconds)}
      <td>${r.bus_load ? (LOAD_LABEL[r.bus_load] || esc(r.bus_load)) : "–"}</td></tr>`).join("");
    $("records-block").classList.toggle("hidden", !rec.length);
  } catch (err) {
    $("data-grid").innerHTML = "";
    const el = $("data-error");
    el.textContent = `Couldn't load data: ${err.message}`;
    show(el);
  }
}

// ── Cleanup + init ────────────────────────────────────────
window.addEventListener("pagehide", () => {
  clearInterval(S.refreshTmr);
  clearInterval(S.tickTmr);
});

initTheme();
syncAccountUI();
afterFavsChanged();
renderChips();
loadModelInfo();
hydrateServerFavs();

const bootStop = location.hash.replace("#", "").trim();
if (/^\d{5}$/.test(bootStop)) loadStop(bootStop);
