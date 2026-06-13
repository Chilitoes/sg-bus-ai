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
  favs: [],
  savedJourneys: [],
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

// Favourites require a logged-in account; scoped per username for caching.
function favKey() { return `${FAV_KEY}_u_${S.username}`; }
S.favs = S.username ? readJSON(favKey(), []) : [];

// ── Tiny helpers ──────────────────────────────────────────
const $ = (id) => document.getElementById(id);
function readJSON(key, fallback) {
  try { return JSON.parse(localStorage.getItem(key)) ?? fallback; }
  catch { return fallback; }
}
function writeJSON(key, val) { try { localStorage.setItem(key, JSON.stringify(val)); } catch {} }
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
  if (s < DUE_SECS) return "Arr";
  return String(Math.max(1, Math.floor(s / 60)));
}
function fmtClock(dt) {
  if (!dt) return "–";
  return dt.toLocaleTimeString("en-SG", {
    hour: "2-digit", minute: "2-digit", hour12: false, timeZone: "Asia/Singapore",
  });
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
    // Any 401 while holding a token means the session is dead — except a
    // failed login/register attempt, which is just wrong credentials.
    const isLoginAttempt = path.startsWith("/api/auth/login") || path.startsWith("/api/auth/register")
      || path.startsWith("/api/auth/change-password");
    if (r.status === 401 && S.token && !isLoginAttempt) clearAuth();
    const b = await r.json().catch(() => ({}));
    throw new Error(b.detail || `HTTP ${r.status}`);
  }
  return r.json();
}

// ── Theme ─────────────────────────────────────────────────
function applyTheme(t) {
  document.documentElement.setAttribute("data-theme", t);
  try { localStorage.setItem(THEME_KEY, t); } catch {}
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
  S.favs = [];
  S.savedJourneys = [];
  syncAccountUI();
  afterFavsChanged();
  afterJourneysChanged();
}
function isAdmin() { return S.token && S.username === "admin"; }

function syncAccountUI() {
  const loggedIn = !!S.token;
  const admin = isAdmin();
  $("account-dot").classList.toggle("hidden", !loggedIn);
  $("auth-forms").classList.toggle("hidden", loggedIn);
  $("auth-profile").classList.toggle("hidden", !loggedIn);
  if (loggedIn) {
    $("profile-name").textContent = S.username;
    $("profile-avatar").textContent = (S.username || "?")[0];
  }
  $("saved-sync-note").textContent = loggedIn
    ? `Synced to ${S.username}'s account · monitored 24/7 for sharper predictions`
    : "";
  // Data tab only visible to admin
  $("nav-data-btn")?.classList.toggle("hidden", !admin);
  // If currently on data view and no longer admin, go to arrivals
  if (S.view === "data" && !admin) switchView("arrivals");
}

function openSheet() {
  show($("sheet-backdrop")); show($("account-sheet"));
  hide($("auth-error"));
  if (S.token)
    api("/api/auth/me")
      .then((me) => {
        const since = new Date(me.created_at + "Z").toLocaleDateString("en-SG",
          { day: "numeric", month: "short", year: "numeric" });
        $("profile-meta").textContent =
          `${me.favourite_count} stops · ${me.journey_count} routes · joined ${since}`;
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
    const deviceFavs = S.favs;
    const res = await api(`/api/auth/${S.authMode}`, {
      method: "POST",
      body: JSON.stringify({ username, password }),
    });
    setAuth(res.token, res.username);
    try {
      // On login, account list is source of truth (register: start fresh since login required to save).
      const [mine, journeys] = await Promise.all([
        api("/api/favourites"),
        api("/api/saved-journeys"),
      ]);
      S.favs = mine.favourites;
      S.savedJourneys = journeys.journeys;
      writeJSON(favKey(), S.favs);
    } catch { S.favs = readJSON(favKey(), []); }
    afterFavsChanged();
    afterJourneysChanged();
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
    const [favRes, journeyRes] = await Promise.all([
      api("/api/favourites"),
      api("/api/saved-journeys"),
    ]);
    S.favs = favRes.favourites;
    S.savedJourneys = journeyRes.journeys;
    writeJSON(favKey(), S.favs);
    afterFavsChanged();
    afterJourneysChanged();
  } catch { /* keep local cache; api() drops dead sessions automatically */ }
}

// ── Favourites ────────────────────────────────────────────
function isFav(code) { return S.favs.some((f) => f.code === code); }

function addFav(code, info = {}) {
  if (isFav(code)) return;
  S.favs.unshift({ code, description: info.description || null, road_name: info.road_name || null });
  writeJSON(favKey(), S.favs);
  api(`/api/favourites/${code}`, {
    method: "POST",
    body: JSON.stringify({ description: info.description, road_name: info.road_name }),
  }).catch(() => toast("Sync failed — stop saved locally"));
  afterFavsChanged();
}

function removeFav(code) {
  S.favs = S.favs.filter((f) => f.code !== code);
  writeJSON(favKey(), S.favs);
  if (S.token) api(`/api/favourites/${code}`, { method: "DELETE" }).catch(() => {});
  afterFavsChanged();
}

function afterFavsChanged() {
  const n = S.favs.length + S.savedJourneys.length;
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
  if (!S.token) { toast("Log in to save stops"); openSheet(); return; }
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
  if (name === "data" && !isAdmin()) name = "arrivals";
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
  if (!$("autocomplete").contains(e.target) && e.target !== input
      && !e.target.closest("#near-btn")) hideAc();
});

// ── Stops near me ─────────────────────────────────────────
$("near-btn").addEventListener("click", () => {
  if (!navigator.geolocation) { toast("Location not supported on this device"); return; }
  toast("Finding stops near you…");
  navigator.geolocation.getCurrentPosition(async (pos) => {
    try {
      const d = await api(`/api/stops/nearby?lat=${pos.coords.latitude}&lng=${pos.coords.longitude}&limit=8`);
      const box = $("autocomplete");
      box.innerHTML = d.results.length
        ? d.results.map((s) => `
          <div class="ac-item" data-code="${esc(s.bus_stop_code)}">
            <span class="ac-code">${esc(s.bus_stop_code)}</span>
            <div>
              <div class="ac-name">${esc(s.description || "Bus stop")}</div>
              <div class="ac-road">${esc(s.road_name || "")} · ${Math.round(s.distance_m)} m away</div>
            </div>
          </div>`).join("")
        : `<div class="ac-empty">No bus stops found nearby.</div>`;
      show(box);
    } catch { toast("Couldn't load nearby stops"); }
  }, () => toast("Location permission needed for nearby stops"),
  { enableHighAccuracy: true, timeout: 8000, maximumAge: 60_000 });
});

// ── Arrivals ──────────────────────────────────────────────
function skeletons(n = 4) {
  $("rows").innerHTML = Array.from({ length: n }, () => `<div class="skel"></div>`).join("");
}

function adjChip(adj) {
  if (Math.abs(adj) < 15) return `<span class="adj ontime">on time</span>`;
  const cls = adj > 0 ? "late" : "early";
  const sign = adj > 0 ? "+" : "−";
  const a = Math.abs(Math.round(adj));
  const txt = a >= 60 ? `${Math.round(a / 60)}m` : `${a}s`;
  return `<span class="adj ${cls}">${sign}${txt}</span>`;
}

// Small "AI 5 min (+1m)" line shown under the headline LTA countdown.
function aiText(aiSecs, adj) {
  if (aiSecs === null) return "";
  if (Math.abs(adj) < 15) return "AI agrees";
  const sign = adj > 0 ? "+" : "−";
  const a = Math.abs(Math.round(adj));
  const diff = a >= 60 ? `${Math.round(a / 60)}m` : `${a}s`;
  return `AI ${fmtMin(aiSecs)}${aiSecs < DUE_SECS ? "" : " min"} (${sign}${diff})`;
}

function busLine(bus) {
  const lta = parseUTC(bus.api_arrival);
  const ai = parseUTC(bus.ai_arrival);
  const load = bus.load
    ? `<span class="load-pill ${esc(bus.load)}">${LOAD_LABEL[bus.load] || esc(bus.load)}</span>` : "";
  return `
    <div class="bus-line">
      <span class="slot">${bus.slot === 1 ? "next" : bus.slot === 2 ? "2nd" : "3rd"}</span>
      <span class="bus-main">
        <span class="bus-lta"><b>${fmtClock(lta)}</b><span class="lta-tag">LTA</span> ${adjChip(bus.ai_adjustment_sec || 0)}</span>
        <span class="bus-ai">AI estimate ${fmtClock(ai)}</span>
      </span>
      ${load}
    </div>`;
}

function svcCard(svc) {
  const next = svc.buses[0] || {};
  const secs = secsUntil(parseUTC(next.api_arrival));
  const due = secs !== null && secs < DUE_SECS;
  const adj = next.ai_adjustment_sec || 0;
  const aiSecs = secsUntil(parseUTC(next.ai_arrival));
  const later = svc.buses.slice(1);
  const laterIsos = later.map((b) => b.api_arrival).join(",");
  const laterTxt = later.map((b) => fmtMin(secsUntil(parseUTC(b.api_arrival)))).join(" · ");
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
          <span class="eta-now ${due ? "due" : ""}" data-eta-iso="${esc(next.api_arrival || "")}">${fmtMin(secs)}${due ? "" : `<span class="eta-unit">min</span>`}</span>
          <span class="eta-ai" data-ai-iso="${esc(next.ai_arrival || "")}" data-adj="${Math.round(adj)}">${aiText(aiSecs, adj)}</span>
          ${laterTxt ? `<span class="eta-next" data-next-isos="${esc(laterIsos)}">then ${laterTxt} min</span>` : `<span class="eta-next">last bus</span>`}
        </span>
        <svg class="chev" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="6 9 12 15 18 9"/></svg>
      </button>
      <div class="svc-detail"><div class="svc-detail-inner">
        ${relLine(svc.reliability)}
        ${svc.buses.map(busLine).join("")}
      </div></div>
    </div>`;
}

function relLine(rel) {
  if (!rel) return "";
  const habit = delayHabit(rel.avg_delay_sec);
  return `<div class="svc-rel">
    <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/></svg>
    ${rel.on_time_pct}% on time · ${habit} <span class="svc-rel-n">(${rel.samples} observations)</span>
  </div>`;
}

// Render an average delay (seconds) as a human phrase, keeping second-level
// resolution so small but real deviations from the LTA timing stay visible.
function delayHabit(secs) {
  const d = Math.round(secs);
  const ad = Math.abs(d);
  if (ad < 5) return "usually right on the LTA timing";
  const dir = d > 0 ? "late" : "early";
  if (ad < 60) return `usually ${ad}s ${dir}`;
  const m = Math.floor(ad / 60), s = ad % 60;
  return `usually ${m} min ${s ? s + "s " : ""}${dir}`;
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
    { hour: "2-digit", minute: "2-digit", hour12: false, timeZone: "Asia/Singapore" })}`;
  startTicker();
  updateStopMap(data);
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
    document.querySelectorAll("[data-ai-iso]").forEach((node) => {
      if (!node.dataset.aiIso) return;
      node.textContent = aiText(
        secsUntil(parseUTC(node.dataset.aiIso)),
        Number(node.dataset.adj || 0));
    });
    document.querySelectorAll("[data-next-isos]").forEach((node) => {
      const txt = node.dataset.nextIsos.split(",").filter(Boolean)
        .map((iso) => fmtMin(secsUntil(parseUTC(iso)))).join(" · ");
      if (txt) node.textContent = `then ${txt} min`;
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
  syncAccountUI();

  if (!S.token) {
    show($("saved-auth-prompt"));
    hide($("saved-content"));
    return;
  }
  hide($("saved-auth-prompt"));
  show($("saved-content"));

  // Stops section
  if (!S.favs.length) {
    show($("saved-empty"));
    $("saved-list").innerHTML = "";
  } else {
    hide($("saved-empty"));
    $("saved-list").innerHTML = S.favs.map((f) => `
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

  // Journeys section
  if (!S.savedJourneys.length) {
    show($("saved-journeys-empty"));
    $("saved-journeys-list").innerHTML = "";
  } else {
    hide($("saved-journeys-empty"));
    $("saved-journeys-list").innerHTML = S.savedJourneys.map(renderSavedJourneyCard).join("");
  }
}

function renderSavedJourneyCard(j) {
  return `
    <div class="saved-journey-card">
      <div class="sj-info">
        <div class="sj-from">${esc(j.from_name)}</div>
        <svg class="sj-arrow" width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round"><path d="m5 12 14 0"/><path d="m13 6 6 6-6 6"/></svg>
        <div class="sj-to">${esc(j.to_name)}</div>
      </div>
      <div class="sj-actions">
        <button class="pillbtn sj-plan-btn"
                data-from-lat="${j.from_lat}" data-from-lng="${j.from_lng}"
                data-to-lat="${j.to_lat}" data-to-lng="${j.to_lng}"
                data-from-name="${esc(j.from_name)}" data-to-name="${esc(j.to_name)}">
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="6" cy="19" r="3"/><path d="M9 19h8.5a3.5 3.5 0 0 0 0-7h-11a3.5 3.5 0 0 1 0-7H15"/><circle cx="18" cy="5" r="3"/></svg>
          Plan
        </button>
        <button class="saved-remove" data-sj-remove="${j.id}" aria-label="Remove saved route">
          <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M18 6 6 18M6 6l12 12"/></svg>
        </button>
      </div>
    </div>`;
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
            const s = secsUntil(parseUTC(svc.buses[0]?.api_arrival));
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

$("saved-journeys-list").addEventListener("click", (e) => {
  const rm = e.target.closest("[data-sj-remove]");
  if (rm) { removeJourney(parseInt(rm.dataset.sjRemove)); toast("Route removed"); return; }
  const plan = e.target.closest(".sj-plan-btn");
  if (plan) {
    const { fromLat, fromLng, toLat, toLng, fromName, toName } = plan.dataset;
    setPlanLocation("from", null, fromName, parseFloat(fromLat), parseFloat(fromLng));
    setPlanLocation("to",   null, toName,   parseFloat(toLat),   parseFloat(toLng));
    switchView("plan");
    doJourneyPlan();
  }
});

$("saved-login-btn").addEventListener("click", openSheet);

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

    const fmtWhen = (iso) => iso ? fmtClock(parseUTC(iso)) : "–";
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

// ── Saved journeys ────────────────────────────────────────
function journeyKey(fLat, fLng, tLat, tLng) {
  return [fLat, fLng, tLat, tLng].map((v) => Math.round(v * 1e4)).join(",");
}
function isJourneySaved(fLat, fLng, tLat, tLng) {
  const k = journeyKey(fLat, fLng, tLat, tLng);
  return S.savedJourneys.some((j) => journeyKey(j.from_lat, j.from_lng, j.to_lat, j.to_lng) === k);
}
function getJourney(fLat, fLng, tLat, tLng) {
  const k = journeyKey(fLat, fLng, tLat, tLng);
  return S.savedJourneys.find((j) => journeyKey(j.from_lat, j.from_lng, j.to_lat, j.to_lng) === k);
}

async function saveJourney(fromName, fromLat, fromLng, toName, toLat, toLng) {
  const res = await api("/api/saved-journeys", {
    method: "POST",
    body: JSON.stringify({ from_name: fromName, from_lat: fromLat, from_lng: fromLng,
                           to_name: toName, to_lat: toLat, to_lng: toLng }),
  });
  if (!S.savedJourneys.some((j) => j.id === res.id)) S.savedJourneys.unshift(res);
  afterJourneysChanged();
}

async function removeJourney(id) {
  await api(`/api/saved-journeys/${id}`, { method: "DELETE" }).catch(() => {});
  S.savedJourneys = S.savedJourneys.filter((j) => j.id !== id);
  afterJourneysChanged();
}

function afterJourneysChanged() {
  const n = S.favs.length + S.savedJourneys.length;
  const badge = $("nav-saved-count");
  badge.textContent = n;
  badge.classList.toggle("hidden", n === 0);
  updateJourneyCardSaveBtns();
  if (S.view === "saved") renderSaved();
}

function updateJourneyCardSaveBtns() {
  document.querySelectorAll(".jcard-save").forEach((btn) => {
    const card = btn.closest(".journey-card");
    if (!card) return;
    const fLat = parseFloat(card.dataset.fromLat);
    const fLng = parseFloat(card.dataset.fromLng);
    const tLat = parseFloat(card.dataset.toLat);
    const tLng = parseFloat(card.dataset.toLng);
    if (isNaN(fLat)) return;
    const saved = isJourneySaved(fLat, fLng, tLat, tLng);
    btn.classList.toggle("saved", saved);
    btn.setAttribute("aria-label", saved ? "Remove saved route" : "Save route");
  });
}

// ── Plan view ─────────────────────────────────────────────

const planState = {
  fromCode: null, fromName: null, fromLat: null, fromLng: null,
  toCode:   null, toName:   null, toLat:   null, toLng:   null,
};

const ONEMAP_URL = "https://www.onemap.gov.sg/api/common/elastic/search";

async function oneMapSearch(q) {
  try {
    const r = await fetch(
      `${ONEMAP_URL}?searchVal=${encodeURIComponent(q)}&returnGeom=Y&getAddrDetails=Y&pageNum=1`
    );
    if (!r.ok) return [];
    const d = await r.json();
    return (d.results || []).slice(0, 5).map((s) => ({
      name:    s.BUILDING && s.BUILDING !== "NIL" ? s.BUILDING : (s.ADDRESS || s.SEARCHVAL),
      address: s.ADDRESS || "",
      lat:     parseFloat(s.LATITUDE),
      lng:     parseFloat(s.LONGITUDE),
    })).filter((s) => s.lat && s.lng && !isNaN(s.lat));
  } catch { return []; }
}

function setupPlanField(field) {
  const input = $(`plan-${field}-input`);
  const clear = $(`plan-${field}-clear`);
  const ac    = $(`plan-${field}-ac`);
  const near  = $(`plan-${field}-near`);
  let acTmr   = null;

  function clearSel() {
    planState[`${field}Code`] = null; planState[`${field}Name`] = null;
    planState[`${field}Lat`]  = null; planState[`${field}Lng`]  = null;
  }

  input.addEventListener("input", () => {
    const v = input.value.trim();
    v ? show(clear) : hide(clear);
    clearSel();
    clearTimeout(acTmr);
    acTmr = setTimeout(async () => {
      if (!v || v.length < 2) { hide(ac); ac.innerHTML = ""; return; }
      const [stops, places] = await Promise.all([
        api(`/api/stops/search?q=${encodeURIComponent(v)}&limit=5`).catch(() => ({ results: [] })),
        oneMapSearch(v),
      ]);
      const stopHtml = (stops.results || []).map((s) => `
        <div class="ac-item" data-code="${esc(s.bus_stop_code)}"
             data-name="${esc(s.description || s.bus_stop_code)}"
             data-lat="${s.latitude || ""}" data-lng="${s.longitude || ""}">
          <span class="ac-code">${esc(s.bus_stop_code)}</span>
          <div>
            <div class="ac-name">${esc(s.description || "Bus stop")}</div>
            <div class="ac-road">${esc(s.road_name || "")}</div>
          </div>
        </div>`).join("");
      const placeHtml = places.map((p) => `
        <div class="ac-item ac-place" data-lat="${p.lat}" data-lng="${p.lng}"
             data-name="${esc(p.name)}">
          <svg class="ac-place-icon" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M20 10c0 6-8 12-8 12s-8-6-8-12a8 8 0 0 1 16 0Z"/><circle cx="12" cy="10" r="3"/></svg>
          <div>
            <div class="ac-name">${esc(p.name)}</div>
            <div class="ac-road">${esc(p.address)}</div>
          </div>
        </div>`).join("");
      const div = placeHtml && stopHtml ? `<div class="ac-divider"></div>` : "";
      ac.innerHTML = stopHtml + div + placeHtml ||
        `<div class="ac-empty">No results for "${esc(v)}".</div>`;
      show(ac);
    }, 250);
  });

  input.addEventListener("keydown", (e) => { if (e.key === "Escape") hide(ac); });

  clear.addEventListener("click", () => {
    input.value = ""; hide(clear); hide(ac); ac.innerHTML = "";
    clearSel(); input.focus();
  });

  ac.addEventListener("click", (e) => {
    const item = e.target.closest(".ac-item");
    if (!item) return;
    setPlanLocation(field,
      item.dataset.code || null, item.dataset.name,
      item.dataset.lat  ? parseFloat(item.dataset.lat)  : null,
      item.dataset.lng  ? parseFloat(item.dataset.lng)  : null,
    );
  });

  near.addEventListener("click", () => {
    if (!navigator.geolocation) { toast("Location not supported on this device"); return; }
    toast("Getting your location…");
    navigator.geolocation.getCurrentPosition(
      (pos) => { setPlanLocation(field, null, "Current location", pos.coords.latitude, pos.coords.longitude); },
      () => toast("Location permission needed"),
      { enableHighAccuracy: true, timeout: 8000, maximumAge: 60_000 },
    );
  });

  document.addEventListener("click", (e) => {
    if (!ac.contains(e.target) && e.target !== input && !e.target.closest(`#plan-${field}-near`))
      hide(ac);
  });
}

function setPlanLocation(field, code, name, lat, lng) {
  planState[`${field}Code`] = code;
  planState[`${field}Name`] = name || code;
  planState[`${field}Lat`]  = lat;
  planState[`${field}Lng`]  = lng;
  $(`plan-${field}-input`).value = planState[`${field}Name`];
  show($(`plan-${field}-clear`));
  hide($(`plan-${field}-ac`));
  $(`plan-${field}-ac`).innerHTML = "";
}

$("plan-swap").addEventListener("click", () => {
  const { fromCode, fromName, fromLat, fromLng, toCode, toName, toLat, toLng } = planState;
  if (toCode || toLat)     setPlanLocation("from", toCode, toName, toLat, toLng);
  else {
    planState.fromCode = null; planState.fromName = null;
    planState.fromLat  = null; planState.fromLng  = null;
    $("plan-from-input").value = ""; hide($("plan-from-clear"));
  }
  if (fromCode || fromLat) setPlanLocation("to", fromCode, fromName, fromLat, fromLng);
  else {
    planState.toCode = null; planState.toName = null;
    planState.toLat  = null; planState.toLng  = null;
    $("plan-to-input").value = ""; hide($("plan-to-clear"));
  }
});

$("plan-btn").addEventListener("click", doJourneyPlan);
$("plan-results").addEventListener("click", (e) => {
  const go = e.target.closest(".jcard-go");
  if (go) { go.closest(".journey-card").classList.toggle("open"); return; }

  const shareBtn = e.target.closest(".jcard-share");
  if (shareBtn) { shareCurrentJourney(); return; }

  const saveBtn = e.target.closest(".jcard-save");
  if (saveBtn) {
    if (!S.token) { toast("Log in to save routes"); openSheet(); return; }
    const card = saveBtn.closest(".journey-card");
    const fLat = parseFloat(card.dataset.fromLat);
    const fLng = parseFloat(card.dataset.fromLng);
    const tLat = parseFloat(card.dataset.toLat);
    const tLng = parseFloat(card.dataset.toLng);
    if (isNaN(fLat)) { toast("Location data unavailable"); return; }
    const existing = getJourney(fLat, fLng, tLat, tLng);
    if (existing) {
      removeJourney(existing.id).then(() => toast("Route removed"));
    } else {
      saveJourney(card.dataset.fromName, fLat, fLng, card.dataset.toName, tLat, tLng)
        .then(() => toast("Route saved"))
        .catch((err) => toast(err.message || "Couldn't save route"));
    }
  }
});

async function doJourneyPlan() {
  const { fromCode, fromLat, fromLng, fromName,
          toCode,   toLat,   toLng,   toName } = planState;

  const hasFrom = fromCode || (fromLat !== null);
  const hasTo   = toCode   || (toLat   !== null);
  if (!hasFrom || !hasTo) { toast("Select both a From and To location first"); return; }

  const err  = $("plan-error");
  const res  = $("plan-results");
  const load = $("plan-loading");
  hide(err); res.innerHTML = ""; show(load);
  $("plan-btn").disabled = true;

  try {
    let fLat = fromLat, fLng = fromLng;
    let tLat = toLat,   tLng = toLng;

    // Resolve any bus-stop-only selections to lat/lng; write back so save button can use them
    if (fromCode && fLat === null) {
      const s = await api(`/api/stops/${fromCode}`).catch(() => null);
      if (s?.latitude) { fLat = planState.fromLat = s.latitude; fLng = planState.fromLng = s.longitude; }
    }
    if (toCode && tLat === null) {
      const s = await api(`/api/stops/${toCode}`).catch(() => null);
      if (s?.latitude) { tLat = planState.toLat = s.latitude; tLng = planState.toLng = s.longitude; }
    }

    let planData = null;
    if (fLat !== null && tLat !== null) {
      planData = await api(
        `/api/journey/multimodal?from_lat=${fLat}&from_lng=${fLng}` +
        `&to_lat=${tLat}&to_lng=${tLng}` +
        `&from_name=${encodeURIComponent(fromName || "Origin")}` +
        `&to_name=${encodeURIComponent(toName || "Destination")}`
      );
      res.innerHTML = renderMultimodalResult(planData);
    } else if (fromCode && toCode) {
      planData = await api(
        `/api/journey/plan?from_code=${encodeURIComponent(fromCode)}&to_code=${encodeURIComponent(toCode)}`
      );
      res.innerHTML = renderBusOnlyResult(planData);
    } else {
      err.textContent = "Couldn't resolve location. Try a more specific address or bus stop.";
      show(err);
    }
    if (planData) {
      updatePlanMap(planData, { fLat, fLng, tLat, tLng, fromName, toName });
      updateShareUrl();
    }
    updateJourneyCardSaveBtns();
    pushRecent();
  } catch (e) {
    const msg = e.message.includes("503")
      ? "Route data not loaded yet on the server — try again shortly."
      : `Couldn't plan journey: ${e.message}`;
    err.textContent = msg; show(err);
  } finally {
    hide(load); $("plan-btn").disabled = false;
  }
}

// ── Recent searches ───────────────────────────────────────
const RECENTS_KEY = "sgbus_recent_plans";

function pushRecent() {
  const { fromName, fromLat, fromLng, fromCode, toName, toLat, toLng, toCode } = planState;
  if (!fromName || !toName) return;
  const list = readJSON(RECENTS_KEY, []).filter(
    (r) => !(r.fromName === fromName && r.toName === toName)
  );
  list.unshift({ fromName, fromLat, fromLng, fromCode, toName, toLat, toLng, toCode });
  writeJSON(RECENTS_KEY, list.slice(0, 5));
  renderRecents();
}

function renderRecents() {
  const box = $("plan-recents");
  if (!box) return;
  const list = readJSON(RECENTS_KEY, []);
  if (!list.length) { box.classList.add("hidden"); return; }
  box.innerHTML = `<span class="recents-label">Recent</span>` + list.map((r, i) => `
    <button class="recent-chip" data-i="${i}">
      ${esc(r.fromName)} <span class="recent-arrow">→</span> ${esc(r.toName)}
    </button>`).join("");
  box.classList.remove("hidden");
}

$("plan-recents")?.addEventListener("click", (e) => {
  const chip = e.target.closest(".recent-chip");
  if (!chip) return;
  const r = readJSON(RECENTS_KEY, [])[+chip.dataset.i];
  if (!r) return;
  setPlanLocation("from", r.fromCode || null, r.fromName, r.fromLat, r.fromLng);
  setPlanLocation("to",   r.toCode   || null, r.toName,   r.toLat,   r.toLng);
  doJourneyPlan();
});

// ── Render: bus-only (stop-code → stop-code) ─────────────
function renderBusOnlyResult(data) {
  if (!data.options?.length && !data.unavailable?.length) {
    return `<div class="plan-no-routes">${esc(data.message || "No route found. Try nearby stops.")}</div>`;
  }
  return (data.options?.length ? data.options.map(renderBusOnlyCard).join("") : "")
    + _unavailableSection(data);
}

function renderBusOnlyCard(opt) {
  const typeTxt = opt.transfers === 0 ? "Direct"
    : `${opt.transfers} transfer${opt.transfers > 1 ? "s" : ""}`;
  const badgesHtml = opt.legs.map((l, i, a) =>
    `<span class="jcard-badge">${esc(l.service_no)}</span>` +
    (i < a.length - 1
      ? `<svg class="jcard-arrow" width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round"><path d="m9 18 6-6-6-6"/></svg>`
      : "")
  ).join("");
  const first = opt.legs[0];
  const waitPart = first.wait_min !== null
    ? (first.wait_min === 0 ? "Arriving" : `${first.wait_min}m wait`) + " · " : "";
  const warnPart = opt.has_last_bus_warning ? ` <span class="last-bus-warn">⚠ Last bus</span>` : "";
  const detailHtml = opt.legs.map((leg, li, arr) =>
    renderBusLeg(leg) +
    (li < arr.length - 1 ? `
      <div class="journey-transfer">
        <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round"><polyline points="17 1 21 5 17 9"/><path d="M3 11V9a4 4 0 0 1 4-4h14"/><polyline points="7 23 3 19 7 15"/><path d="M21 13v2a4 4 0 0 1-4 4H3"/></svg>
        Transfer at ${esc(leg.alight_stop.name)}
      </div>` : "")
  ).join("");
  const fLat = planState.fromLat ?? ""; const fLng = planState.fromLng ?? "";
  const tLat = planState.toLat   ?? ""; const tLng = planState.toLng   ?? "";
  const saved = (fLat !== "" && tLat !== "") && isJourneySaved(parseFloat(fLat), parseFloat(fLng), parseFloat(tLat), parseFloat(tLng));
  return `
    <div class="journey-card"
         data-from-lat="${fLat}" data-from-lng="${fLng}"
         data-to-lat="${tLat}" data-to-lng="${tLng}"
         data-from-name="${esc(planState.fromName || "")}" data-to-name="${esc(planState.toName || "")}">
      <div class="jcard-summary">
        <div class="jcard-routes">${badgesHtml}</div>
        <div class="jcard-meta">
          <span class="jcard-type">${typeTxt}</span>
          <span class="jcard-subtext">${waitPart}~${opt.total_est_min} min${warnPart}</span>
        </div>
        <button class="jcard-share" aria-label="Share this route" title="Copy shareable link">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="18" cy="5" r="3"/><circle cx="6" cy="12" r="3"/><circle cx="18" cy="19" r="3"/><line x1="8.59" y1="13.51" x2="15.42" y2="17.49"/><line x1="15.41" y1="6.51" x2="8.59" y2="10.49"/></svg>
        </button>
        <button class="jcard-save${saved ? " saved" : ""}" aria-label="${saved ? "Remove saved route" : "Save route"}">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linejoin="round"><path d="m19 21-7-4-7 4V5a2 2 0 0 1 2-2h10a2 2 0 0 1 2 2z"/></svg>
        </button>
        <button class="jcard-go">Go
          <svg class="chev" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="6 9 12 15 18 9"/></svg>
        </button>
      </div>
      <div class="jcard-detail">${detailHtml}</div>
    </div>`;
}

function catchLine(c) {
  if (!c) return "";
  if (c.status === "make") {
    return `<span class="jcard-catch make">✓ You'll make the ${esc(c.service_no)} — ${c.margin_min} min to spare</span>`;
  }
  if (c.status === "tight") {
    return `<span class="jcard-catch tight">⚠ Tight — leave now to catch the ${esc(c.service_no)}</span>`;
  }
  const next = c.next_wait_min != null
    ? ` — next one in ${c.next_wait_min} min`
    : "";
  return `<span class="jcard-catch miss">✗ ${c.walk_min} min walk, bus in ${c.walk_min + c.margin_min} — you'll likely miss it${next}</span>`;
}

function renderUnavailableCard(opt) {
  const badgesHtml = (opt.legs || [])
    .filter((l) => l.type === "bus" || l.type === "mrt")
    .map((l) => l.type === "mrt"
      ? `<span class="jcard-badge mrt-badge" style="opacity:.45">${esc(l.line || "MRT")}</span>`
      : `<span class="jcard-badge" style="opacity:.45">${esc(l.service_no)}</span>`)
    .join("") || `<span class="jcard-badge" style="opacity:.45">${esc(opt.mode === "mrt" ? "MRT" : "Bus")}</span>`;
  return `
    <div class="journey-card unavailable-card">
      <div class="jcard-summary">
        <div class="jcard-routes">${badgesHtml}</div>
        <div class="jcard-meta">
          <span class="unavail-reason">${esc(opt.unavailable_reason)}</span>
        </div>
      </div>
    </div>`;
}

function _unavailableSection(data) {
  if (!data.unavailable?.length) return "";
  return data.unavailable.map(renderUnavailableCard).join("");
}

// ── Render: multimodal (address → address) ────────────────
function renderMultimodalResult(data) {
  if (!data.options?.length && !data.unavailable?.length) {
    return `<div class="plan-no-routes">No routes found between these locations. Try addresses closer to bus stops or MRT stations.</div>`;
  }
  return (data.options?.length ? data.options.map(renderMultimodalCard).join("") : "")
    + _unavailableSection(data);
}

function renderMultimodalCard(opt) {
  const active = opt.legs.filter((l) => l.type !== "walk");
  const badgesHtml = active.map((l, i, a) =>
    (l.type === "mrt"
      ? `<span class="jcard-badge mrt-badge" style="background:${esc(l.line_color)}">${esc(l.line)}</span>`
      : `<span class="jcard-badge">${esc(l.service_no)}</span>`) +
    (i < a.length - 1
      ? `<svg class="jcard-arrow" width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round"><path d="m9 18 6-6-6-6"/></svg>`
      : "")
  ).join("") || `<span class="jcard-badge jcard-walk-only">Walk</span>`;

  const firstActive = active[0];
  const fw = firstActive?.wait_min;
  const waitPart = fw != null ? (fw === 0 ? "Arriving · " : `${fw}m wait · `) : "";
  const typeTxt = opt.mode === "mrt"
    ? (active.length > 1 ? `MRT (${active.length - 1} xfer)` : "MRT")
    : opt.transfers === 0 ? "Direct bus" : `Bus (${opt.transfers} xfer)`;
  const warnPart = opt.has_last_bus_warning ? ` <span class="last-bus-warn">⚠ Last bus</span>` : "";
  const alertPart = opt.train_alert ? ` <span class="last-bus-warn">⚠ Train alert</span>` : "";
  const catchHtml = catchLine(opt.catch);

  const detailHtml = opt.legs.map((leg, li, arr) => {
    const next = arr[li + 1];
    const html = renderLegDetail(leg);
    if (leg.type !== "walk" && next && next.type !== "walk") {
      const atName = leg.type === "bus" ? leg.alight_stop?.name : leg.to_station;
      return html + `
        <div class="journey-transfer">
          <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round"><polyline points="17 1 21 5 17 9"/><path d="M3 11V9a4 4 0 0 1 4-4h14"/><polyline points="7 23 3 19 7 15"/><path d="M21 13v2a4 4 0 0 1-4 4H3"/></svg>
          Transfer at ${esc(atName || "interchange")}
        </div>`;
    }
    return html;
  }).join("");

  const fLat = planState.fromLat ?? ""; const fLng = planState.fromLng ?? "";
  const tLat = planState.toLat   ?? ""; const tLng = planState.toLng   ?? "";
  const saved = (fLat !== "" && tLat !== "") && isJourneySaved(parseFloat(fLat), parseFloat(fLng), parseFloat(tLat), parseFloat(tLng));
  return `
    <div class="journey-card"
         data-from-lat="${fLat}" data-from-lng="${fLng}"
         data-to-lat="${tLat}" data-to-lng="${tLng}"
         data-from-name="${esc(planState.fromName || "")}" data-to-name="${esc(planState.toName || "")}">
      <div class="jcard-summary">
        <div class="jcard-routes">${badgesHtml}</div>
        <div class="jcard-meta">
          <span class="jcard-type">${typeTxt}</span>
          <span class="jcard-subtext">${waitPart}~${opt.total_est_min} min${warnPart}${alertPart}</span>
          ${catchHtml}
        </div>
        <button class="jcard-share" aria-label="Share this route" title="Copy shareable link">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="18" cy="5" r="3"/><circle cx="6" cy="12" r="3"/><circle cx="18" cy="19" r="3"/><line x1="8.59" y1="13.51" x2="15.42" y2="17.49"/><line x1="15.41" y1="6.51" x2="8.59" y2="10.49"/></svg>
        </button>
        <button class="jcard-save${saved ? " saved" : ""}" aria-label="${saved ? "Remove saved route" : "Save route"}">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linejoin="round"><path d="m19 21-7-4-7 4V5a2 2 0 0 1 2-2h10a2 2 0 0 1 2 2z"/></svg>
        </button>
        <button class="jcard-go">Go
          <svg class="chev" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="6 9 12 15 18 9"/></svg>
        </button>
      </div>
      <div class="jcard-detail">${detailHtml}</div>
    </div>`;
}

function renderLegDetail(leg) {
  if (leg.type === "walk") return renderWalkLeg(leg);
  if (leg.type === "mrt")  return renderMrtLeg(leg);
  return renderBusLeg(leg);
}

function renderWalkLeg(leg) {
  return `
    <div class="journey-leg walk-leg">
      <div class="leg-top">
        <span class="leg-route walk-route">
          <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="5" r="1"/><path d="m9 20 3-6 3 2 2-8"/><path d="m6 9 6-1 4.5 1"/></svg>
          Walk
        </span>
        <span class="leg-stops">${leg.distance_m} m · ~${leg.walk_min} min</span>
      </div>
      <div class="leg-stop-row">
        <span class="leg-stop-label">From</span>
        <span class="leg-stop-name">${esc(leg.from_name)}</span>
      </div>
      <div class="leg-stop-row">
        <span class="leg-stop-label">To</span>
        <span class="leg-stop-name">${esc(leg.to_name)}</span>
      </div>
    </div>`;
}

function renderMrtLeg(leg) {
  const waitTxt   = leg.wait_min === 0 ? "Arriving"
    : leg.wait_min != null ? `Wait ~${leg.wait_min} min` : "—";
  const waitClass = leg.wait_min === 0 ? "due" : "";
  return `
    <div class="journey-leg mrt-leg">
      <div class="leg-top">
        <span class="leg-route mrt-route" style="background:${esc(leg.line_color)};color:#fff">${esc(leg.line)}</span>
        <span class="leg-stops">${leg.stations_count} stops · ~${leg.est_ride_min} min</span>
        <span class="leg-wait ${waitClass}">${waitTxt}</span>
      </div>
      <div class="leg-stop-row">
        <span class="leg-stop-label">Board</span>
        <span class="leg-stop-name">${esc(leg.from_station)} MRT</span>
        <span class="leg-stop-code">${esc(leg.from_code)}</span>
      </div>
      <div class="leg-stop-row">
        <span class="leg-stop-label">Alight</span>
        <span class="leg-stop-name">${esc(leg.to_station)} MRT</span>
        <span class="leg-stop-code">${esc(leg.to_code)}</span>
      </div>
      <div class="leg-line-name" style="color:${esc(leg.line_color)}">${esc(leg.line_name)}</div>
    </div>`;
}

function renderBusLeg(leg) {
  const waitTxt   = leg.wait_min === null ? "—"
    : leg.wait_min === 0 ? "Arriving"
    : leg.is_transfer_wait ? `Transfer wait ${leg.wait_min} min`
    : `Wait ${leg.wait_min} min`;
  const waitClass = leg.wait_min === 0 ? "due" : "";
  const ltaDt     = parseUTC(leg.lta_arrival);
  const aiDt      = parseUTC(leg.ai_arrival);
  const adj       = leg.ai_adj_sec || 0;
  const lastHtml  = leg.is_last_bus_soon ? `<span class="last-bus-tag">Last bus</span>` : "";

  let timingHtml = "";
  if (ltaDt) {
    const aiHtml = aiDt && Math.abs(adj) >= 15
      ? `<span class="leg-ai">AI ${fmtClock(aiDt)}</span>` : "";
    timingHtml = `
      <div class="leg-timing">
        <b>${fmtClock(ltaDt)}</b><span class="lta-tag">LTA</span>${adjChip(adj)}${aiHtml}
      </div>`;
  }

  return `
    <div class="journey-leg">
      <div class="leg-top">
        <span class="leg-route">${esc(leg.service_no)}</span>
        <span class="leg-stops">${leg.stops_count} stops · ~${leg.est_ride_min} min</span>
        <span class="leg-wait ${waitClass}">${waitTxt}</span>
        ${lastHtml}
      </div>
      <div class="leg-stop-row">
        <span class="leg-stop-label">Board</span>
        <span class="leg-stop-name">${esc(leg.board_stop.name)}</span>
        <span class="leg-stop-code">${esc(leg.board_stop.code)}</span>
      </div>
      ${timingHtml}
      <div class="leg-stop-row">
        <span class="leg-stop-label">Alight</span>
        <span class="leg-stop-name">${esc(leg.alight_stop.name)}</span>
        <span class="leg-stop-code">${esc(leg.alight_stop.code)}</span>
      </div>
    </div>`;
}

// ── Cleanup + init ────────────────────────────────────────
window.addEventListener("pagehide", () => {
  clearInterval(S.refreshTmr);
  clearInterval(S.tickTmr);
});

async function checkBackend() {
  try {
    const ctrl = new AbortController();
    setTimeout(() => ctrl.abort(), 6000);
    await fetch(API_BASE + "/api/health", { signal: ctrl.signal });
    hide($("offline-banner"));
  } catch {
    show($("offline-banner"));
  }
}

// ── Change password ───────────────────────────────────────
$("pw-change-btn")?.addEventListener("click", async () => {
  const cur = $("pw-current").value;
  const nw  = $("pw-new").value;
  const err = $("pw-error");
  hide(err);
  if (nw.length < 8) {
    err.textContent = "New password must be at least 8 characters.";
    show(err); return;
  }
  try {
    await api("/api/auth/change-password", {
      method: "POST",
      body: JSON.stringify({ current_password: cur, new_password: nw }),
    });
    $("pw-current").value = ""; $("pw-new").value = "";
    toast("Password updated");
  } catch (e) {
    err.textContent = e.message || "Couldn't update password.";
    show(err);
  }
});

// ── Maps ──────────────────────────────────────────────────
// Leaflet is loaded async (defer); guard every call with typeof L check.
let _stopMap   = null;   // Leaflet instance for arrivals tab
let _planMap   = null;   // Leaflet instance for plan tab

function _leafletReady() { return typeof L !== "undefined"; }

// Retry a map call once Leaflet has loaded (for hash/URL auto-loads that run before defer scripts)
function _whenLeaflet(fn) {
  if (_leafletReady()) { fn(); return; }
  window.addEventListener("load", fn, { once: true });
}

function _sgTiles() {
  return L.tileLayer(
    "https://www.onemap.gov.sg/maps/tiles/Default/{z}/{x}/{y}.png",
    { maxZoom: 18, minZoom: 11, attribution: "" }
  );
}

// Show/hide the stop map panel and render the stop pin + nearby pins.
function updateStopMap(arrivals) {
  if (!_leafletReady()) { _whenLeaflet(() => updateStopMap(arrivals)); return; }
  const wrap = $("stop-map-wrap");
  const lat = arrivals?.latitude, lng = arrivals?.longitude;
  if (!lat || !lng) { hide(wrap); return; }
  show(wrap);

  const container = $("stop-map");
  if (!_stopMap) {
    _stopMap = L.map(container, { zoomControl: true, attributionControl: false }).setView([lat, lng], 16);
    _sgTiles().addTo(_stopMap);
  } else {
    _stopMap.setView([lat, lng], 16);
    _stopMap.eachLayer((l) => { if (l instanceof L.Marker || l instanceof L.CircleMarker) l.remove(); });
  }

  // Main stop pin
  const stopIcon = L.divIcon({
    className: "",
    html: `<div style="width:14px;height:14px;border-radius:50%;background:var(--accent);border:3px solid #fff;box-shadow:0 1px 4px rgba(0,0,0,.4)"></div>`,
    iconSize: [14, 14], iconAnchor: [7, 7],
  });
  L.marker([lat, lng], { icon: stopIcon })
   .bindPopup(`<b>${esc(S.stopInfo?.description || arrivals.bus_stop_code)}</b><br>${esc(S.stopInfo?.road_name || "")}`)
   .addTo(_stopMap);

  // Nearby stop pins (nearby endpoint now returns lat/lng)
  api(`/api/stops/nearby?lat=${lat}&lng=${lng}&limit=12`).then((d) => {
    if (!_stopMap) return;
    const nearIcon = L.divIcon({
      className: "",
      html: `<div style="width:9px;height:9px;border-radius:50%;background:var(--ink-3);border:2px solid #fff;box-shadow:0 1px 3px rgba(0,0,0,.3)"></div>`,
      iconSize: [9, 9], iconAnchor: [4, 4],
    });
    d.results?.forEach((s) => {
      if (s.bus_stop_code === arrivals.bus_stop_code) return;
      if (!s.latitude) return;
      L.marker([s.latitude, s.longitude], { icon: nearIcon })
       .bindPopup(`<b>${esc(s.description)}</b><br>${esc(s.road_name || "")} · ${s.bus_stop_code}`)
       .on("click", () => loadStop(s.bus_stop_code))
       .addTo(_stopMap);
    });
  }).catch(() => {});
}

// Wire the toggle button
$("stop-map-toggle").addEventListener("click", () => {
  const btn = $("stop-map-toggle");
  const map = $("stop-map");
  const open = btn.getAttribute("aria-expanded") === "true";
  btn.setAttribute("aria-expanded", String(!open));
  btn.textContent = "";
  btn.innerHTML = `
    <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polygon points="3 6 9 3 15 6 21 3 21 18 15 21 9 18 3 21"/></svg>
    ${open ? "Show on map" : "Hide map"}
    <svg class="chev" width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="6 9 12 15 18 9"/></svg>`;
  map.classList.toggle("open", !open);
  if (!open && _stopMap) {
    // Leaflet needs size invalidated after the container becomes visible
    setTimeout(() => _stopMap.invalidateSize(), 230);
  }
});

// Line colors for MRT (matches mrt_data.py line_color values)
const MRT_COLORS = {
  EWL: "#009645", NSL: "#d42e12", NEL: "#9900aa",
  CCL: "#fa9e0d", DTL: "#005ec4", TEL: "#9D5B25",
};

// Colour for a journey leg polyline
function _legColor(leg) {
  if (leg.type === "walk") return "#888";
  if (leg.type === "mrt") return leg.line_color || MRT_COLORS[leg.line] || "#555";
  return "#e5282a"; // bus red
}

function updatePlanMap(data, coords) {
  if (!_leafletReady()) { _whenLeaflet(() => updatePlanMap(data, coords)); return; }
  let { fLat, fLng, tLat, tLng, fromName, toName } = coords;
  const wrap = $("plan-map-wrap");
  // Fall back to coords in the response (bus-only plan has them in data.from/to)
  const rLat = fLat ?? data?.from?.lat, rLng = fLng ?? data?.from?.lng;
  const dLat = tLat ?? data?.to?.lat,   dLng = tLng ?? data?.to?.lng;
  fLat = rLat; fLng = rLng; tLat = dLat; tLng = dLng;
  fromName = fromName || data?.from?.name || "Origin";
  toName   = toName   || data?.to?.name   || "Destination";
  if (!fLat || !tLat) { hide(wrap); return; }

  show(wrap);
  const container = $("plan-map");
  if (!_planMap) {
    _planMap = L.map(container, { zoomControl: true, attributionControl: false })
               .setView([(fLat + tLat) / 2, (fLng + tLng) / 2], 13);
    _sgTiles().addTo(_planMap);
  } else {
    _planMap.eachLayer((l) => { if (!(l instanceof L.TileLayer)) l.remove(); });
  }

  const bounds = [];

  // Origin + destination pins
  const pinIcon = (color, label) => L.divIcon({
    className: "",
    html: `<div style="width:30px;height:30px;border-radius:50% 50% 50% 0;background:${color};transform:rotate(-45deg);border:3px solid #fff;box-shadow:0 2px 6px rgba(0,0,0,.4)">
      <span style="display:block;transform:rotate(45deg);text-align:center;font-size:10px;font-weight:700;color:#fff;line-height:24px">${label}</span></div>`,
    iconSize: [30, 30], iconAnchor: [15, 30],
  });
  L.marker([fLat, fLng], { icon: pinIcon("#3b82f6", "A") })
   .bindPopup(`<b>From:</b> ${esc(fromName || "Origin")}`)
   .addTo(_planMap);
  bounds.push([fLat, fLng]);

  L.marker([tLat, tLng], { icon: pinIcon("#e5282a", "B") })
   .bindPopup(`<b>To:</b> ${esc(toName || "Destination")}`)
   .addTo(_planMap);
  bounds.push([tLat, tLng]);

  // Draw the first available option's legs
  const option = data.options?.[0];
  if (option?.legs) {
    option.legs.forEach((leg) => {
      const color = _legColor(leg);
      const dashArray = leg.type === "walk" ? "5,8" : null;
      const points = _legPoints(leg, fLat, fLng, tLat, tLng);
      if (points.length >= 2) {
        L.polyline(points, { color, weight: leg.type === "walk" ? 3 : 5, opacity: .85, dashArray })
         .addTo(_planMap);
        points.forEach((p) => bounds.push(p));
      }
      // Stop markers for bus legs
      if (leg.type === "bus") {
        _busStopMarker(leg.board_stop, "#fff", color).addTo(_planMap);
        _busStopMarker(leg.alight_stop, "#fff", color).addTo(_planMap);
      }
    });
  }

  if (bounds.length) _planMap.fitBounds(bounds, { padding: [32, 32] });
  setTimeout(() => _planMap.invalidateSize(), 100);
}

function _legPoints(leg, fLat, fLng, tLat, tLng) {
  if (leg.type === "walk") {
    // Walk legs don't have coordinates in the response; approximate with origin/destination
    // The real path isn't meaningful without routing, so just a straight line is fine.
    const from = leg.from_lat != null ? [leg.from_lat, leg.from_lng] : null;
    const to   = leg.to_lat   != null ? [leg.to_lat,   leg.to_lng]   : null;
    if (from && to) return [from, to];
    return [];
  }
  if (leg.type === "bus") {
    const b = leg.board_stop, a = leg.alight_stop;
    if (b?.lat && a?.lat) return [[b.lat, b.lng], [a.lat, a.lng]];
    return [];
  }
  if (leg.type === "mrt") {
    const pts = [];
    if (leg.board_lat) pts.push([leg.board_lat, leg.board_lng]);
    if (leg.alight_lat) pts.push([leg.alight_lat, leg.alight_lng]);
    return pts;
  }
  return [];
}

function _busStopMarker(stop, fill, stroke) {
  if (!stop?.lat) return L.layerGroup();
  const icon = L.divIcon({
    className: "",
    html: `<div style="width:10px;height:10px;border-radius:50%;background:${fill};border:2.5px solid ${stroke};box-shadow:0 1px 3px rgba(0,0,0,.3)"></div>`,
    iconSize: [10, 10], iconAnchor: [5, 5],
  });
  return L.marker([stop.lat, stop.lng], { icon }).bindPopup(`<b>${esc(stop.name || stop.code)}</b>`);
}

// ── Shareable journey URLs ────────────────────────────────
function buildShareUrl() {
  const { fromLat, fromLng, fromName, fromCode, toLat, toLng, toName, toCode } = planState;
  if (!fromName || !toName) return null;
  const p = new URLSearchParams();
  if (fromLat != null) { p.set("fLat", fromLat.toFixed(6)); p.set("fLng", fromLng.toFixed(6)); }
  if (fromName) p.set("fName", fromName);
  if (fromCode) p.set("fCode", fromCode);
  if (toLat != null) { p.set("tLat", toLat.toFixed(6)); p.set("tLng", toLng.toFixed(6)); }
  if (toName) p.set("tName", toName);
  if (toCode) p.set("tCode", toCode);
  return `${location.origin}${location.pathname}?${p.toString()}#plan`;
}

function updateShareUrl() {
  const url = buildShareUrl();
  if (url) history.replaceState({}, "", url);
}

function shareCurrentJourney() {
  const url = buildShareUrl();
  if (!url) return;
  if (navigator.clipboard) {
    navigator.clipboard.writeText(url).then(() => showShareToast()).catch(() => fallbackCopy(url));
  } else {
    fallbackCopy(url);
  }
}

function fallbackCopy(text) {
  const ta = document.createElement("textarea");
  ta.value = text; ta.style.position = "fixed"; ta.style.opacity = "0";
  document.body.appendChild(ta); ta.select();
  try { document.execCommand("copy"); showShareToast(); } catch (_) {}
  document.body.removeChild(ta);
}

let _toastTimer = null;
function showShareToast() {
  const el = $("share-toast");
  el.classList.remove("hidden");
  clearTimeout(_toastTimer);
  _toastTimer = setTimeout(() => el.classList.add("hidden"), 2200);
}

// Read URL params on load and auto-populate the plan form
function bootFromUrl() {
  const p = new URLSearchParams(location.search);
  const fLat = p.get("fLat"), fLng = p.get("fLng"), fName = p.get("fName"), fCode = p.get("fCode");
  const tLat = p.get("tLat"), tLng = p.get("tLng"), tName = p.get("tName"), tCode = p.get("tCode");
  if (!fName || !tName) return;

  // Restore plan state
  planState.fromName = fName;
  planState.fromLat  = fLat ? parseFloat(fLat) : null;
  planState.fromLng  = fLng ? parseFloat(fLng) : null;
  planState.fromCode = fCode || null;
  planState.toName   = tName;
  planState.toLat    = tLat ? parseFloat(tLat) : null;
  planState.toLng    = tLng ? parseFloat(tLng) : null;
  planState.toCode   = tCode || null;

  $("plan-from-input").value = fName;
  $("plan-to-input").value   = tName;
  show($("plan-from-clear"));
  show($("plan-to-clear"));

  switchView("plan");
  // Small delay so the view switch completes before planning
  setTimeout(() => doJourneyPlan(), 300);
}

initTheme();
syncAccountUI();
afterFavsChanged();
renderChips();
loadModelInfo();
hydrateServerFavs();
checkBackend();
setupPlanField("from");
setupPlanField("to");
renderRecents();
if ("serviceWorker" in navigator) {
  navigator.serviceWorker.register("sw.js").catch(() => {});
}

// Boot: shared journey URL takes priority over stop hash
const bootStop = location.hash.replace("#", "").trim();
const hasShareParams = new URLSearchParams(location.search).get("fName");
if (hasShareParams) {
  bootFromUrl();
} else if (/^\d{5}$/.test(bootStop)) {
  loadStop(bootStop);
}
