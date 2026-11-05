"use strict";

/* SG Bus — app logic
   Views: arrivals / saved / data. Favourites live in localStorage and sync
   to the account (bearer token) when logged in. */

// ── Config ────────────────────────────────────────────────
const API_BASE   = "https://alston-b550mh.tail8c7cb3.ts.net";
// Google OAuth client ID for "Sign in with Google" (public value, safe to ship).
// Paste the same client ID you set as GOOGLE_CLIENT_ID on the backend. Leave
// empty to hide the Google button. Create one at
// https://console.cloud.google.com/apis/credentials → OAuth client → Web app.
const GOOGLE_CLIENT_ID = "362153323085-dlcbsnjvgb001b8cmnnc15e94egjc1ed.apps.googleusercontent.com";
const REFRESH_MS = 30_000;
const DUE_SECS   = 45;
const FAV_KEY    = "sgbus_favs";
const RECENT_KEY = "sgbus_recent";
const ALERTS_KEY = "sgbus_alerts";   // { stopCode: { service: thresholdSec } }
// Fire the arrival alert once the next bus is within this many seconds — early
// enough that there's still time to walk to the stop.
const ALERT_THRESHOLD_SEC = 60;   // ping when the bus is ~1 min away
const THEME_KEY  = "sgbus_theme";
const TOKEN_KEY  = "sgbus_token";
const USER_KEY   = "sgbus_user";
const DISPLAY_KEY = "sgbus_display_name";
// Version scheme — MAJOR.MINOR.PATCH (semver-style):
//   MAJOR  → big monthly overhauls / redesigns
//   MINOR  → new features
//   PATCH  → bug fixes & small tweaks (bumped on most pushes)
// Bump this on every push and keep the <span id="stg-version-val"> in
// index.html in sync.
const APP_VERSION = "1.2.51";

const POPULAR = [
  { code: "83139", description: "Bedok Int" },
  { code: "01012", description: "Hotel Grand Pacific" },
  { code: "03222", description: "Raffles Place" },
  { code: "09022", description: "Orchard Stn" },
];

// Journey planner (Plan tab) is archived: hidden from the nav, the Saved
// "Routes" section and shared plan links, but all its code is kept. Set to
// true to bring it back.
const PLAN_ENABLED = false;

const LOAD_LABEL = { SEA: "Seats", SDA: "Standing", LSD: "Crowded" };
const LOAD_FULL  = { SEA: "Seats available", SDA: "Standing only", LSD: "Limited standing — packed" };

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
  displayName: localStorage.getItem(DISPLAY_KEY) || null,
  authMode: "login",
  refreshTmr: null,
  tickTmr: null,
  acTmr: null,
  chartsDirty: false,
  alerts: readJSON(ALERTS_KEY, {}),
  firedAlerts: new Set(),  // de-dupe alerts already fired this session
  alertEtas: {},           // "stop|svc" → last known arrival ISO, for alerts
};
const charts = { service: null, ontime: null, hour: null, trend: null };

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
  toastTmr = setTimeout(() => hide(t), Math.min(5000, 2200 + Math.max(0, msg.length - 40) * 45));
}

function showConfirm(msg, okLabel, onConfirm, { cancelLabel = "Cancel", onCancel = null } = {}) {
  const el = document.createElement("div");
  el.className = "confirm-overlay";
  el.innerHTML = `<div class="confirm-card">
    <p class="confirm-msg">${msg}</p>
    <div class="confirm-btns">
      <button class="confirm-cancel">${cancelLabel}</button>
      <button class="confirm-ok">${okLabel}</button>
    </div>
  </div>`;
  document.body.appendChild(el);
  el.querySelector(".confirm-cancel").addEventListener("click", () => { el.remove(); onCancel?.(); });
  el.querySelector(".confirm-ok").addEventListener("click", () => { el.remove(); onConfirm(); });
  el.addEventListener("click", (e) => { if (e.target === el) el.remove(); });
}

function parseUTC(iso) {
  if (!iso) return null;
  const d = new Date(iso.endsWith("Z") ? iso : iso + "Z");
  // A malformed timestamp yields an Invalid Date, which would flow through
  // secsUntil as NaN and render a literal "NaN min" to the user.
  return Number.isNaN(d.getTime()) ? null : d;
}
function secsUntil(dt) { return dt ? (dt - Date.now()) / 1000 : null; }
function fmtMin(s) {
  if (s === null || Number.isNaN(s)) return "–";
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
  let r;
  try {
    r = await fetch(API_BASE + path, opts);
  } catch (e) {
    // Network-level failure (server / tunnel down): confirm with a health probe,
    // which raises the maintenance page if the backend really is unreachable.
    checkBackend();
    throw e;
  }
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

// ── Offline stop directory ────────────────────────────────
// Cache the full stop list so search + nearby keep working with no network
// (on the MRT, in dead-zones). Live arrivals still need the backend, but
// browsing/finding a stop no longer depends on it. Refreshed weekly.
const STOPS_ALL_KEY     = "sgbus_stops_all";
const STOPS_ALL_TS_KEY  = "sgbus_stops_all_ts";
const STOPS_CACHE_MAX_AGE = 7 * 86400 * 1000;  // 1 week
let _stopsCacheArr = null;

function _loadStopsCache() {
  if (_stopsCacheArr) return _stopsCacheArr;
  try { _stopsCacheArr = JSON.parse(localStorage.getItem(STOPS_ALL_KEY)) || []; }
  catch { _stopsCacheArr = []; }
  return _stopsCacheArr;
}

async function ensureStopsCache(force = false) {
  const ts = parseInt(localStorage.getItem(STOPS_ALL_TS_KEY) || "0", 10);
  const haveFresh = localStorage.getItem(STOPS_ALL_KEY) && (Date.now() - ts < STOPS_CACHE_MAX_AGE);
  if (!force && haveFresh) return;
  try {
    const d = await api("/api/stops/all");
    if (d.stops?.length) {
      localStorage.setItem(STOPS_ALL_KEY, JSON.stringify(d.stops));
      localStorage.setItem(STOPS_ALL_TS_KEY, String(Date.now()));
      _stopsCacheArr = d.stops;
    }
  } catch { /* offline — keep whatever (if anything) we already had */ }
}

// Same shape as /api/stops/search, computed locally from the cache.
function localStopSearch(q, limit = 6) {
  const arr = _loadStopsCache();
  const s = (q || "").trim().toLowerCase();
  if (!arr.length || !s) return { results: [] };
  const scored = [];
  for (const st of arr) {
    const code = (st.bus_stop_code || "").toLowerCase();
    const desc = (st.description || "").toLowerCase();
    const road = (st.road_name || "").toLowerCase();
    let score = -1;
    if (code === s) score = 0;
    else if (code.startsWith(s)) score = 1;
    else if (desc.includes(s)) score = 2;
    else if (road.includes(s)) score = 3;
    if (score >= 0) scored.push([score, st]);
  }
  scored.sort((a, b) => a[0] - b[0] || a[1].bus_stop_code.localeCompare(b[1].bus_stop_code));
  return { results: scored.slice(0, limit).map(([, st]) => st) };
}

// Same shape as /api/stops/nearby (adds distance_m), computed locally.
function localNearby(lat, lng, limit = 20) {
  const arr = _loadStopsCache();
  if (!arr.length) return { results: [] };
  const R = 6371000, rad = (x) => (x * Math.PI) / 180;
  const out = [];
  for (const st of arr) {
    if (st.latitude == null) continue;
    const dp = rad(st.latitude - lat), dl = rad(st.longitude - lng);
    const a = Math.sin(dp / 2) ** 2 +
      Math.cos(rad(lat)) * Math.cos(rad(st.latitude)) * Math.sin(dl / 2) ** 2;
    out.push({ ...st, distance_m: Math.round(2 * R * Math.asin(Math.sqrt(a))) });
  }
  out.sort((a, b) => a.distance_m - b.distance_m);
  return { results: out.slice(0, limit) };
}

// ── Theme ─────────────────────────────────────────────────
function applyTheme(t) {
  document.documentElement.setAttribute("data-theme", t);
  try { localStorage.setItem(THEME_KEY, t); } catch {}
  const meta = document.getElementById("theme-color-meta");
  if (meta) meta.content = t === "light" ? "#f2f3f5" : "#0d0e10";
  if (typeof _syncTileTheme === "function" && typeof L !== "undefined") _syncTileTheme();
}
function initTheme() {
  const saved = localStorage.getItem(THEME_KEY);
  const system = matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
  applyTheme(saved || system);
}
// theme-btn is now the "Light" seg button in Settings; toggling handled there

// ── Auth ──────────────────────────────────────────────────
// `username` is the login handle ([A-Za-z0-9_] only, so "Jayden Ng" becomes
// "JaydenNg"); `displayName` is the real name from the provider, which is what
// we greet people by. Falls back to the handle for password accounts.
function setAuth(token, username, displayName) {
  S.token = token; S.username = username;
  S.displayName = displayName || null;
  localStorage.setItem(TOKEN_KEY, token);
  localStorage.setItem(USER_KEY, username);
  if (displayName) localStorage.setItem(DISPLAY_KEY, displayName);
  else localStorage.removeItem(DISPLAY_KEY);
  syncAccountUI();
}
function displayName() { return S.displayName || S.username || ""; }
function clearAuth() {
  S.token = null; S.username = null; S.displayName = null;
  localStorage.removeItem(TOKEN_KEY);
  localStorage.removeItem(USER_KEY);
  localStorage.removeItem(DISPLAY_KEY);
  S.favs = [];
  S.savedJourneys = [];
  CP.saved = [];
  _cpRenderSaved();
  MRT.saved = [];
  _mrtRenderSaved();
  syncAccountUI();
  afterFavsChanged();
  afterJourneysChanged();
}
function isAdmin() { return S.token && S.username === "admin"; }

function syncAccountUI() {
  const loggedIn = !!S.token;
  const admin = isAdmin();
  $("account-dot")?.classList.toggle("hidden", !loggedIn);
  $("auth-forms").classList.toggle("hidden", loggedIn);
  $("auth-profile").classList.toggle("hidden", !loggedIn);
  if (loggedIn) {
    const name = displayName();
    $("profile-name").textContent = name;
    $("profile-avatar").textContent = (name || "?")[0].toUpperCase();
  }
  $("saved-sync-note").textContent = loggedIn
    ? `Synced to ${displayName()}'s account · monitored 24/7 for sharper predictions`
    : "";
  $("nav-data-btn")?.classList.toggle("hidden", !admin);
  if (S.view === "data" && !admin) switchView("arrivals");
  _updateSettingsUI();
}

function _updateSettingsUI() {
  const loggedIn = !!S.token;
  const lbl = $("stg-account-label");
  if (lbl) lbl.textContent = loggedIn ? displayName() : "Sign in";
  const cur = document.documentElement.getAttribute("data-theme") || "dark";
  document.querySelectorAll(".theme-seg-btn").forEach((b) =>
    b.classList.toggle("active", b.dataset.themeOpt === cur));
  const ver = $("stg-version-val");
  if (ver) ver.textContent = APP_VERSION;
  _updateSettingsHomeUI();
}

// ── Home location ─────────────────────────────────────────────────────────────
const HOME_KEY = "sgbus_home";

function getHome() {
  try { return JSON.parse(localStorage.getItem(HOME_KEY)); } catch { return null; }
}
function saveHome(name, lat, lng) {
  localStorage.setItem(HOME_KEY, JSON.stringify({ name, lat, lng }));
  _updatePlanHomeChip();
  _updateSettingsHomeUI();
}
function clearHome() {
  localStorage.removeItem(HOME_KEY);
  _updatePlanHomeChip();
  _updateSettingsHomeUI();
}
function _updatePlanHomeChip() {
  const h = getHome();
  const homeChip    = $("plan-home-chip");
  const setHomeChip = $("plan-set-home-chip");
  const chips       = $("plan-chips");
  if (!chips) return;

  const showHome    = !!h;
  const showSetHome = !h && planState.fromLat !== null;

  if (showHome) $("plan-home-chip-name").textContent = h.name;
  homeChip?.classList.toggle("hidden", !showHome);
  setHomeChip?.classList.toggle("hidden", !showSetHome);
  chips.classList.toggle("hidden", !showHome && !showSetHome);
}
function _updateSettingsHomeUI() {
  const h = getHome();
  const nameEl = $("stg-home-name");
  const clearBtn = $("stg-home-clear-btn");
  if (nameEl) nameEl.textContent = h ? h.name : "Not set";
  if (clearBtn) clearBtn.classList.toggle("hidden", !h);
}

function setupHomeSearch() {
  const input = $("stg-home-input");
  const clear = $("stg-home-input-clear");
  const ac    = $("stg-home-ac");
  let tmr;

  input.addEventListener("input", () => {
    const v = input.value.trim();
    v ? show(clear) : hide(clear);
    clearTimeout(tmr);
    tmr = setTimeout(async () => {
      if (!v || v.length < 2) { ac.innerHTML = ""; return; }
      const [stops, places] = await Promise.all([
        api(`/api/stops/search?q=${encodeURIComponent(v)}&limit=4`).catch(() => localStopSearch(v, 4)),
        oneMapSearch(v),
      ]);
      const stopHtml = (stops.results || []).map((s) => `
        <div class="ac-item" data-lat="${s.latitude}" data-lng="${s.longitude}"
             data-name="${esc(s.description || s.bus_stop_code)}">
          <span class="ac-code">${esc(s.bus_stop_code)}</span>
          <div><div class="ac-name">${esc(s.description || "Bus stop")}</div>
          <div class="ac-road">${esc(s.road_name || "")}</div></div>
        </div>`).join("");
      const placeHtml = places.map((p) => `
        <div class="ac-item ac-place" data-lat="${p.lat}" data-lng="${p.lng}"
             data-name="${esc(p.name)}">
          <svg class="ac-place-icon" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M20 10c0 6-8 12-8 12s-8-6-8-12a8 8 0 0 1 16 0Z"/><circle cx="12" cy="10" r="3"/></svg>
          <div><div class="ac-name">${esc(p.name)}</div>
          <div class="ac-road">${esc(p.address)}</div></div>
        </div>`).join("");
      ac.innerHTML = stopHtml + placeHtml || `<div class="ac-empty">No results.</div>`;
    }, 250);
  });

  clear.addEventListener("click", () => {
    input.value = ""; hide(clear); ac.innerHTML = ""; input.focus();
  });

  ac.addEventListener("click", (e) => {
    const item = e.target.closest(".ac-item");
    if (!item) return;
    const name = item.dataset.name;
    const lat  = parseFloat(item.dataset.lat);
    const lng  = parseFloat(item.dataset.lng);
    if (!isNaN(lat) && !isNaN(lng)) saveHome(name, lat, lng);
    input.value = ""; hide(clear); ac.innerHTML = "";
    $("stg-home-edit").classList.add("hidden");
  });
}

$("plan-home-chip").addEventListener("click", () => {
  const h = getHome();
  if (!h) return;
  if (!planState.fromLat) setPlanLocation("from", null, h.name, h.lat, h.lng);
  else                    setPlanLocation("to",   null, h.name, h.lat, h.lng);
});

$("stg-home-row").addEventListener("click", () => {
  const edit = $("stg-home-edit");
  const nowHidden = edit.classList.toggle("hidden");
  $("stg-home-row").classList.toggle("open", !nowHidden);
  if (!nowHidden) setTimeout(() => $("stg-home-input").focus(), 50);
  else $("stg-home-ac").innerHTML = "";
});

$("stg-home-clear-btn").addEventListener("click", () => {
  showConfirm("Remove your saved home location?", "Remove", () => {
    clearHome();
    $("stg-home-edit").classList.add("hidden");
    $("stg-home-row").classList.remove("open");
  });
});

function openSheet() {
  show($("sheet-backdrop")); show($("account-sheet"));
  hide($("auth-error"));
  if (!S.token) { ensureGoogleSignIn(); return; }
  api("/api/auth/me")
    .then((me) => {
      // Backfills the display name for sessions that predate it (or if the
      // Google profile was renamed since login).
      if (me.display_name && me.display_name !== S.displayName) {
        S.displayName = me.display_name;
        localStorage.setItem(DISPLAY_KEY, me.display_name);
        syncAccountUI();
      }
      const since = new Date(me.created_at + "Z").toLocaleDateString("en-SG",
        { day: "numeric", month: "short", year: "numeric" });
      const via = me.auth_provider === "google" ? " · Google account" : "";
      $("profile-meta").textContent =
        `${me.favourite_count} stops · ${me.journey_count} routes · joined ${since}${via}`;
      // Google accounts have no password to change.
      document.querySelector(".pw-change")
        ?.classList.toggle("hidden", me.auth_provider === "google");
    })
    .catch(() => {});
  loadNotifications();
}
function closeSheet() {
  hide($("sheet-backdrop")); hide($("account-sheet"));
  hide($("name-edit-form"));   // don't leave the name editor open for next time
}

$("account-btn").addEventListener("click", openSheet);   // hidden stub
$("sheet-backdrop").addEventListener("click", closeSheet);
$("stg-account-row").addEventListener("click", openSheet);
document.querySelectorAll(".theme-seg-btn").forEach((b) => {
  b.addEventListener("click", () => {
    applyTheme(b.dataset.themeOpt);
    if (S.stats) renderCharts(S.stats);
    _swapArrTiles();
    _updateSettingsUI();
  });
});

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

// Shared post-login flow: store the token, pull the account's favourites /
// journeys (server is source of truth), refresh the UI and close the sheet.
async function completeLogin(res, welcomeMsg) {
  setAuth(res.token, res.username, res.display_name);
  _cpLoadSaved(); _mrtLoadSaved();
  try {
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
  loadNotifications();   // switch from guest read-state to the account's
  closeSheet();
  if (welcomeMsg) toast(welcomeMsg);
}

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
    await completeLogin(res, S.authMode === "login" ? `Welcome back, ${res.display_name || res.username}` : "Account created");
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

// ── Google sign-in (Google Identity Services) ──────────────
let _gsiInited = false;
function _googleReady() { return !!(window.google && google.accounts && google.accounts.id); }

function ensureGoogleSignIn() {
  if (!GOOGLE_CLIENT_ID) return;            // not configured → no button
  if (!_googleReady()) { setTimeout(ensureGoogleSignIn, 300); return; }
  show($("google-signin-wrap"));
  if (!_gsiInited) {
    google.accounts.id.initialize({
      client_id: GOOGLE_CLIENT_ID,
      callback: onGoogleCredential,
      use_fedcm_for_button: true,   // required so the button click reliably
      auto_select: false,           // returns a credential in modern browsers
    });
    _gsiInited = true;
  }
  renderGoogleButton();
}

function renderGoogleButton() {
  const el = $("google-signin-btn");
  if (!el || !_googleReady()) return;
  el.innerHTML = "";
  const w = Math.min(400, Math.max(260, el.offsetWidth || 340));
  google.accounts.id.renderButton(el, {
    type: "standard", theme: _isDark() ? "filled_black" : "outline",
    size: "large", text: "continue_with", shape: "rectangular",
    logo_alignment: "left", width: w,
  });
}

async function onGoogleCredential(response) {
  if (!response || !response.credential) {
    toast("Google didn't complete sign-in. Please try again.");
    return;
  }
  try {
    const res = await api("/api/auth/google", {
      method: "POST",
      body: JSON.stringify({ credential: response.credential }),
    });
    await completeLogin(res, `Welcome, ${res.display_name || res.username}`);
  } catch (err) {
    console.error("Google sign-in failed:", err);
    const msg = err.message.startsWith("HTTP") || err.message.includes("fetch")
      ? "Google sign-in unavailable right now." : err.message;
    const el = $("auth-error");
    if (el) { el.textContent = msg; show(el); }
    toast(msg);   // surface loudly — the inline error sits inside the form
  }
}

$("logout-btn").addEventListener("click", async () => {
  try { await api("/api/auth/logout", { method: "POST" }); } catch {}
  clearAuth();
  closeSheet();
  loadNotifications();   // keep the bell — guests see notifications too
  toast("Logged out");
});

// ── Notifications ──────────────────────────────────────────────────────────────

const _notifBell  = $("notif-bell-btn");
const _notifPanel = $("notif-panel");

function _openNotifPanel()  { show(_notifPanel); }
function _closeNotifPanel() { hide(_notifPanel); }

_notifBell?.addEventListener("click", (e) => {
  e.stopPropagation();
  if (_notifPanel.classList.contains("hidden")) _openNotifPanel();
  else _closeNotifPanel();
});
$("notif-panel-close")?.addEventListener("click", _closeNotifPanel);
document.addEventListener("click", (e) => {
  if (!_notifPanel?.classList.contains("hidden") &&
      !_notifPanel.contains(e.target) && e.target !== _notifBell) {
    _closeNotifPanel();
  }
});

// Guests have no server-side read state, so we remember the highest notification
// id they've dismissed locally and compute read/unread from it.
const GUEST_NOTIF_SEEN_KEY = "sgbus_notif_seen_id";
let _lastNotifMaxId = 0;

let _lastNotifFetch = 0;
async function loadNotifications() {
  _lastNotifFetch = Date.now();
  try {
    const data = await api("/api/notifications");
    let items = data.items || [];
    let unread = data.unread || 0;
    _lastNotifMaxId = items.length ? Math.max(...items.map((n) => Number(n.id))) : 0;

    // Guests: derive read/unread from the locally-stored "seen" id.
    if (!S.token) {
      const seenId = parseInt(localStorage.getItem(GUEST_NOTIF_SEEN_KEY) || "0", 10);
      items = items.map((n) => ({ ...n, read: Number(n.id) <= seenId }));
      unread = items.filter((n) => !n.read).length;
    }

    const badge = $("notif-bell-badge");
    const markBtn = $("notif-panel-mark-read");

    show(_notifBell);
    if (badge) { badge.textContent = unread; badge.classList.toggle("hidden", unread === 0); }
    if (markBtn) markBtn.classList.toggle("hidden", unread === 0);

    const list = $("notif-panel-list");
    if (!list) return;
    const fmtDate = (iso) => new Date(iso + "Z").toLocaleString("en-SG", {
      day: "numeric", month: "short", year: "numeric",
      hour: "2-digit", minute: "2-digit", hour12: false, timeZone: "Asia/Singapore",
    });
    const levelIcon = { info: "ℹ️", update: "🆕", warning: "⚠️" };
    list.innerHTML = items.length
      ? items.map((n) => `
          <div class="notif-item${n.read ? " notif-read" : ""}">
            <div class="notif-item-head">
              <span class="notif-level-icon">${levelIcon[n.level] || "ℹ️"}</span>
              <span class="notif-title">${esc(n.title)}</span>
              ${!n.read ? `<span class="notif-dot-new"></span>` : ""}
            </div>
            ${n.body ? `<div class="notif-body">${esc(_notifParts(n.body).text)}</div>` : ""}
            <div class="notif-time">${esc(fmtDate(n.created_at))}</div>
          </div>`).join("")
      : `<p class="notif-empty">No notifications yet.</p>`;

    maybeShowNotifPopup(items);
  } catch { hide(_notifBell); }
  maybeShowFeedbackPopup();
}

// ── New-notification popup ────────────────────────────────
// When the admin sends a notification, surface the newest unread one in a popup
// the next time the user opens the app. De-duped via the highest id we've shown,
// so each notification pops at most once. The bell still lists everything.
const NOTIF_POPUP_KEY   = "sgbus_notif_popup_id";   // highest id auto-popped
const NOTIF_PROMOTE_KEY = "sgbus_notif_promote_ts"; // last admin-promoted popup_at shown
let _notifPopupAttempted = false;                   // only attempt once per session

// A notification body may end with "[img:whats-new/<file>]" to attach a
// screenshot shipped with the app. Only files under whats-new/ are allowed.
function _notifParts(body) {
  const m = (body || "").match(/\n?\[img:(whats-new\/[\w.-]+\.(?:png|jpe?g|webp))\]\s*$/);
  return m ? { text: body.slice(0, m.index).trim(), img: m[1] } : { text: body || "", img: null };
}

// iOS home-screen apps are usually resumed, not relaunched, so a startup-only
// check would never see notifications posted while the app sat in the
// background. Re-check on return to the foreground; the id watermark still
// keeps each popup to once.
document.addEventListener("visibilitychange", () => {
  if (document.hidden || Date.now() - _lastNotifFetch < 60_000) return;
  _notifPopupAttempted = false;
  _fbPopupAttempted = false;
  loadNotifications();
});

function maybeShowNotifPopup(items) {
  if (_notifPopupAttempted) return;                 // app-open only, not on every reload
  if (!items || !items.length) return;
  const el = $("notif-popup");
  const guide = $("a2hs-guide");
  if (!el || !el.classList.contains("hidden")) return;        // already open
  if (guide && !guide.classList.contains("hidden")) return;   // don't stack on the install guide
  _notifPopupAttempted = true;

  // 1) Admin-promoted popup wins: the notification with the newest popup_at,
  //    shown once per promotion even if already read.
  const promoted = items
    .filter((n) => n.popup_at)
    .sort((a, b) => new Date(b.popup_at + "Z") - new Date(a.popup_at + "Z"))[0];
  if (promoted) {
    const ts = new Date(promoted.popup_at + "Z").getTime();
    const lastTs = parseInt(localStorage.getItem(NOTIF_PROMOTE_KEY) || "0", 10);
    if (ts > lastTs) { _renderNotifPopup([promoted], null, ts); return; }
  }

  // 2) Otherwise the newest unread notification not yet auto-popped (by id).
  const lastShown = parseInt(localStorage.getItem(NOTIF_POPUP_KEY) || "0", 10);
  const fresh = items.filter((n) => !n.read && Number(n.id) > lastShown);
  if (!fresh.length) return;
  fresh.sort((a, b) => Number(b.id) - Number(a.id));
  const maxId = Math.max(...items.map((n) => Number(n.id)));
  _renderNotifPopup(fresh, maxId, null);
}

function _renderNotifPopup(fresh, maxId, promoteTs) {
  const el = $("notif-popup");
  const n  = fresh[0];
  const levelIcon = { info: "ℹ️", update: "🆕", warning: "⚠️" };
  $("notif-popup-icon").textContent  = levelIcon[n.level] || "ℹ️";
  $("notif-popup-title").textContent = n.title;
  const parts = _notifParts(n.body);
  const bodyEl = $("notif-popup-body");
  bodyEl.textContent = parts.text;
  bodyEl.classList.toggle("hidden", !parts.text);
  bodyEl.classList.toggle("long", parts.text.includes("\n"));
  const imgEl = $("notif-popup-img");
  if (parts.img) { imgEl.src = parts.img; show(imgEl); } else { imgEl.removeAttribute("src"); hide(imgEl); }
  $("notif-popup-icon").classList.toggle("hidden", !!parts.img);
  $("notif-popup-time").textContent = new Date(n.created_at + "Z").toLocaleString("en-SG", {
    day: "numeric", month: "short", hour: "2-digit", minute: "2-digit",
    hour12: false, timeZone: "Asia/Singapore",
  });
  // Only the newest notice pops; older ones stay in the bell list.
  $("notif-popup-more").classList.add("hidden");
  // The watermark is saved on dismiss, not on show: a popup that rendered while
  // the app was still waking in the background (never actually seen) must come
  // back next time. Auto-popups advance the id watermark; promoted popups the
  // promo timestamp (leaving the id watermark so genuinely-new notices pop).
  _pendingPopupSeen = { maxId, promoteTs, noticeId: Number(n.id) };
  show(el);
  requestAnimationFrame(() => {
    el.classList.add("show");
    // Move focus into the dialog so keyboard/screen-reader users land on it
    // (aria-modal alone doesn't move focus).
    $("notif-popup-ok")?.focus({ preventScroll: true });
    el.querySelector(".notif-popup-card").scrollTop = 0;  // long notes: start at the top
  });
}

let _pendingPopupSeen = null;
function dismissNotifPopup() {
  const el = $("notif-popup");
  if (!el) return;
  if (_pendingPopupSeen) {
    const { maxId, promoteTs, noticeId } = _pendingPopupSeen;
    try {
      if (maxId) localStorage.setItem(NOTIF_POPUP_KEY, String(maxId));
      if (promoteTs) localStorage.setItem(NOTIF_PROMOTE_KEY, String(promoteTs));
    } catch {}
    _pendingPopupSeen = null;
    _markNoticeRead(noticeId);
  }
  el.classList.remove("show");
  setTimeout(() => { hide(el); maybeShowFeedbackPopup(); }, 280);
}

$("notif-popup-ok")?.addEventListener("click", dismissNotifPopup);
$("notif-popup")?.querySelector(".notif-popup-backdrop")?.addEventListener("click", dismissNotifPopup);

// ── New-feedback popup (admin only) ──────────────────────
// When users have sent feedback the admin hasn't seen, pop it up on app open
// (and on return to the foreground, via loadNotifications). The highest
// feedback id seen is saved on dismiss, so each entry pops once per device.
// A device that has never checked only pops the last 7 days, not the backlog.
const FB_POPUP_KEY = "sgbus_fb_popup_id";
let _fbPopupAttempted = false;
let _fbPendingMaxId = 0;

async function maybeShowFeedbackPopup() {
  if (!isAdmin() || _fbPopupAttempted) return;
  const el = $("fb-popup");
  if (!el || !el.classList.contains("hidden")) return;
  // One dialog at a time: wait for the notification popup / install guide;
  // dismissNotifPopup() calls back in here once it closes.
  if (_isOpen("notif-popup") || _isOpen("a2hs-guide")) return;
  _fbPopupAttempted = true;
  let items;
  try { items = (await api("/api/feedback?limit=50")).items || []; } catch { return; }
  let seen = null;
  try { seen = localStorage.getItem(FB_POPUP_KEY); } catch {}
  const weekAgo = Date.now() - 7 * 864e5;
  const fresh = items.filter((f) => seen !== null
    ? Number(f.id) > parseInt(seen, 10)
    : new Date(f.submitted_at + "Z").getTime() > weekAgo);
  if (!fresh.length || !isAdmin() || _isOpen("notif-popup")) return;

  const fmt = (iso) => new Date(iso + "Z").toLocaleString("en-SG", {
    day: "numeric", month: "short", hour: "2-digit", minute: "2-digit",
    hour12: false, timeZone: "Asia/Singapore",
  });
  const stars = (n) => n
    ? `<span class="fb-admin-stars">${"★".repeat(n)}<span class="fb-admin-empty-stars">${"★".repeat(5 - n)}</span></span>`
    : "";
  const shown = fresh.slice(0, 3);
  $("fb-popup-title").textContent = fresh.length === 1 ? "New feedback" : `${fresh.length} new feedback`;
  $("fb-popup-list").innerHTML = shown.map((f) => `
    <div class="fb-popup-item">
      <div class="fb-popup-head">
        ${f.username ? `<strong>${esc(f.username)}</strong>` : `<span>Anonymous</span>`}
        ${stars(f.rating)}
        <span>· ${esc(fmt(f.submitted_at))}</span>
      </div>
      ${f.message ? `<div class="fb-popup-msg">${esc(f.message)}</div>` : ""}
    </div>`).join("");
  const more = $("fb-popup-more");
  more.textContent = fresh.length > shown.length ? `+${fresh.length - shown.length} more` : "";
  more.classList.toggle("hidden", fresh.length <= shown.length);
  _fbPendingMaxId = Math.max(...items.map((f) => Number(f.id)));
  show(el);
  requestAnimationFrame(() => {
    el.classList.add("show");
    $("fb-popup-view")?.focus({ preventScroll: true });
    el.querySelector(".notif-popup-card").scrollTop = 0;
  });
}

function dismissFeedbackPopup() {
  const el = $("fb-popup");
  if (!el) return;
  if (_fbPendingMaxId) {
    try { localStorage.setItem(FB_POPUP_KEY, String(_fbPendingMaxId)); } catch {}
    _fbPendingMaxId = 0;
  }
  el.classList.remove("show");
  setTimeout(() => hide(el), 280);
}

$("fb-popup-later")?.addEventListener("click", dismissFeedbackPopup);
$("fb-popup")?.querySelector(".notif-popup-backdrop")?.addEventListener("click", dismissFeedbackPopup);
$("fb-popup-view")?.addEventListener("click", () => {
  dismissFeedbackPopup();
  switchView("data");
  // the Data tab renders the feedback block asynchronously; scroll once it shows
  const t0 = Date.now();
  const scrollWhenReady = () => {
    const block = $("feedback-admin-block");
    if (block && !block.classList.contains("hidden")) block.scrollIntoView({ behavior: "smooth", block: "start" });
    else if (Date.now() - t0 < 8000) setTimeout(scrollWhenReady, 200);
  };
  scrollWhenReady();
});

// Escape closes the topmost open overlay — none of the dialogs handled the
// keyboard at all, leaving keyboard users stuck behind aria-modal surfaces.
const _isOpen = (id) => { const el = $(id); return el && !el.classList.contains("hidden"); };
document.addEventListener("keydown", (e) => {
  if (e.key !== "Escape") return;
  if (_isOpen("notif-popup"))        { dismissNotifPopup(); }
  else if (_isOpen("fb-popup"))      { dismissFeedbackPopup(); }
  else if (_isOpen("a2hs-guide"))    { dismissInstallGuide(); }
  else if (_isOpen("feedback-overlay")) { $("feedback-close")?.click(); }
  else if (_isOpen("stop-picker-modal")) { closeStopPicker(); }
  else if (_isOpen("mim-sheet"))     { closeMim(); }
  else if (_isOpen("route-sheet"))   { closeRouteSheet(); }
  else if (_isOpen("account-sheet")) { closeSheet(); }
  else return;
  e.preventDefault();
});

// Dismissing the popup ("Got it") marks that notice read, so the bell's red
// dot clears. Read state is "everything up to …": guests store the highest
// id read on the phone; accounts mark read on the server, which covers every
// notice so far — so that's only done when the popup was the newest one
// (an admin re-sending an older notice mustn't clear a newer unread one).
async function _markNoticeRead(id) {
  if (!id) return;
  try {
    if (!S.token) {
      const seen = parseInt(localStorage.getItem(GUEST_NOTIF_SEEN_KEY) || "0", 10);
      if (id > seen) localStorage.setItem(GUEST_NOTIF_SEEN_KEY, String(id));
    } else if (id >= _lastNotifMaxId) {
      await api("/api/notifications/mark-read", { method: "POST" });
    } else return;
    await loadNotifications();
  } catch { /* the bell catches up on the next refresh */ }
}

$("notif-panel-mark-read")?.addEventListener("click", async () => {
  // Guests have no account to store read state on — mark read locally.
  if (!S.token) {
    localStorage.setItem(GUEST_NOTIF_SEEN_KEY, String(_lastNotifMaxId));
    await loadNotifications();
    return;
  }
  try {
    await api("/api/notifications/mark-read", { method: "POST" });
    await loadNotifications();
  } catch (e) { toast("Could not mark read: " + e.message); }
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
  _cpLoadSaved(); _mrtLoadSaved();
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
  // No count badge on the Saved tab: a red numeric pill on a nav item reads as
  // "unread notifications", not "saved stops".
  renderChips();
  syncSaveBtn();
  if (S.view === "saved") renderSaved();
}

function syncSaveBtn() {
  if (!S.stop) return;
  const saved = isFav(S.stop);
  $("save-btn").classList.toggle("saved", saved);
  $("save-btn").setAttribute("aria-pressed", saved);
  $("save-btn").setAttribute("aria-label", saved ? "Saved — tap to remove" : "Save this stop");
  $("save-label").textContent = saved ? "Saved" : "Save";
}

$("save-btn").addEventListener("click", () => {
  if (!S.stop) return;
  if (!S.token) { toast("Log in to save stops"); openSheet(); return; }
  if (isFav(S.stop)) {
    showConfirm("Remove this stop from saved?", "Remove", () => {
      removeFav(S.stop); syncSaveBtn(); toast("Removed from saved stops");
    });
  } else {
    addFav(S.stop, S.stopInfo || {});
    syncSaveBtn();
    toast("Saved — now monitored for better predictions");
  }
});

// ── Recents ───────────────────────────────────────────────
function pushRecent(code, info) {
  S.recent = [{ code, description: info?.description || null },
    ...S.recent.filter((r) => r.code !== code)].slice(0, 5);
  writeJSON(RECENT_KEY, S.recent);
}

// ── Chips (saved > recent > popular) ──────────────────────
function removeRecent(code) {
  S.recent = S.recent.filter((r) => r.code !== code);
  writeJSON(RECENT_KEY, S.recent);
  renderChips();
}

function renderChips() {
  const area = $("chips-area");
  const groups = [];
  if (S.favs.length) groups.push(["Saved", S.favs.slice(0, 8), false]);
  if (S.recent.length) groups.push(["Recent", S.recent.filter((r) => !isFav(r.code)).slice(0, 4), true]);
  if (!S.favs.length && !S.recent.length) groups.push(["Popular", POPULAR, false]);
  area.innerHTML = groups
    .filter(([, items]) => items.length)
    .map(([label, items, deletable]) => `
      <div class="chips-group">
      <div class="chips-label">${label}</div>
      <div class="chips-row">${items.map((f) => `
        <div class="chip-wrap">
          <button class="chip" data-code="${esc(f.code)}">
            <span class="chip-code">${esc(f.code)}</span>
            ${f.description ? `<span class="chip-name">${esc(f.description)}</span>` : ""}
          </button>
          ${deletable ? `<button class="chip-del" data-del="${esc(f.code)}" aria-label="Remove">×</button>` : ""}
        </div>`).join("")}
      </div>
      </div>`).join("");
}
$("chips-area").addEventListener("click", (e) => {
  const del = e.target.closest(".chip-del");
  if (del) { removeRecent(del.dataset.del); return; }
  const chip = e.target.closest(".chip");
  if (chip) loadStop(chip.dataset.code);
});

// ── Views / bottom nav ────────────────────────────────────
const MAP_MODE_KEY = "sgbus_map_mode";
const _MM_SVG = (d) => `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${d}</svg>`;
const MAP_MODES = [
  ["arrivals", "Bus", _MM_SVG('<path d="M4 6a2 2 0 0 1 2-2h12a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2z"/><path d="M4 11h16M6 19v2M18 19v2"/>')],
  ["mrt", "MRT", _MM_SVG('<rect x="5" y="3" width="14" height="14" rx="3"/><path d="M5 11h14m-11 10 2-4m6 4-2-4"/>')],
  ["carpark", "Parking", _MM_SVG('<rect x="3" y="3" width="18" height="18" rx="4"/><path d="M9.5 17V7h3.25a3 3 0 0 1 0 6H9.5"/>')],
];
function _isMapView(n) { return n === "arrivals" || n === "mrt" || n === "carpark"; }

function switchView(name) {
  if (name === "data" && !isAdmin()) name = "arrivals";
  if (name === "plan" && !PLAN_ENABLED) name = "arrivals";
  // The Map tab holds three modes (Bus / MRT / Parking), each its own view;
  // the tab reopens whichever mode was used last.
  if (name === "map") {
    let last = null;
    try { last = localStorage.getItem(MAP_MODE_KEY); } catch {}
    name = _isMapView(last) ? last : "arrivals";
  }
  S.view = name;
  const mapMode = _isMapView(name);
  if (mapMode) { try { localStorage.setItem(MAP_MODE_KEY, name); } catch {} }
  document.querySelectorAll(".nav-item").forEach((b) =>
    b.classList.toggle("active", b.dataset.view === name || (mapMode && b.dataset.view === "map")));
  document.querySelectorAll(".map-mode").forEach((b) => {
    const on = b.dataset.mode === name;
    b.classList.toggle("active", on);
    b.setAttribute("aria-selected", on ? "true" : "false");
  });
  document.querySelectorAll(".view").forEach((v) =>
    v.classList.toggle("active", v.id === `view-${name}`));
  if (name === "saved") { renderSaved(); _cpLoadSaved(); _mrtLoadSaved(); }
  if (name === "data") loadData();
  if (name === "arrivals") { setTimeout(() => _arrMap?.invalidateSize(), 60); if (!S.stop && window.LiveBuses?._state.mode !== "nearby") setTimeout(_liveNearby, 0); }
  if (name === "settings") _updateSettingsUI();
  if (name === "checkpoint") loadCheckpoint();
  if (name === "carpark") { _cpInit(); _cpLoadSaved(); }
  if (name === "mrt") { _mrtInit(); _mrtLoadSaved(); }
}
document.querySelectorAll(".nav-item").forEach((b) =>
  b.addEventListener("click", () => switchView(b.dataset.view)));
// Mode switch under each map view's search bar.
document.querySelectorAll("#view-arrivals, #view-mrt, #view-carpark").forEach((view) => {
  const wrap = view.querySelector(".arr-search-wrap");
  if (!wrap) return;
  const bar = document.createElement("div");
  bar.className = "map-modes";
  bar.setAttribute("role", "tablist");
  bar.setAttribute("aria-label", "Map mode");
  bar.innerHTML = MAP_MODES.map(([mode, label, icon]) =>
    `<button type="button" role="tab" class="map-mode${view.id === "view-" + mode ? " active" : ""}" data-mode="${mode}"
       aria-selected="${view.id === "view-" + mode}">${icon}<span>${label}</span></button>`).join("");
  bar.addEventListener("click", (e) => {
    const b = e.target.closest(".map-mode");
    if (b && b.dataset.mode !== S.view) switchView(b.dataset.mode);
  });
  wrap.appendChild(bar);
});
if (!PLAN_ENABLED) {
  // Hidden, not removed — the planner code still wires listeners to these.
  document.querySelector('.nav-item[data-view="plan"]')?.classList.add("hidden");
  document.querySelectorAll(".saved-routes").forEach((el) => el.classList.add("hidden"));
}

// ── Checkpoint view ───────────────────────────────────────
const CP_CAM_LABELS = {
  "2702": "Woodlands Checkpoint",
  "2701": "Woodlands Causeway",
  "2704": "Woodlands Road",
  "4713": "Tuas Second Link",
  "4703": "Tuas Checkpoint",
  "4712": "Tuas Approach Road",
};

// Split Woodlands cameras by direction (all SG-side — no JB feeds available)
// 2704: approach road from SG city heading to checkpoint (outbound queue)
// 2702: at the checkpoint gates (both directions)
// 2701: at the causeway / returning from JB (inbound queue)
const CP_CAM_DIRS = {
  "woodlands": [
    { label: "Towards JB",    ids: ["2702", "2704"] },
    { label: "Into Singapore", ids: ["2701"] },
  ],
};

// Bus timing config for Woodlands checkpoint
// services: only cross-border routes that go to Woodlands Causeway
const CP_BUS_STOPS = [
  { id: "kranji",    label: "From Kranji",        stop: "45139", services: ["160", "170"] },
  { id: "marsiling", label: "From Marsiling",     stop: "47009", services: ["950", "950A"] },
  { id: "wdlint",    label: "From Woodlands Int", stop: "46211", services: ["950", "950A", "170X"] },
];

let _cpData = null;
let _cpTab  = "woodlands";
let _cpRefreshTmr = null;

function _waitText(bus) {
  const min = parseInt(bus.api_wait_min, 10);
  if (isNaN(min)) return bus.api_wait_min || "–";
  if (min <= 1) return "Arr";
  return `${min} min`;
}

function loadCpBus() {
  for (const cfg of CP_BUS_STOPS) {
    const preEl  = $(`cp-bus-pre-${cfg.id}`);
    const bodyEl = $(`cp-bus-body-${cfg.id}`);
    if (!preEl || !bodyEl) continue;
    preEl.textContent = "Loading…";
    bodyEl.innerHTML  = "";
    api(`/api/arrivals/${cfg.stop}`)
      .then((data) => {
        const svcs = (data.services || []).filter(s => cfg.services.includes(s.service_no));
        if (!svcs.length) {
          preEl.textContent = "No service";
          bodyEl.innerHTML  = `<p class="cp-bus-empty">No cross-checkpoint buses at this stop right now.</p>`;
          return;
        }
        // Preview: first service + first arrival
        const firstBus = svcs[0].buses?.[0];
        preEl.textContent = firstBus
          ? `${svcs[0].service_no} · ${_waitText(firstBus)}`
          : svcs[0].service_no;
        // Body: one row per service
        bodyEl.innerHTML = svcs.map((s) => {
          const pills = (s.buses || []).slice(0, 3).map((b) => {
            const t = _waitText(b);
            return `<span class="cp-bus-pill${t === "Arr" ? " due" : ""}">${esc(t)}</span>`;
          }).join("");
          return `<div class="cp-bus-row">
            <button class="cp-bus-badge" data-service="${esc(s.service_no)}">${esc(s.service_no)}</button>
            <div class="cp-bus-times">${pills || "<span class=\"cp-bus-empty\">No data</span>"}</div>
          </div>`;
        }).join("");
      })
      .catch(() => {
        preEl.textContent = "–";
        bodyEl.innerHTML  = `<p class="cp-bus-empty">Could not load timings.</p>`;
      });
  }
}

function loadCheckpoint(force = false) {
  if (_cpData && !force) { _renderCheckpoint(_cpData); return; }
  show($("cp-loading")); hide($("cp-error"));
  api("/api/checkpoint/traffic")
    .then((data) => {
      _cpData = data;
      hide($("cp-loading"));
      _renderCheckpoint(data);
      loadCpBus();
      clearTimeout(_cpRefreshTmr);
      // No manual refresh: the cameras only change when LTA publishes a new
      // photo (every few minutes), so the page just re-checks every minute.
      _cpRefreshTmr = setTimeout(() => {
        _cpData = null;
        if (S.view === "checkpoint") loadCheckpoint();
      }, 60_000);
    })
    .catch((e) => {
      hide($("cp-loading"));
      const el = $("cp-error");
      el.textContent = `Could not load checkpoint data: ${e.message}`;
      show(el);
    });
}

function _renderCheckpoint(data) {
  if (data.fetched_at) {
    const t = new Date(data.fetched_at + "Z");
    $("cp-updated").textContent = `Checked ${fmtClock(t)} · updates automatically`;
  }
  _renderCarpark(data.carpark);
  _renderCpPanel("woodlands", data.woodlands);
  _renderCpPanel("tuas",      data.tuas);
}

function _renderCarpark(cp) {
  const el = $("cp-carpark");
  if (!el) return;
  if (!cp) { hide(el); return; }
  const pct    = cp.total > 0 ? Math.round((cp.available / cp.total) * 100) : 0;
  // green = lots free (>25%), orange = getting full (10-25%), red = almost full (<10%)
  const status = pct > 25 ? "good" : pct > 10 ? "warn" : "bad";
  const t      = cp.updated_at ? fmtClock(new Date(cp.updated_at.replace(" ", "T"))) : "";
  el.innerHTML = `
    <div class="cp-cp-row">
      <div class="cp-cp-info">
        <div class="cp-cp-name">Blk 29A Marsiling MSCP</div>
        <div class="cp-cp-time">Drive here · take bus to checkpoint${t ? ` · Updated ${esc(t)}` : ""}</div>
      </div>
      <div class="cp-cp-right">
        <div class="cp-cp-lots">
          <span class="cp-cp-avail ${status}">${cp.available}</span>
          <span class="cp-cp-sep">/ ${cp.total}</span>
        </div>
      </div>
    </div>
    <div class="cp-cp-bar-track">
      <div class="cp-cp-bar-fill ${status}" style="width:${pct}%"></div>
    </div>`;
  show(el);
}

// "Photo taken 23:25 · 3 min ago" from LTA's per-camera timestamp.
function _camTaken(iso) {
  if (!iso) return "";
  const t = new Date(iso);
  if (isNaN(t)) return "";
  const ago = Math.max(0, Math.round((Date.now() - t) / 60000));
  return `Photo taken ${fmtClock(t)} · ${ago < 1 ? "just now" : `${ago} min ago`}`;
}

function _renderCamGrid(camEl, cameras) {
  if (!cameras.length) {
    camEl.innerHTML = `<p class="empty" style="font-size:.82rem;padding:.5rem 0">No camera feeds found.</p>`;
    return;
  }
  // Each LTA photo has its own URL, so no cache-buster is needed: a new
  // photo arrives as a new URL, and an unchanged one comes from cache.
  camEl.innerHTML = cameras.map((c) => `
    <div class="cp-camera-card">
      <img class="cp-camera-img" src="${esc(c.url)}" alt="Traffic camera" loading="lazy" />
      <div class="cp-camera-label">${esc(CP_CAM_LABELS[c.id] || `Camera ${c.id}`)}</div>
    </div>`).join("");
  const newest = cameras.map((c) => c.taken_at).filter(Boolean).sort().pop();
  const fallback = _cpData?.fetched_at ? `Checked ${fmtClock(new Date(_cpData.fetched_at + "Z"))}` : "";
  const line = _camTaken(newest) || fallback;
  if (line) camEl.insertAdjacentHTML("beforeend", `<p class="cp-cam-taken">${esc(line)}</p>`);
}

function _renderCpPanel(key, cp) {
  if (!cp) return;
  const camEl = $(`cp-cameras-${key}`);
  if (!camEl) return;

  const dirs = CP_CAM_DIRS[key];
  if (dirs && cp.cameras && cp.cameras.length) {
    // Build a direction-tab layout inside camEl
    const camMap = Object.fromEntries(cp.cameras.map((c) => [c.id, c]));
    let activeDir = 0;
    const tabsHtml = dirs.map((d, i) =>
      `<button class="cp-cam-dir-tab${i === 0 ? " active" : ""}" data-dir="${i}">${esc(d.label)}</button>`
    ).join("");

    camEl.innerHTML = `
      <div class="cp-cam-dir-tabs">${tabsHtml}</div>
      <div class="cp-cam-dir-note">SG-side cameras only</div>
      <div class="cp-cam-dir-body"></div>`;

    function showDir(idx) {
      activeDir = idx;
      camEl.querySelectorAll(".cp-cam-dir-tab").forEach((b, i) =>
        b.classList.toggle("active", i === idx));
      const body = camEl.querySelector(".cp-cam-dir-body");
      const cams = dirs[idx].ids.map((id) => camMap[id]).filter(Boolean);
      _renderCamGrid(body, cams);
    }
    // Property assignment (not addEventListener): this panel re-renders every
    // 120 s, and stacked listeners would each rebuild the grid per tap with
    // progressively stale cache-busters captured in their closures.
    camEl.onclick = (e) => {
      const btn = e.target.closest(".cp-cam-dir-tab");
      if (btn) showDir(parseInt(btn.dataset.dir));
    };
    showDir(0);
  } else if (cp.cameras && cp.cameras.length) {
    _renderCamGrid(camEl, cp.cameras);
  } else {
    camEl.innerHTML = `<p class="empty" style="font-size:.82rem;padding:.5rem 0">No camera feeds found for this checkpoint.</p>`;
  }
}

document.querySelectorAll(".cp-tab").forEach((btn) => {
  btn.addEventListener("click", () => {
    _cpTab = btn.dataset.cp;
    document.querySelectorAll(".cp-tab").forEach((b) => b.classList.toggle("active", b === btn));
    document.querySelectorAll(".cp-panel").forEach((p) =>
      p.classList.toggle("hidden", p.id !== `cp-panel-${_cpTab}`));
  });
});


// ── Bus route viewer ──────────────────────────────────────
function closeRouteSheet() {
  const sheet = $("route-sheet");
  sheet.classList.remove("open");
  setTimeout(() => { hide(sheet); hide($("route-sheet-backdrop")); }, 280);
}

async function loadBusRoute(serviceNo) {
  if (!serviceNo) return;
  switchView("arrivals");
  const sheet    = $("route-sheet");
  const backdrop = $("route-sheet-backdrop");
  const bodyEl   = $("route-sheet-body");
  const tabsEl   = $("route-sheet-tabs");
  $("route-sheet-badge").textContent = serviceNo;
  $("route-sheet-title").textContent = `Bus ${serviceNo}`;
  $("route-sheet-sub").textContent   = "";
  bodyEl.innerHTML = `<div class="route-sheet-loading">Loading route…</div>`;
  tabsEl.innerHTML = "";
  tabsEl.classList.add("hidden");
  // Remove any previous direction tab listener clone
  const freshTabs = tabsEl.cloneNode(false);
  tabsEl.replaceWith(freshTabs);
  const newTabsEl = $("route-sheet-tabs");
  show(backdrop); show(sheet);
  requestAnimationFrame(() => sheet.classList.add("open"));

  function renderDir(stops) {
    if (!stops.length) { bodyEl.innerHTML = `<p class="route-sheet-empty">No stops found.</p>`; return; }
    bodyEl.innerHTML = stops.map((stop, i) => {
      const isFirst = i === 0;
      const isLast  = i === stops.length - 1;
      const dist    = stop.distance_km != null ? `${stop.distance_km.toFixed(1)} km` : "";
      const arrowSvg = `<svg class="route-stop-arrow" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="m5 12 14 0"/><path d="m13 6 6 6-6 6"/></svg>`;
      return `
        <div class="route-stop-row">
          <div class="route-stop-line">
            <div class="route-stop-dot${isFirst ? " first" : isLast ? " last" : ""}"></div>
            ${!isLast ? `<div class="route-stop-seg"></div>` : ""}
          </div>
          <button class="route-stop-btn" data-code="${esc(stop.code)}">
            ${arrowSvg}
            <div class="route-stop-info">
              <span class="route-stop-name">${esc(stop.name || stop.code)}</span>
              <span class="route-stop-meta">${esc(stop.code)}${stop.road ? ` · ${esc(stop.road)}` : ""}</span>
            </div>
            ${dist ? `<span class="route-stop-dist">${esc(dist)}</span>` : ""}
          </button>
        </div>`;
    }).join("");
  }

  try {
    const data = await api(`/api/routes/${encodeURIComponent(serviceNo)}`);
    const { directions } = data;
    if (!directions.length) {
      bodyEl.innerHTML = `<p class="route-sheet-empty">No route data for Bus ${esc(serviceNo)}. Route data may not be synced on the server yet.</p>`;
      return;
    }
    const allStops = directions[0].stops;
    if (allStops.length >= 2) {
      const first = allStops[0].name || allStops[0].code;
      const last  = allStops[allStops.length - 1].name || allStops[allStops.length - 1].code;
      $("route-sheet-sub").textContent = `${allStops.length} stops · ${first} → ${last}`;
    }
    if (directions.length > 1) {
      newTabsEl.classList.remove("hidden");
      let activeIdx = 0;
      function setTab(idx) {
        activeIdx = idx;
        newTabsEl.querySelectorAll(".route-dir-tab").forEach((b, i) =>
          b.classList.toggle("active", i === idx));
        const stops = directions[idx].stops;
        renderDir(stops);
        if (stops.length >= 2) {
          const first = stops[0].name || stops[0].code;
          const last  = stops[stops.length - 1].name || stops[stops.length - 1].code;
          $("route-sheet-sub").textContent = `${stops.length} stops · ${first} → ${last}`;
        }
      }
      newTabsEl.innerHTML = directions.map((d, i) => {
        const dest = d.stops[d.stops.length - 1]?.name || `Dir ${d.direction}`;
        return `<button class="route-dir-tab${i === 0 ? " active" : ""}" data-idx="${i}">To ${esc(dest)}</button>`;
      }).join("");
      newTabsEl.addEventListener("click", (e) => {
        const btn = e.target.closest(".route-dir-tab");
        if (btn) setTab(parseInt(btn.dataset.idx));
      });
      renderDir(directions[0].stops);
    } else {
      renderDir(directions[0].stops);
    }
  } catch (e) {
    bodyEl.innerHTML = `<p class="route-sheet-empty">Route not available: ${esc(e.message)}</p>`;
  }
}

$("route-sheet-close").addEventListener("click", closeRouteSheet);
$("route-sheet-backdrop").addEventListener("click", closeRouteSheet);
$("route-sheet-body").addEventListener("click", (e) => {
  const btn = e.target.closest(".route-stop-btn");
  if (btn) { closeRouteSheet(); loadStop(btn.dataset.code); }
});

// Checkpoint bus badges delegate (badges are rendered dynamically)
document.getElementById("cp-panel-woodlands").addEventListener("click", (e) => {
  const badge = e.target.closest(".cp-bus-badge[data-service]");
  if (badge) loadBusRoute(badge.dataset.service);
});
document.getElementById("cp-panel-tuas").addEventListener("click", (e) => {
  const badge = e.target.closest(".cp-bus-badge[data-service]");
  if (badge) loadBusRoute(badge.dataset.service);
});

document.querySelectorAll(".cp-bus-stop-btn").forEach((btn) => {
  btn.addEventListener("click", (e) => {
    e.stopPropagation(); // don't toggle the <details>
    loadStop(btn.dataset.stop);
  });
});

// ── Search + autocomplete ─────────────────────────────────
const input = $("stop-input");

function hideAc() { hide($("autocomplete")); $("autocomplete").innerHTML = ""; }

async function runAc(q) {
  if (!q || q.length < 2) { hideAc(); return; }
  try {
    const isSvcNum = /^\d{1,3}[A-Z]?$/i.test(q.trim());
    const [stopsData, places] = await Promise.all([
      api(`/api/stops/search?q=${encodeURIComponent(q)}&limit=6`).catch(() => localStopSearch(q, 6)),
      q.length >= 3 ? oneMapSearch(q) : Promise.resolve([]),
    ]);
    const box = $("autocomplete");
    let html = "";

    if (isSvcNum) {
      const svc = q.trim().toUpperCase();
      html += `<div class="ac-item ac-route" data-svc="${esc(svc)}">
        <span class="ac-code ac-svc-badge">${esc(svc)}</span>
        <div>
          <div class="ac-name">Bus route ${esc(svc)}</div>
          <div class="ac-road">View all stops on this route</div>
        </div>
      </div>`;
    }

    const stopItems = stopsData.results || [];
    html += stopItems.map((s) => `
      <div class="ac-item" data-code="${esc(s.bus_stop_code)}">
        <span class="ac-code">${esc(s.bus_stop_code)}</span>
        <div>
          <div class="ac-name">${esc(s.description || "Bus stop")}</div>
          <div class="ac-road">${esc(s.road_name || "")}</div>
        </div>
      </div>`).join("");

    const filteredPlaces = places
      .filter((p) => !stopItems.some((s) => s.description === p.name))
      .slice(0, 4);
    if (filteredPlaces.length && (stopItems.length || isSvcNum)) html += `<div class="ac-divider"></div>`;
    html += filteredPlaces.map((p) => `
      <div class="ac-item ac-place" data-lat="${p.lat}" data-lng="${p.lng}" data-name="${esc(p.name)}">
        <svg class="ac-place-icon" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M20 10c0 6-8 12-8 12s-8-6-8-12a8 8 0 0 1 16 0Z"/><circle cx="12" cy="10" r="3"/></svg>
        <div>
          <div class="ac-name">${esc(p.name)}</div>
          <div class="ac-road">${esc(p.address)}</div>
        </div>
      </div>`).join("");

    box.innerHTML = html || `<div class="ac-empty">No results for "${esc(q)}".</div>`;
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
$("autocomplete").addEventListener("click", async (e) => {
  const item = e.target.closest(".ac-item");
  if (!item) return;
  input.value = ""; hide($("search-clear")); hideAc(); input.blur();
  if (item.dataset.svc) { loadBusRoute(item.dataset.svc); return; }
  if (item.dataset.lat) {
    try {
      const near = await api(`/api/stops/nearby?lat=${item.dataset.lat}&lng=${item.dataset.lng}&limit=1`)
        .catch(() => localNearby(parseFloat(item.dataset.lat), parseFloat(item.dataset.lng), 1));
      const s = (near.results || [])[0];
      if (s) loadStop(s.bus_stop_code); else toast("No nearby bus stops");
    } catch { toast("Couldn't find nearby stops"); }
    return;
  }
  if (item.dataset.code) loadStop(item.dataset.code);
});
document.addEventListener("click", (e) => {
  // .near-btn is a class (the locate/pick buttons beside the plan inputs) —
  // "#near-btn" matched nothing, making the guard always pass.
  if (!$("autocomplete").contains(e.target) && e.target !== input
      && !e.target.closest(".near-btn")) hideAc();
});

// (Stops-near-me lives on the arrivals map now — the map auto-geolocates and
//  the locate button re-centres; no separate search-bar button.)

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

// "then 4 · 10 min": a following bus that's also due reads "now", not "Arr".
function _laterMin(secs) { const t = fmtMin(secs); return t === "Arr" ? "now" : t; }

// Quiet AI note for the bus list: nothing when the AI agrees with LTA (most of
// the time), "AI: likely 7 min" when it doesn't.
function aiNote(aiSecs, adj) {
  if (aiSecs === null || Math.abs(adj) < 30) return "";
  return aiSecs < DUE_SECS ? "AI: likely arriving now" : `AI: likely ${fmtMin(aiSecs)} min`;
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
  const laterTxt = later.map((b) => _laterMin(secsUntil(parseUTC(b.api_arrival)))).join(" · ");
  const TYPE_LABEL = { DD: "Double-decker", BD: "Bendy" };
  // One quiet line: crowding (dot colour + word) · bus type · ♿ · next buses.
  const bits = [
    next.load ? `<span class="crowd ${esc(next.load)}" title="${esc(LOAD_FULL[next.load] || "")}"><i></i>${LOAD_LABEL[next.load] || esc(next.load)}</span>` : "",
    TYPE_LABEL[next.type] || "",
    next.feature === "WAB" ? `<span title="Wheelchair accessible" aria-label="Wheelchair accessible">♿</span>` : "",
  ].filter(Boolean).join(`<span class="dotsep">·</span>`);
  const note = aiNote(aiSecs, adj);
  return `
    <div class="svc" data-svc="${esc(svc.service_no)}">
      <button class="svc-head">
        <span class="route-badge">${esc(svc.service_no)}</span>
        <span class="svc-main">
          <span class="eta-now ${due ? "due" : ""}" data-eta-iso="${esc(next.api_arrival || "")}">${fmtMin(secs)}${due ? "" : `<span class="eta-unit">min</span>`}</span>
          <span class="eta-ai${note ? "" : " hidden"}" data-ai-iso="${esc(next.ai_arrival || "")}" data-adj="${Math.round(adj)}">${note}</span>
          <span class="svc-sub">${bits}${bits ? `<span class="dotsep">·</span>` : ""}${laterTxt ? `<span class="eta-next" data-next-isos="${esc(laterIsos)}">then ${laterTxt} min</span>` : `<span class="eta-next">last bus</span>`}</span>
        </span>
      </button>
      ${_bellBtn(svc.service_no)}
    </div>`;
}

// One-tap "alert me before it arrives" on each bus card — a sibling of the
// card's head button (buttons can't nest). Filled + accent while armed.
function _bellBtn(svcNo) {
  const on = _alertActive(S.stop, svcNo);
  return `<button class="svc-bell${on ? " on" : ""}" data-alert-svc="${esc(svcNo)}" aria-pressed="${on}"
    aria-label="${on ? `Alert on for bus ${esc(svcNo)} — tap to cancel` : `Alert me before bus ${esc(svcNo)} arrives`}"><svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M18 8A6 6 0 0 0 6 8c0 7-3 9-3 9h18s-3-2-3-9"/><path d="M13.73 21a2 2 0 0 1-3.46 0"/></svg></button>`;
}

function relLine(rel) {
  if (!rel) return "";
  const habit = delayHabit(rel.avg_delay_sec);
  const acc = rel.mae_sec != null ? `${accPhrase(rel.mae_sec)} · ` : "";
  return `<div class="svc-rel">
    <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/></svg>
    ${acc}${rel.on_time_pct}% on time · ${habit} <span class="svc-rel-n">(${rel.samples} observations)</span>
  </div>`;
}

// Mean-absolute-error → a compact confidence band ("±2m" / "±40s") shown as a
// badge, and a fuller phrase for the reliability line. Turns the delay data we
// already collect into a visible per-route accuracy signal.
function accBand(mae) {
  if (mae == null) return null;
  if (mae < 60) return `±${Math.round(mae)}s`;
  const m = mae / 60;
  return `±${m < 10 ? m.toFixed(1) : Math.round(m)}m`;
}
function accPhrase(mae) {
  const b = accBand(mae);
  return b ? `Predictions usually accurate to ${b}` : "";
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
  S.lastArrivals = { stop: S.stop, data };
  window.LiveBuses?.update(S.stop, data);   // 3D buses on the map + timeline strip
  // Soonest first: what matters now is at the top.
  const soon = (x) => parseUTC(x.buses?.[0]?.api_arrival)?.getTime() ?? Infinity;
  $("rows").innerHTML = [...data.services].sort((a, b) => soon(a) - soon(b)).map(svcCard).join("");
  // Keep the alert watcher's ETA store fresh from every render, so armed
  // alerts keep tracking even after the user navigates away from this stop.
  if (S.stop && S.alerts[S.stop]) {
    data.services.forEach((svc) => {
      if (S.alerts[S.stop][svc.service_no] && svc.buses?.[0]?.api_arrival) {
        _alertTrack(S.stop, svc.service_no, svc.buses);
      }
    });
  }
  document.querySelectorAll(".svc").forEach((c) => {
    if (open.has(c.dataset.svc)) c.classList.add("open");
  });
  $("updated-at").textContent = `Live · updated ${new Date().toLocaleTimeString("en-SG",
    { hour: "2-digit", minute: "2-digit", hour12: false, timeZone: "Asia/Singapore" })}`;
  startTicker();
}

$("rows").addEventListener("click", (e) => {
  const bell = e.target.closest(".svc-bell");
  if (bell) { toggleAlert(S.stop, bell.dataset.alertSvc); return; }
  // Clicking the route badge opens the route viewer instead of toggling expand
  const badge = e.target.closest(".route-badge");
  if (badge) {
    const svc = badge.closest(".svc");
    if (svc) loadBusRoute(svc.dataset.svc);
    return;
  }
  const head = e.target.closest(".svc-head");
  if (head) openMim(head.closest(".svc").dataset.svc);
});

function startTicker() {
  clearInterval(S.tickTmr);
  const rows = $("rows");
  S.tickTmr = setInterval(() => {
    // Only churn the visible eta DOM when the arrivals view is actually on screen
    // and the tab is foregrounded — nothing else changes per second. Queries are
    // scoped to #rows, not the whole document. (Arrival alerts run on their own
    // standing interval below, decoupled from this view-bound ticker.)
    if (rows && !document.hidden && S.view === "arrivals") {
      // Skip DOM writes when the text hasn't changed — fmtMin only moves at
      // minute granularity, so most 1 s ticks would otherwise force layout
      // work on every card for nothing.
      rows.querySelectorAll("[data-eta-iso]").forEach((node) => {
        const s = secsUntil(parseUTC(node.dataset.etaIso));
        const due = s !== null && s < DUE_SECS;
        const html = `${fmtMin(s)}${due ? "" : `<span class="eta-unit">min</span>`}`;
        node.classList.toggle("due", due);
        if (node._etaHtml !== html) { node._etaHtml = html; node.innerHTML = html; }
      });
      rows.querySelectorAll("[data-ai-iso]").forEach((node) => {
        if (!node.dataset.aiIso) return;
        const txt = aiNote(
          secsUntil(parseUTC(node.dataset.aiIso)),
          Number(node.dataset.adj || 0));
        if (node.textContent !== txt) { node.textContent = txt; node.classList.toggle("hidden", !txt); }
      });
      rows.querySelectorAll("[data-next-isos]").forEach((node) => {
        const txt = node.dataset.nextIsos.split(",").filter(Boolean)
          .map((iso) => _laterMin(secsUntil(parseUTC(iso)))).join(" · ");
        if (txt && node.textContent !== `then ${txt} min`) node.textContent = `then ${txt} min`;
      });
    }
  }, 1000);
}

// ── Arrival alerts ────────────────────────────────────────
// Per-service "ping me before it arrives" alerts. Fully client-side: a
// standing 1 s watcher checks last-known ETAs (refreshed by the open stop's
// renders, or a 45 s background fetch once you navigate away) and fires a
// system Notification (falling back to an in-app toast) once a bus is within
// the threshold. One-shot — clears itself after firing so it won't nag on the
// next bus. Persisted so reopening the app restores pending alerts. Foreground
// only: the page must be open (background push needs a push server).
function _alertActive(stop, svc) { return !!(stop && S.alerts[stop] && S.alerts[stop][svc]); }

// ── Web Push (alerts that arrive with the app closed) ─────
// The server watches the bus and pushes the ping (see push_routes.py), so it
// reaches the phone even when the app is in the background or closed. Works
// on Android, and on iPhone once the app is on the Home Screen (iOS 16.4+).
// Without push (unsupported browser, permission refused, server not set up)
// alerts still work while the app is open.
let _pushKey;   // undefined = not asked yet, null = push unavailable
function _b64ToBytes(b64) {
  const s = atob(b64.replace(/-/g, "+").replace(/_/g, "/") + "===".slice((b64.length + 3) % 4));
  return Uint8Array.from(s, (c) => c.charCodeAt(0));
}
async function _pushSubscription() {
  if (!("serviceWorker" in navigator) || !("PushManager" in window) || !("Notification" in window)) return null;
  if (Notification.permission === "default") await Notification.requestPermission();
  if (Notification.permission !== "granted") return null;
  if (_pushKey === undefined) {
    try { const k = await api("/api/push/key"); _pushKey = k.enabled ? k.key : null; } catch { return null; }
  }
  if (!_pushKey) return null;
  const reg = await navigator.serviceWorker.ready;
  let sub = await reg.pushManager.getSubscription();
  if (!sub) sub = await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: _b64ToBytes(_pushKey) });
  return sub.toJSON();
}
async function _pushCreate(body) {
  try {
    const subscription = await _pushSubscription();
    if (!subscription) return null;
    return (await api("/api/push/alerts", { method: "POST", body: JSON.stringify({ subscription, ...body }) })).id;
  } catch { return null; }
}
function _pushCancel(id) {
  if (id) api(`/api/push/alerts/${encodeURIComponent(id)}`, { method: "DELETE" }).catch(() => {});
}

// ── Arrival alerts ────────────────────────────────────────
// Each alert follows one specific bus: the first one due after `skip` (set
// when the user asked for "the next one" because the current bus was already
// arriving). Following a single bus by its arrival time means that once it has
// come (and the push has gone out), reopening the app won't ping again for
// the bus after it.
const ALERT_META_KEY = "sgbus_alert_meta";
S.alertMeta = readJSON(ALERT_META_KEY, {});   // "stop|svc" → { skip, target, pushId }
function _saveAlerts() { writeJSON(ALERTS_KEY, S.alerts); writeJSON(ALERT_META_KEY, S.alertMeta); }

function _alertTrack(stop, svc, buses) {
  const key = `${stop}|${svc}`, m = (S.alertMeta[key] ||= {});
  const t = (b) => parseUTC(b.api_arrival)?.getTime();
  let pick;
  if (m.target) {
    const tt = parseUTC(m.target)?.getTime();
    pick = buses.filter((b) => t(b) && Math.abs(t(b) - tt) <= 180e3)
      .sort((x, y) => Math.abs(t(x) - tt) - Math.abs(t(y) - tt))[0];
    if (!pick) return;   // keep the last known time; it may just be between refreshes
  } else {
    const skip = m.skip ? parseUTC(m.skip).getTime() + 30e3 : -Infinity;
    pick = buses.find((b) => t(b) && t(b) > skip);
    if (!pick) return;
  }
  m.target = pick.api_arrival;
  S.alertEtas[key] = pick.api_arrival;
  writeJSON(ALERT_META_KEY, S.alertMeta);
}

function _clearAlert(stop, svc, { cancelPush = true } = {}) {
  const key = `${stop}|${svc}`;
  if (cancelPush) _pushCancel(S.alertMeta[key]?.pushId);
  if (S.alerts[stop]) { delete S.alerts[stop][svc]; if (!Object.keys(S.alerts[stop]).length) delete S.alerts[stop]; }
  delete S.alertMeta[key]; delete S.alertEtas[key];
  _saveAlerts();
}

function _armAlert(stop, svc, buses, skipIso = null) {
  const key = `${stop}|${svc}`;
  S.alerts[stop] = S.alerts[stop] || {};
  S.alerts[stop][svc] = ALERT_THRESHOLD_SEC;
  S.alertMeta[key] = { skip: skipIso };
  S.firedAlerts.delete(key);
  if (buses?.length) _alertTrack(stop, svc, buses);
  _saveAlerts();
  _syncAlertBtns();
  const stopName = (stop === S.stop && S.stopInfo?.description) || `Stop ${stop}`;
  const mins = (() => { const x = secsUntil(parseUTC(S.alertEtas[key])); return x == null ? null : Math.max(1, Math.round(x / 60)); })();
  _pushCreate({ kind: "arrive", service_no: svc, stop, stop_name: stopName, skip_until: skipIso }).then((id) => {
    if (!S.alerts[stop]?.[svc]) { _pushCancel(id); return; }   // cancelled meanwhile
    if (id) { S.alertMeta[key].pushId = id; _saveAlerts(); }
    const denied = "Notification" in window && Notification.permission === "denied";
    const tail = skipIso && mins ? ` (due in ${mins} min)` : "";
    toast(id ? `You'll be pinged ~1 min before bus ${svc}${tail}, even with the app closed`
      : denied ? `Alert set for bus ${svc}${tail}. Notifications are off, so keep the app open`
      : `Alert set for bus ${svc}${tail}. Keep the app open to get it`);
  });
}

function toggleAlert(stop, svc) {
  if (!stop || !svc) return;
  if (_alertActive(stop, svc)) {
    _clearAlert(stop, svc);
    toast(`Alert off for bus ${svc}`);
    _syncAlertBtns();
    return;
  }
  // Ask for notification permission inside the tap (iPhone requires a gesture).
  if ("Notification" in window && Notification.permission === "default") Notification.requestPermission().catch(() => {});
  const buses = (S.lastArrivals?.stop === stop ? S.lastArrivals.data.services?.find((x) => x.service_no === svc)?.buses : null) || [];
  const first = buses[0], firstSecs = first ? secsUntil(parseUTC(first.api_arrival)) : null;
  // Already inside the 1-minute mark: a ping now would be pointless. Say so,
  // and offer to ping before the following bus instead.
  if (firstSecs != null && firstSecs <= ALERT_THRESHOLD_SEC) {
    const next = buses[1] ? secsUntil(parseUTC(buses[1].api_arrival)) : null;
    const nextTxt = next != null ? ` The next one is due in ${Math.max(1, Math.round(next / 60))} min.` : "";
    showConfirm(`<b>Bus ${esc(svc)} is arriving now.</b>${esc(nextTxt)}<br>Ping you before the next one?`,
      "Ping next bus", () => _armAlert(stop, svc, buses, first.api_arrival), { cancelLabel: "No thanks" });
    return;
  }
  _armAlert(stop, svc, buses);
}

// Reflect alert state on the rendered buttons without a full re-render.
function _syncAlertBtns() {
  document.querySelectorAll(".svc-bell[data-alert-svc]").forEach((btn) => {
    const svc = btn.dataset.alertSvc;
    const on = _alertActive(S.stop, svc);
    btn.classList.toggle("on", on);
    btn.setAttribute("aria-pressed", on);
    btn.setAttribute("aria-label", on ? `Alert on for bus ${svc} — tap to cancel` : `Alert me before bus ${svc} arrives`);
  });
  _mimRenderAlert();
}

function _checkAlerts() {
  // Works entirely off S.alertEtas (kept fresh by renderArrivals for the open
  // stop and by _refreshAlertEtas for everything else) — NOT the rendered
  // DOM. Tying this to #rows meant tapping Back silently disarmed alerts the
  // user had just been promised.
  for (const stop of Object.keys(S.alerts)) {
    for (const svc of Object.keys(S.alerts[stop])) {
      const key = `${stop}|${svc}`;
      const secs = secsUntil(parseUTC(S.alertEtas[key]));
      if (secs === null) continue;
      if (secs <= ALERT_THRESHOLD_SEC && secs > -45 && !S.firedAlerts.has(key)) {
        S.firedAlerts.add(key);
        // The app is open and caught it: ping here and call off the push.
        _fireArrivalAlert(stop, svc, secs);
        _clearAlert(stop, svc);
        _syncAlertBtns();
      } else if (secs <= -120) {
        // Its bus came and went while the app was closed; the push handled it.
        _clearAlert(stop, svc, { cancelPush: false });
        _syncAlertBtns();
      }
    }
  }
}

// Refresh ETAs for stops with armed alerts that are NOT currently open (the
// open stop's 30 s refresh already feeds renderArrivals). Cheap: alerts are
// one-shot and rarely armed for more than a stop or two.
async function _refreshAlertEtas() {
  for (const stop of Object.keys(S.alerts)) {
    if (stop === S.stop) continue;
    try {
      const d = await api(`/api/arrivals/${stop}`);
      (d.services || []).forEach((svc) => {
        if (S.alerts[stop]?.[svc.service_no] && svc.buses?.length) _alertTrack(stop, svc.service_no, svc.buses);
      });
    } catch { /* keep last known ETA; next round may succeed */ }
  }
}

// Standing watcher, independent of the arrivals view/ticker lifecycle.
setInterval(_checkAlerts, 1000);
setInterval(() => { if (Object.keys(S.alerts).length) _refreshAlertEtas(); }, 45 * 1000);

function _fireArrivalAlert(stop, svc, secs) {
  const stopName = (stop === S.stop && S.stopInfo?.description) || `stop ${stop}`;
  const when = secs < DUE_SECS ? "now" : `in ~${Math.max(1, Math.round(secs / 60))} min`;
  const title = `Bus ${svc} arriving ${when}`;
  try { navigator.vibrate?.([200, 100, 200]); } catch {}
  toast(`🔔 ${title}`);   // always show in-app too; the system banner may be suppressed while the app is open
  _systemNotify(title, { body: stopName, tag: `sgbus-arrive-${svc}-${stop}` });
}

// System notification. Android Chrome (and installed iPhone web apps) don't
// allow `new Notification()` from a page; it throws "Illegal constructor". They
// require the service worker's showNotification(), so try that first and only
// fall back to the constructor (desktop browsers).
async function _systemNotify(title, opts) {
  if (!("Notification" in window) || Notification.permission !== "granted") return false;
  const o = { icon: "icons/icon-192.png", badge: "icons/icon-192.png", renotify: true, vibrate: [200, 100, 200], ...opts };
  try {
    const reg = await navigator.serviceWorker?.getRegistration();
    if (reg) { await reg.showNotification(title, o); return true; }
  } catch { /* fall through */ }
  try {
    const n = new Notification(title, o);
    n.onclick = () => { window.focus(); n.close(); };
    return true;
  } catch { return false; }
}

// ── "Can I make it?" ──────────────────────────────────────
// Live go / no-go for one service at the open stop. GPS gives the walk to the
// stop (straight line × 1.3 detour at the chosen pace — same model as the
// journey planner), which is weighed against the AI-predicted arrival of each
// upcoming bus: when to leave, whether to hurry, and which bus is the first one
// still catchable. "Notify me" pings at leave time while the app is open.
const MIM_DETOUR     = 1.3;
const MIM_EARLY_OPTS = [60, 120, 180];   // "arrive early" choices (s)
const MIM_EARLY_KEY  = "sgbus_mim_early";
const MIM_AT_STOP_M  = 40;
const MIM_PACES      = { relaxed: 65, normal: 80, brisk: 100 };  // m/min
const MIM_PACE_KEY   = "sgbus_mim_pace";
const MIM_REFRESH_MS = 20_000;

const M = {
  open: false, stop: null, svc: null, stopName: "", stopLat: null, stopLng: null,
  buses: [], mae: null, loaded: false, loadErr: null,
  target: null,      // api_arrival ISO of a bus the user picked (else auto)
  pos: null, posAcc: null, posTs: 0, locErr: null, usingHome: false,
  pace: localStorage.getItem(MIM_PACE_KEY) || "normal",
  early: Number(localStorage.getItem(MIM_EARLY_KEY)) || 60,
  watchId: null, tickTmr: null, refreshTmr: null,
  notify: null,      // { stop, svc, target, fired } — follows the tracked bus
  busesKey: "",
};
if (!MIM_PACES[M.pace]) M.pace = "normal";
if (!MIM_EARLY_OPTS.includes(M.early)) M.early = 60;

// Time to have in hand at the stop: the user's "arrive early" choice, raised
// to the route's typical prediction error (MAE) when that's larger, rounded
// up to 15 s. A ±2 min route gets a 2 min cushion even if you picked 1.
function _mimCushion() {
  const want = Math.max(M.early, M.mae || 0);
  return Math.ceil(want / 15) * 15;
}
function _mimMinsHalf(s) {
  const m = Math.round(s / 30) / 2;
  return `${m % 1 ? m.toFixed(1) : m} min`;
}

function _distM(lat1, lng1, lat2, lng2) {
  const R = 6371000, rad = (x) => (x * Math.PI) / 180;
  const dp = rad(lat2 - lat1), dl = rad(lng2 - lng1);
  const a = Math.sin(dp / 2) ** 2 +
    Math.cos(rad(lat1)) * Math.cos(rad(lat2)) * Math.sin(dl / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(a));
}
function _mimCountdown(s) {
  s = Math.max(0, Math.round(s));
  if (s >= 3600) return `${Math.floor(s / 3600)}h ${String(Math.floor(s % 3600 / 60)).padStart(2, "0")}m`;
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
}
function _mimMins(s) {
  const m = Math.round(Math.max(0, s) / 60);
  return m < 1 ? "<1 min" : `${m} min`;
}

// Walking distance (m) along streets, or null with no fix yet.
function _mimWalkM() {
  if (!M.pos || M.stopLat == null) return null;
  return _distM(M.pos.lat, M.pos.lng, M.stopLat, M.stopLng) * MIM_DETOUR;
}
function _mimBusDate(b) { return parseUTC(b.ai_arrival) || parseUTC(b.api_arrival); }

// Verdict for one bus: yes (time to spare) · now · hurry (only at a brisk
// walk, no buffer) · no · there (already at the stop).
function _mimEval(b, walkM) {
  const at = _mimBusDate(b);
  const busIn = secsUntil(at);
  if (busIn === null) return null;
  const crowM = walkM / MIM_DETOUR;
  if (crowM < MIM_AT_STOP_M) {
    return { b, at, busIn, walkS: 0, leaveIn: busIn, state: busIn > -30 ? "there" : "no" };
  }
  const walkS = walkM / MIM_PACES[M.pace] * 60;
  const leaveIn = busIn - walkS - _mimCushion();
  const briskSlack = busIn - walkM / MIM_PACES.brisk * 60;
  const state = leaveIn >= 60 ? "yes" : leaveIn >= 0 ? "now" : briskSlack >= 0 ? "hurry" : "no";
  return { b, at, busIn, walkS, leaveIn, briskSlack, state };
}

// The bus to plan around: the user's pick if it's still in the feed (matched
// by arrival time, since LTA has no bus IDs), else the first catchable one.
function _mimPick(evals, target) {
  if (target) {
    const t = parseUTC(target)?.getTime();
    let best = null, bestD = 3 * 60 * 1000;
    for (const e of evals) {
      const d = Math.abs((parseUTC(e.b.api_arrival)?.getTime() ?? Infinity) - t);
      if (d < bestD) { best = e; bestD = d; }
    }
    if (best) return best;
  }
  return evals.find((e) => e.state !== "no") || evals[evals.length - 1] || null;
}

function _mimEvals() {
  const walkM = _mimWalkM();
  if (walkM === null) return null;
  return M.buses.map((b) => _mimEval(b, walkM)).filter((e) => e && e.busIn > -60);
}

async function openMim(svc) {
  if (!S.stop || !svc) return;
  if (M.notify && (M.notify.stop !== S.stop || M.notify.svc !== svc)) {
    M.notify = null;
    toast("Previous leave reminder cancelled");
  }
  M.stop = S.stop; M.svc = svc; M.target = null;
  M.stopName = S.stopInfo?.description || `Stop ${S.stop}`;
  M.stopLat = S.stopInfo?.latitude ?? null;
  M.stopLng = S.stopInfo?.longitude ?? null;
  if (M.stopLat == null) {
    const st = _loadStopsCache().find((s) => s.bus_stop_code === S.stop);
    if (st) { M.stopLat = st.latitude; M.stopLng = st.longitude; }
  }
  M.buses = []; M.svcData = null; M.loaded = false; M.loadErr = null; M.busesKey = "";
  const cached = S.lastArrivals?.stop === S.stop
    && S.lastArrivals.data.services?.find((x) => x.service_no === svc);
  if (cached) _mimSetSvc(cached);
  $("mim-more").open = false;
  $("mim-route").open = false;
  $("mim-route-body").innerHTML = "";
  $("mim-route-sum").textContent = "";
  _routeSummary(svc, S.stop);
  M.open = true;
  $("mim-badge").textContent = svc;
  $("mim-sub").textContent = M.stopName;
  _mimSyncPace();
  const sheet = $("mim-sheet");
  show($("mim-backdrop")); show(sheet);
  requestAnimationFrame(() => sheet.classList.add("open"));
  _mimStartLocation();
  _mimStartLoops();
  _mimRender();
  _mimRefresh();
}

// ── Bus route (inside the bus sheet) ──────────────────────
// The service's stops in order, starting from the stop you're at, with the
// option to draw the route on the map. Uses /api/routes/{svc} (LTA BusRoutes)
// and the cached stop list for coordinates.
const _routeCache = new Map();   // svc → Promise<route data>
function _routeData(svc) {
  if (!_routeCache.has(svc)) {
    _routeCache.set(svc, api(`/api/routes/${encodeURIComponent(svc)}`)
      .catch((e) => { _routeCache.delete(svc); throw e; }));
  }
  return _routeCache.get(svc);
}
// The direction this stop is served in. A stop can appear in both directions
// (or twice on a loop); prefer the one where it isn't the final stop.
function _routeDirFor(data, stop) {
  let best = null;
  for (const d of data.directions) {
    const i = d.stops.findIndex((x) => x.code === stop);
    if (i < 0) continue;
    if (!best || (best.i === best.d.stops.length - 1 && i < d.stops.length - 1)) best = { d, i };
  }
  return best || { d: data.directions[0], i: -1 };
}
const _stopLabel = (x) => x?.name || x?.code || "";

async function _routeSummary(svc, stop) {
  try {
    const { d, i } = _routeDirFor(await _routeData(svc), stop);
    if (M.svc !== svc || M.stop !== stop) return;
    const left = i >= 0 ? d.stops.length - 1 - i : d.stops.length;
    $("mim-route-sum").textContent = `· to ${_stopLabel(d.stops.at(-1))}${i >= 0 ? `, ${left} stop${left === 1 ? "" : "s"}` : ""}`;
  } catch { /* summary is optional */ }
}

async function _renderMimRoute(showEarlier = false) {
  const body = $("mim-route-body");
  const svc = M.svc, stop = M.stop;
  if (!body.innerHTML) body.innerHTML = `<p class="mim-route-msg">Loading route…</p>`;
  let data;
  try { data = await _routeData(svc); }
  catch (e) { if (M.svc === svc) body.innerHTML = `<p class="mim-route-msg">Route not available: ${esc(e.message)}</p>`; return; }
  if (M.svc !== svc || M.stop !== stop) return;
  const { d, i } = _routeDirFor(data, stop);
  const here = i >= 0 ? d.stops[i] : null;
  const from = showEarlier || i < 0 ? 0 : i;
  const km = (x) => (here && x.distance_km != null && here.distance_km != null) ? x.distance_km - here.distance_km : null;
  body.innerHTML = `
    <div class="mim-route-top">
      <span>Towards <b>${esc(_stopLabel(d.stops.at(-1)))}</b></span>
      <button type="button" class="pillbtn mim-route-map" data-route-map>
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M14.1 4.5 9.9 2.6a2 2 0 0 0-1.6 0L3.6 4.7A1 1 0 0 0 3 5.6v14.1a1 1 0 0 0 1.4.9l3.9-1.8a2 2 0 0 1 1.6 0l4.2 1.9a2 2 0 0 0 1.6 0l4.7-2.1a1 1 0 0 0 .6-.9V3.6a1 1 0 0 0-1.4-.9l-3.9 1.8a2 2 0 0 1-1.6 0Z"/></svg>
        Show on map
      </button>
    </div>
    <p class="mim-route-tip">Tap 🔔 next to your stop to get a ping one stop before it.</p>
    ${i > 0 && !showEarlier ? `<button type="button" class="mim-route-earlier" data-route-earlier>Show ${i} earlier stop${i === 1 ? "" : "s"}</button>` : ""}
    <ol class="mim-route-list">
      ${d.stops.slice(from).map((x, k) => {
        const j = from + k, dist = km(x);
        const cls = j < i ? "past" : j === i ? "here" : "";
        const ride = _rideFor(svc);
        const bellOn = ride && ride.dest === x.code;
        const bell = j > i && i >= 0
          ? `<button type="button" class="mim-route-bell${bellOn ? " on" : ""}" data-ride-dest="${esc(x.code)}"
               aria-pressed="${!!bellOn}" aria-label="${bellOn ? "Cancel the alert for" : "Ping me one stop before"} ${esc(_stopLabel(x))}">
               <svg width="15" height="15" viewBox="0 0 24 24" fill="${bellOn ? "currentColor" : "none"}" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M6 8a6 6 0 0 1 12 0c0 7 3 9 3 9H3s3-2 3-9"/><path d="M10.3 21a1.94 1.94 0 0 0 3.4 0"/></svg>
             </button>` : "";
        return `<li class="mim-route-stop ${cls}${j === d.stops.length - 1 ? " end" : ""}">
          <button type="button" class="mim-route-main" data-route-stop="${esc(x.code)}">
            <span class="mim-route-dot"></span>
            <span class="mim-route-info">
              <span class="mim-route-name">${esc(_stopLabel(x))}${j === i ? ` <em>You're here</em>` : ""}</span>
              <span class="mim-route-meta">${esc(x.code)}${x.road ? ` · ${esc(x.road)}` : ""}</span>
            </span>
            ${dist != null && dist > 0 ? `<span class="mim-route-km">${dist.toFixed(1)} km</span>` : ""}
          </button>${bell}
        </li>`;
      }).join("")}
    </ol>`;
}
$("mim-route").addEventListener("toggle", () => { if ($("mim-route").open) _renderMimRoute(); });
$("mim-route-body").addEventListener("click", async (e) => {
  if (e.target.closest("[data-route-earlier]")) { _renderMimRoute(true); return; }
  if (e.target.closest("[data-route-map]")) { _showRouteOnMap(M.svc, M.stop); return; }
  const bell = e.target.closest("[data-ride-dest]");
  if (bell) { _toggleRide(M.svc, M.stop, bell.dataset.rideDest); return; }
  const b = e.target.closest("[data-route-stop]");
  if (b && b.dataset.routeStop !== M.stop) { closeMim(); loadStop(b.dataset.routeStop); }
});

// Draw the route on the Bus map: the part still ahead in the accent colour,
// the part already passed faded, with a dot per stop (tap one to open it).
let _routeLayer = null;
async function _showRouteOnMap(svc, stop) {
  let data;
  try { data = await _routeData(svc); } catch (e) { toast(`Route not available: ${e.message}`); return; }
  await ensureStopsCache().catch(() => {});
  const pos = new Map(_loadStopsCache().map((x) => [x.bus_stop_code, [x.latitude, x.longitude]]));
  const { d, i } = _routeDirFor(data, stop);
  const pts = d.stops.map((x) => ({ ...x, ll: pos.get(x.code) })).filter((x) => x.ll && x.ll[0] != null);
  if (pts.length < 2) { toast("No map data for this route yet"); return; }
  closeMim();
  switchView("arrivals");
  if (!_arrMap) await _arrMapP;
  _clearRouteOnMap();
  const cut = Math.max(0, pts.findIndex((x) => x.code === stop));
  const accent = getComputedStyle(document.documentElement).getPropertyValue("--accent").trim() || "#e11d48";
  _routeLayer = SGL.layerGroup().addTo(_arrMap);
  if (cut > 0) SGL.polyline(pts.slice(0, cut + 1).map((x) => x.ll), { color: accent, weight: 4, opacity: .3, dashArray: "4 7" }).addTo(_routeLayer);
  const ahead = pts.slice(cut);
  SGL.polyline(ahead.map((x) => x.ll), { color: "#fff", weight: 8, opacity: .85 }).addTo(_routeLayer);
  SGL.polyline(ahead.map((x) => x.ll), { color: accent, weight: 5 }).addTo(_routeLayer);
  pts.forEach((x, k) => {
    const isHere = k === cut && x.code === stop, isEnd = k === pts.length - 1;
    SGL.circleMarker(x.ll, {
      radius: isHere ? 8 : isEnd ? 6 : 3.5, weight: isHere ? 3 : 2,
      color: k < cut ? "rgba(120,120,120,.6)" : accent, fillColor: isHere ? accent : "#fff", fillOpacity: 1,
    }).bindTooltip(`${esc(_stopLabel(x))} · ${esc(x.code)}`, { direction: "top", offset: [0, -6] })
      .on("click", () => loadStop(x.code))
      .addTo(_routeLayer);
  });
  // Chip under the mode switch: which route is shown, and × to clear it.
  const wrap = $("view-arrivals").querySelector(".arr-search-wrap");
  let chip = $("route-chip");
  if (!chip) {
    chip = document.createElement("div");
    chip.id = "route-chip"; chip.className = "route-chip";
    wrap.appendChild(chip);
    chip.addEventListener("click", (e) => { if (e.target.closest("[data-route-clear]")) _clearRouteOnMap(); });
  }
  chip.innerHTML = `<span class="route-chip-badge">${esc(svc)}</span>
    <span class="route-chip-txt">to ${esc(_stopLabel(d.stops.at(-1)))}</span>
    <button type="button" class="route-chip-x" data-route-clear aria-label="Hide route">
      <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round"><path d="M18 6 6 18M6 6l12 12"/></svg>
    </button>`;
  show(chip);
  _snapSheet("min");
  setTimeout(() => {
    _arrMap.invalidateSize();
    const b = SGL.latLngBounds(ahead.map((x) => x.ll));
    const sb = wrap.getBoundingClientRect(), sh = $("view-arrivals").querySelector(".arr-sheet").getBoundingClientRect();
    const mc = _arrMap.getContainer().getBoundingClientRect();
    const sideBySide = sh.right <= mc.left + 4;   // landscape side panel
    // Use the sheet's target height, not its on-screen size: it may still be
    // sliding down, and over-sized padding makes Leaflet zoom all the way in.
    const sheetH = parseFloat(getComputedStyle(document.documentElement).getPropertyValue("--sheet-h")) || 0;
    let top = sideBySide ? 24 : Math.max(24, sb.bottom - mc.top + 12);
    let bottom = sideBySide ? 24 : Math.max(24, sheetH + 16);
    const room = mc.height * 0.75;   // always leave a quarter of the map for the route
    if (top + bottom > room) { const k = room / (top + bottom); top *= k; bottom *= k; }
    _arrMap.fitBounds(b, { paddingTopLeft: [24, top], paddingBottomRight: [24, bottom], maxZoom: 16 });
  }, 320);
}
function _clearRouteOnMap() {
  if (_routeLayer) { _routeLayer.remove(); _routeLayer = null; }
  const chip = $("route-chip");
  if (chip) hide(chip);
}

// ── "Ping me one stop before my stop" (riding alerts) ─────
// While riding, get a heads-up when the bus reaches the stop before yours.
// The server follows the bus itself (LTA's live bus positions) and pushes the
// ping, so it works with the app closed; while the app is open the phone's
// GPS can trigger it too. One per bus service.
const RIDES_KEY = "sgbus_rides";
S.rides = readJSON(RIDES_KEY, []).filter((r) => Date.now() - r.at < 3 * 3600e3);
const _saveRides = () => writeJSON(RIDES_KEY, S.rides);
const _rideFor = (svc) => S.rides.find((r) => r.svc === svc);
function _ll(code) { const x = _loadStopsCache().find((s) => s.bus_stop_code === code); return x?.latitude != null ? [x.latitude, x.longitude] : null; }
function _mDist(a, b) {
  if (!a || !b) return Infinity;
  const r = Math.PI / 180, dp = (b[0] - a[0]) * r, dl = (b[1] - a[1]) * r;
  const h = Math.sin(dp / 2) ** 2 + Math.cos(a[0] * r) * Math.cos(b[0] * r) * Math.sin(dl / 2) ** 2;
  return 6371000 * 2 * Math.asin(Math.min(1, Math.sqrt(h)));
}

async function _toggleRide(svc, board, dest) {
  const cur = _rideFor(svc);
  if (cur && cur.dest === dest) { _endRide(cur, true); toast("Stop alert cancelled"); _renderMimRoute(); return; }
  let data;
  try { data = await _routeData(svc); } catch (e) { toast(`Route not available: ${e.message}`); return; }
  const { d } = _routeDirFor(data, board);
  const j = d.stops.findIndex((x) => x.code === dest);
  if (j < 1) return;
  const prev = d.stops[j - 1], destStop = d.stops[j];
  if ("Notification" in window && Notification.permission === "default") Notification.requestPermission().catch(() => {});
  const go = async (onBoard) => {
    if (cur) _endRide(cur, true);
    const ride = { svc, board, dest, destName: _stopLabel(destStop), prev: prev.code, onBoard, at: Date.now(), moved: onBoard };
    const body = { kind: "alight", service_no: svc, stop: prev.code, board_stop: board, dest_stop: dest, stop_name: ride.destName };
    if (onBoard) {
      const pos = await new Promise((res) => navigator.geolocation
        ? navigator.geolocation.getCurrentPosition((p) => res(p.coords), () => res(null), { enableHighAccuracy: true, timeout: 6000, maximumAge: 20000 })
        : res(null));
      if (pos) { body.rider_lat = pos.latitude; body.rider_lng = pos.longitude; }
    } else {
      // The bus you'll catch: the one picked in this sheet, else the next one due.
      body.skip_until = M.target || M.buses?.find((b) => secsUntil(parseUTC(b.api_arrival)) > -30)?.api_arrival || null;
    }
    S.rides.push(ride); _saveRides();
    _renderMimRoute(); _renderRideChip(); _rideWatch();
    const id = await _pushCreate(body);
    if (!S.rides.includes(ride)) { _pushCancel(id); return; }
    ride.pushId = id; _saveRides();
    toast(id ? `You'll be pinged one stop before ${ride.destName}, even with the app closed`
      : `Alert set for ${ride.destName}. Keep the app open (with location on) to get it`);
  };
  showConfirm(`Ping you one stop before <b>${esc(_stopLabel(destStop))}</b>.<br>Are you on bus ${esc(svc)} yet?`,
    "Not yet, catching it", () => go(false), { cancelLabel: "I'm on it", onCancel: () => go(true) });
}

function _endRide(ride, cancelPush) {
  if (cancelPush) _pushCancel(ride.pushId);
  S.rides = S.rides.filter((r) => r !== ride); _saveRides();
  _renderRideChip(); _rideWatch();
}

function _fireRide(ride) {
  try { navigator.vibrate?.([300, 120, 300, 120, 300]); } catch {}
  const title = "Your stop is next";
  const body = `Get ready to get off bus ${ride.svc} at ${ride.destName}`;
  toast(`🔔 ${title}: ${ride.destName}`);
  _systemNotify(title, { body, tag: `sgbus-alight-${ride.svc}-${ride.prev}`, vibrate: [300, 120, 300, 120, 300] });
  _endRide(ride, true);   // the app caught it; call off the server push
  if (M.open) _renderMimRoute();
}

// While the app is open, the phone's own position can trigger the ping:
// once you've left the boarding stop, being near the stop before yours (or
// already past it) counts. The server push covers the app-closed case.
let _rideWatchId = null;
function _rideWatch() {
  const need = S.rides.length && !document.hidden && navigator.geolocation;
  if (need && _rideWatchId === null) {
    _rideWatchId = navigator.geolocation.watchPosition(({ coords }) => {
      const me = [coords.latitude, coords.longitude];
      for (const r of [...S.rides]) {
        const board = _ll(r.board), prev = _ll(r.prev), dest = _ll(r.dest);
        if (!prev || !dest) continue;
        if (!r.moved && _mDist(me, board) > 250) { r.moved = true; _saveRides(); }
        if (!r.moved) continue;
        if (_mDist(me, prev) <= 150 || _mDist(me, dest) < _mDist(prev, dest) - 40) _fireRide(r);
      }
    }, () => {}, { enableHighAccuracy: true, maximumAge: 10000, timeout: 20000 });
  } else if (!need && _rideWatchId !== null) {
    navigator.geolocation.clearWatch(_rideWatchId); _rideWatchId = null;
  }
}
document.addEventListener("visibilitychange", _rideWatch);

// Chip on the Bus map while a stop alert is set, with × to cancel.
function _renderRideChip() {
  const wrap = $("view-arrivals").querySelector(".arr-search-wrap");
  let chip = $("ride-chip");
  if (!S.rides.length) { chip?.classList.add("hidden"); return; }
  if (!chip) {
    chip = document.createElement("div");
    chip.id = "ride-chip"; chip.className = "route-chip ride-chip";
    wrap.appendChild(chip);
    chip.addEventListener("click", (e) => {
      const x = e.target.closest("[data-ride-cancel]");
      const r = x && S.rides.find((q) => q.svc === x.dataset.rideCancel);
      if (r) { _endRide(r, true); toast("Stop alert cancelled"); if (M.open) _renderMimRoute(); }
    });
  }
  const r = S.rides[S.rides.length - 1];
  chip.innerHTML = `<span class="route-chip-badge">🔔 ${esc(r.svc)}</span>
    <span class="route-chip-txt">ping before ${esc(r.destName)}</span>
    <button type="button" class="route-chip-x" data-ride-cancel="${esc(r.svc)}" aria-label="Cancel stop alert">
      <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round"><path d="M18 6 6 18M6 6l12 12"/></svg>
    </button>`;
  chip.classList.remove("hidden");
}
// Expire stale ones (the server drops them after 3 h too) and restore on load.
setInterval(() => { S.rides.filter((r) => Date.now() - r.at > 3 * 3600e3).forEach((r) => _endRide(r, true)); }, 60e3);
setTimeout(() => { _renderRideChip(); _rideWatch(); }, 0);

// "Show where this bus is": close the sheet and fly to the bus picked in it
// (live 3D bus on the map — see live-buses.js).
$("mim-where")?.addEventListener("click", () => {
  const iso = M.target || M.buses?.find((b) => secsUntil(parseUTC(b.api_arrival)) > -30)?.api_arrival;
  const svc = M.svc;
  closeMim();
  setTimeout(() => {
    if (!window.LiveBuses?.focusSvc(svc, iso)) toast(`Bus ${svc} isn't on the map yet — it shows once it's within 30 min`);
  }, 300);
});

function closeMim() {
  M.open = false;
  const sheet = $("mim-sheet");
  sheet.classList.remove("open");
  setTimeout(() => { if (!M.open) { hide(sheet); hide($("mim-backdrop")); } }, 280);
  // Keep tracking in the background only while a leave-time ping is armed.
  if (!M.notify) _mimStopAll();
  _mimRenderPill();
}

function _mimStopAll() {
  if (M.watchId !== null) { navigator.geolocation?.clearWatch(M.watchId); M.watchId = null; }
  clearInterval(M.tickTmr); clearInterval(M.refreshTmr);
  M.tickTmr = M.refreshTmr = null;
}

function _mimStartLoops() {
  if (!M.tickTmr) M.tickTmr = setInterval(_mimTick, 1000);
  if (!M.refreshTmr) M.refreshTmr = setInterval(_mimRefresh, MIM_REFRESH_MS);
}

function _mimStartLocation(forceGps = false) {
  M.locErr = null;
  if (!forceGps && M.usingHome) return;
  M.usingHome = false;
  if (!navigator.geolocation) { M.locErr = "Location isn't available on this device."; return; }
  if (M.watchId !== null) return;
  M.watchId = navigator.geolocation.watchPosition(
    ({ coords }) => {
      M.pos = { lat: coords.latitude, lng: coords.longitude };
      M.posAcc = coords.accuracy; M.posTs = Date.now(); M.locErr = null;
      _mimRender();
    },
    (err) => {
      M.locErr = err.code === 1
        ? "Location is off for this app. Allow it in Settings, or use your Home location."
        : "Couldn't get your location yet.";
      _mimRender();
    },
    { enableHighAccuracy: true, maximumAge: 10_000, timeout: 20_000 },
  );
}

function _mimUseHome() {
  const h = getHome();
  if (!h) { toast("Set a Home location in Settings first"); return; }
  if (M.watchId !== null) { navigator.geolocation.clearWatch(M.watchId); M.watchId = null; }
  M.usingHome = true; M.locErr = null;
  M.pos = { lat: h.lat, lng: h.lng }; M.posAcc = null; M.posTs = Date.now();
  _mimRender();
}

async function _mimRefresh() {
  const stop = M.stop, svc = M.svc;
  if (!stop) return;
  try {
    const d = await api(`/api/arrivals/${stop}`);
    if (M.stop !== stop || M.svc !== svc) return;
    _mimSetSvc((d.services || []).find((x) => x.service_no === svc));
  } catch (e) {
    M.loadErr = e.message;
  }
  _mimRender();
}

function _mimSetSvc(s) {
  M.svcData = s || null;
  M.buses = s?.buses || [];
  M.mae = s?.reliability?.mae_sec ?? null;
  M.loaded = true; M.loadErr = null;
  _mimRenderMore();
}

// "Arrival details": what the expanded card used to show — LTA vs AI per bus,
// crowding and route reliability.
function _mimRenderMore() {
  const s = M.svcData;
  $("mim-more-body").innerHTML = s ? `
    ${relLine(s.reliability)}
    ${s.buses.map(busLine).join("")}` : "";
  _mimRenderAlert();
}

// Arrival alert, right under "Notify me" (it used to be buried at the bottom
// of the collapsed Arrival details).
function _mimRenderAlert() {
  const btn = $("mim-alert");
  if (!btn || !M.svc) return;
  const on = _alertActive(M.stop, M.svc);
  btn.classList.toggle("on", on);
  btn.setAttribute("aria-pressed", on);
  btn.innerHTML = `<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M18 8A6 6 0 0 0 6 8c0 7-3 9-3 9h18s-3-2-3-9"/><path d="M13.73 21a2 2 0 0 1-3.46 0"/></svg><span>${on
    ? `Alert on · ${+(ALERT_THRESHOLD_SEC / 60).toFixed(1)} min before bus ${esc(M.svc)} · tap to cancel`
    : `Alert me before bus ${esc(M.svc)} arrives`}</span>`;
}

function _mimTick() {
  if (M.open && !document.hidden) _mimRender();
  _mimCheckNotify();
  _mimRenderPill();
}

// ── Render ────────────────────────────────────────────────
const MIM_STATE = {
  yes:   { tag: "✓ You'll make it",     cls: "yes" },
  now:   { tag: "Leave now",             cls: "now" },
  hurry: { tag: "Only if you hurry",     cls: "hurry" },
  no:    { tag: "✕ You'll miss this one", cls: "no" },
  there: { tag: "✓ You're at the stop",  cls: "yes" },
};

function _mimRender() {
  if (!M.stop) return;
  const hero = $("mim-hero"), tl = $("mim-timeline"), facts = $("mim-facts");
  const evals = _mimEvals();

  // Location line
  const loc = $("mim-loc");
  const walkM = _mimWalkM();
  let locHtml;
  if (M.locErr && !M.pos) {
    locHtml = `<span class="mim-loc-txt warn">${esc(M.locErr)}</span>
      <span class="mim-loc-btns"><button data-mim-act="retry">Try again</button>${getHome() ? `<button data-mim-act="home">Use Home</button>` : ""}</span>`;
  } else if (!M.pos) {
    locHtml = `<span class="mim-loc-txt"><span class="mim-pulse"></span>Finding your location…</span>
      ${getHome() ? `<span class="mim-loc-btns"><button data-mim-act="home">Use Home</button></span>` : ""}`;
  } else if (M.usingHome) {
    locHtml = `<span class="mim-loc-txt">From your Home location</span>
      <span class="mim-loc-btns"><button data-mim-act="gps">Use GPS</button></span>`;
  } else {
    const age = Math.round((Date.now() - M.posTs) / 1000);
    const acc = M.posAcc ? ` · ±${Math.round(M.posAcc)} m` : "";
    locHtml = `<span class="mim-loc-txt"><span class="mim-live"></span>Live location${acc} · ${age < 5 ? "just now" : `${age}s ago`}</span>
      ${getHome() ? `<span class="mim-loc-btns"><button data-mim-act="home">Use Home</button></span>` : ""}`;
  }
  if (loc._html !== locHtml) { loc._html = locHtml; loc.innerHTML = locHtml; }

  // Hero + timeline
  let heroHtml, tlHtml = "", factsHtml = "";
  if (M.stopLat == null) {
    heroHtml = `<div class="mim-verdict wait"><div class="mim-big">No stop location</div>
      <div class="mim-hint">This stop has no coordinates, so walk time can't be worked out.</div></div>`;
  } else if (!M.loaded) {
    heroHtml = M.loadErr
      ? `<div class="mim-verdict wait"><div class="mim-big">Couldn't load buses</div><div class="mim-hint">${esc(M.loadErr)}</div></div>`
      : `<div class="mim-verdict wait"><div class="mim-big mim-skel">Checking…</div></div>`;
  } else if (!M.buses.length) {
    heroHtml = `<div class="mim-verdict no"><span class="mim-tag">No buses</span>
      <div class="mim-big">No ${esc(M.svc)} coming</div><div class="mim-hint">No upcoming arrivals at this stop right now.</div></div>`;
  } else if (!evals) {
    heroHtml = `<div class="mim-verdict wait"><div class="mim-big mim-skel">Locating you…</div>
      <div class="mim-hint">We need your location to work out the walk.</div></div>`;
  } else if (!evals.length) {
    heroHtml = `<div class="mim-verdict no"><span class="mim-tag">No buses</span>
      <div class="mim-big">Nothing catchable</div></div>`;
  } else {
    const e = _mimPick(evals, M.target);
    const st = MIM_STATE[e.state];
    const firstOk = evals.find((x) => x.state !== "no");
    let big, hint;
    if (e.state === "yes") {
      big = `Leave in <b>${_mimCountdown(e.leaveIn)}</b>`;
      hint = `Leave by ${fmtClock(new Date(Date.now() + e.leaveIn * 1000))} · ${_mimMinsHalf(_mimCushion())} to spare at the stop`;
      if (_mimCushion() > M.early) hint += `<br><span class="mim-skip">Includes ${_mimMinsHalf(_mimCushion() - M.early)} extra: this route's timing varies</span>`;
      const skipped = !M.target && evals[0] !== e && evals[0].state === "no";
      if (skipped) hint += `<br><span class="mim-skip">The ${fmtClock(evals[0].at)} bus comes too soon to catch</span>`;
    } else if (e.state === "now") {
      big = `<b>Go now</b>`;
      hint = `A normal walk gets you there ${_mimMins(e.busIn - e.walkS)} early`;
    } else if (e.state === "hurry") {
      big = `<b>Walk fast</b>`;
      const slack = Math.round(e.briskSlack);
      hint = `A brisk walk gets you there ${slack >= 60 ? _mimMins(slack) : `${slack}s`} before it`;
    } else if (e.state === "there") {
      big = e.busIn < DUE_SECS ? `<b>Arriving</b>` : `Bus in <b>${_mimCountdown(e.busIn)}</b>`;
      hint = `Bus at ${fmtClock(e.at)}`;
    } else {
      big = `<b>Too late</b>`;
      hint = firstOk && firstOk !== e
        ? `Next one you can catch: ${fmtClock(firstOk.at)}`
        : `You're about ${_mimMins(e.walkS)} away; it arrives in ${_mimMins(e.busIn)}`;
    }
    heroHtml = `<div class="mim-verdict ${st.cls}">
      <span class="mim-tag">${st.tag}</span>
      <div class="mim-big">${big}</div>
      <div class="mim-hint">${hint}</div></div>`;

    if (e.state !== "there" && e.busIn > 0) {
      const span = Math.max(e.busIn, 1);
      const pct = (sec) => Math.min(100, Math.max(0, sec / span * 100));
      const late = e.leaveIn < 0;
      const leaveS = Math.max(0, e.leaveIn);
      const atStopS = leaveS + e.walkS;              // arrival on foot
      const leavePct = pct(leaveS), stopPct = pct(atStopS);
      tlHtml = `
        <div class="mim-track ${st.cls}">
          <div class="mim-seg-wait" style="width:${leavePct}%"></div>
          <div class="mim-seg-walk" style="left:${leavePct}%;width:${stopPct - leavePct}%"></div>
          <div class="mim-seg-spare" style="left:${stopPct}%;width:${100 - stopPct}%"></div>
          <span class="mim-node now" style="left:0%"></span>
          <span class="mim-node leave" style="left:${leavePct}%"></span>
          ${atStopS < e.busIn ? `<span class="mim-node stop" style="left:${stopPct}%"></span>` : ""}
          <span class="mim-node bus" style="left:100%"></span>
        </div>
        <div class="mim-tl-labels">
          <span><b>Now</b>${fmtClock(new Date())}</span>
          <span class="mid"><b>Leave</b>${late ? "now" : fmtClock(new Date(Date.now() + leaveS * 1000))}</span>
          <span class="mid"><b>At stop</b>${fmtClock(new Date(Date.now() + atStopS * 1000))}</span>
          <span class="end"><b>Bus ${esc(M.svc)}</b>${fmtClock(e.at)}</span>
        </div>`;
    }

    const dist = walkM;
    const distTxt = dist >= 1000 ? `${(dist / 1000).toFixed(1)} km` : `${Math.round(dist / 10) * 10} m`;
    factsHtml = `
      <span class="mim-fact"><svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><circle cx="13" cy="4" r="2"/><path d="m7 21 3-6 3 2v5"/><path d="M8 11.5 10.5 8l4 2 2.5 3"/></svg>${e.state === "there" ? "At the stop" : `${_mimMins(e.walkS)} walk · ${distTxt}`}</span>
      ${M.mae != null ? `<span class="mim-fact"><svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"><circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/></svg>AI accurate to ${esc(accBand(M.mae))}</span>` : ""}`;

    // Bus chips: rebuilt only when the list, states or selection change, so a
    // tap never lands on a node that was swapped out mid-press.
    const picked = e;
    const key = evals.map((x) => `${x.b.api_arrival}:${x.state}:${x === picked}:${Math.round(x.busIn / 60)}`).join("|");
    if (key !== M.busesKey) {
      M.busesKey = key;
      $("mim-buses").innerHTML = evals.map((x) => `
        <button class="mim-bus ${MIM_STATE[x.state].cls}${x === picked ? " sel" : ""}" data-mim-bus="${esc(x.b.api_arrival || "")}">
          <span class="mim-bus-t">${fmtClock(x.at)}</span>
          <span class="mim-bus-s"><i></i>${x.busIn < DUE_SECS ? "now" : `in ${_mimMins(x.busIn)}`}</span>
        </button>`).join("");
    }
  }
  if (!evals?.length) { M.busesKey = ""; $("mim-buses").innerHTML = ""; }
  hero.innerHTML = heroHtml;
  tl.innerHTML = tlHtml;
  if (facts._html !== factsHtml) { facts._html = factsHtml; facts.innerHTML = factsHtml; }
  _mimRenderNotifyBtn(evals);
}

function _mimTracked() {
  const n = M.notify;
  if (!n || n.stop !== M.stop || n.svc !== M.svc) return null;
  const evals = _mimEvals();
  if (!evals?.length) return null;
  return _mimPick(evals, n.target);
}

function _mimRenderNotifyBtn(evals) {
  const btn = $("mim-notify");
  const e = evals?.length ? _mimPick(evals, M.target) : null;
  const armed = M.notify && M.notify.stop === M.stop && M.notify.svc === M.svc;
  let html, dis = false;
  if (armed) {
    const t = _mimTracked();
    html = t && t.leaveIn > 0
      ? `We'll ping you at ${fmtClock(new Date(Date.now() + t.leaveIn * 1000))} · <u>Cancel</u>`
      : `Ping set · <u>Cancel</u>`;
  } else if (e && e.state === "yes") {
    html = `<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M18 8A6 6 0 0 0 6 8c0 7-3 9-3 9h18s-3-2-3-9"/><path d="M13.73 21a2 2 0 0 1-3.46 0"/></svg> Remind me when to leave`;
  } else {
    html = btn._html || ""; dis = true;
  }
  btn.classList.toggle("armed", !!armed);
  btn.classList.toggle("hidden", dis && !armed);
  if (btn._html !== html) { btn._html = html; btn.innerHTML = html; }
}

function _mimToggleNotify() {
  if (M.notify && M.notify.stop === M.stop && M.notify.svc === M.svc) {
    M.notify = null; toast("Reminder cancelled"); _mimRender(); return;
  }
  const evals = _mimEvals();
  const e = evals?.length ? _mimPick(evals, M.target) : null;
  if (!e || e.state !== "yes") return;
  if ("Notification" in window && Notification.permission === "default") {
    Notification.requestPermission().catch(() => {});
  }
  M.notify = { stop: M.stop, svc: M.svc, target: e.b.api_arrival, fired: false };
  toast("We'll ping you when it's time to leave (keep the app open)");
  _mimRender();
}

function _mimCheckNotify() {
  const n = M.notify;
  if (!n || n.fired) return;
  const t = _mimTracked();
  if (!t) return;
  n.target = t.b.api_arrival;   // follow the bus across refreshes
  if (t.leaveIn <= 0) {
    n.fired = true;
    const title = `Leave now for bus ${n.svc}`;
    const body = `Arrives ${fmtClock(t.at)} at ${M.stopName}`;
    try { navigator.vibrate?.([300, 120, 300]); } catch {}
    toast(`🚶 ${title}`);
    _systemNotify(title, { body, tag: `sgbus-leave-${n.stop}-${n.svc}`, vibrate: [300, 120, 300] });
    setTimeout(() => {
      if (M.notify === n) { M.notify = null; if (!M.open) _mimStopAll(); _mimRenderPill(); if (M.open) _mimRender(); }
    }, 5000);
  }
}

// Floating "Leave in 3:20" pill while a reminder runs with the sheet closed.
function _mimRenderPill() {
  const pill = $("mim-pill");
  if (!pill) return;
  if (M.open || !M.notify) { hide(pill); return; }
  const t = _mimTracked();
  let txt, cls = "yes";
  if (!t) txt = `Bus ${M.notify.svc} · tracking…`;
  else if (t.leaveIn > 0) txt = `Bus ${M.notify.svc} · leave in ${_mimCountdown(t.leaveIn)}`;
  else { txt = `Bus ${M.notify.svc} · leave now`; cls = "now"; }
  const html = `<span class="mim-pill-dot"></span>${esc(txt)}`;
  pill.className = `mim-pill ${cls}`;
  if (pill._html !== html) { pill._html = html; pill.innerHTML = html; }
}

function _mimSyncPace() {
  document.querySelectorAll("#mim-pace [data-pace]").forEach((b) =>
    b.classList.toggle("active", b.dataset.pace === M.pace));
  document.querySelectorAll("#mim-early [data-early]").forEach((b) =>
    b.classList.toggle("active", Number(b.dataset.early) === M.early));
}

$("mim-close").addEventListener("click", closeMim);
$("mim-backdrop").addEventListener("click", closeMim);
$("mim-pill").addEventListener("click", () => {
  const n = M.notify;
  if (!n) return;
  if (S.stop !== n.stop) loadStop(n.stop);
  // Reopen without resetting the tracked bus.
  M.open = true;
  const sheet = $("mim-sheet");
  show($("mim-backdrop")); show(sheet);
  requestAnimationFrame(() => sheet.classList.add("open"));
  M.target = n.target;
  _mimStartLoops(); _mimRender(); _mimRenderPill();
});
$("mim-sheet").addEventListener("click", (ev) => {
  const pace = ev.target.closest("[data-pace]");
  if (pace) {
    M.pace = pace.dataset.pace;
    try { localStorage.setItem(MIM_PACE_KEY, M.pace); } catch {}
    _mimSyncPace(); M.busesKey = ""; _mimRender();
    return;
  }
  const early = ev.target.closest("[data-early]");
  if (early) {
    M.early = Number(early.dataset.early);
    try { localStorage.setItem(MIM_EARLY_KEY, String(M.early)); } catch {}
    _mimSyncPace(); M.busesKey = ""; _mimRender();
    return;
  }
  const bus = ev.target.closest("[data-mim-bus]");
  if (bus) { M.target = bus.dataset.mimBus || null; M.busesKey = ""; _mimRender(); return; }
  const act = ev.target.closest("[data-mim-act]")?.dataset.mimAct;
  if (act === "home") _mimUseHome();
  else if (act === "gps" || act === "retry") {
    if (M.watchId !== null) { navigator.geolocation.clearWatch(M.watchId); M.watchId = null; }
    _mimStartLocation(true); _mimRender();
  }
  if (ev.target.closest("#mim-notify")) _mimToggleNotify();
  if (ev.target.closest("[data-mim-alert]")) { toggleAlert(M.stop, M.svc); _mimRenderMore(); }
});

async function loadStop(code) {
  code = String(code).trim();
  if (!code) return;
  switchView("arrivals");
  // Show arrival detail, hide nearby section; grow the sheet to fit arrivals
  hide($("arr-nearby"));
  show($("arr-detail"));
  _snapSheet("max");
  // Highlight selected pin on the arrivals map
  _arrHighlightPin(code);
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
    // The user may have tapped another stop (or Back) while this request was
    // in flight — rendering now would clobber the newer stop's UI and leak
    // this stop's refresh interval into S.refreshTmr.
    if (S.stop !== code) return;
    S.stopInfo = info;
    S.stats = stats;
    $("stop-name").textContent = info?.description || "Bus stop";
    $("stop-road").textContent = info?.road_name || "";
    renderArrivals(arrivals);
    show($("stats-details"));
    prepareStats(stats);
    syncSaveBtn();
    pushRecent(code, info);
    renderChips();
    location.hash = code;
    S.refreshTmr = setInterval(() => refreshStop(code), REFRESH_MS);
  } catch (err) {
    if (S.stop !== code) return;
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
    // Stale response guard: the user may have switched stops or tapped Back
    // (which nulls S.stop) while this fetch was in flight — rendering would
    // resurrect the dismissed stop's rows and restart its ticker.
    if (S.stop !== code) return;
    renderArrivals(arrivals);
  } catch (err) {
    if (S.stop !== code) return;
    const el = $("arrivals-error");
    el.textContent = `Refresh failed: ${err.message}`;
    show(el);
  } finally {
    $("rows").classList.remove("refreshing");
  }
}

$("refresh-btn").addEventListener("click", () => { if (S.stop) refreshStop(S.stop); });

// ── Share a stop ──────────────────────────────────────────
// Copies a deep link (…/bus?stop=12345) — opening it auto-loads that stop.
// Uses the native share sheet when available, clipboard otherwise.
$("share-stop-btn")?.addEventListener("click", async () => {
  if (!S.stop) return;
  const url  = `${location.origin}${location.pathname}?stop=${S.stop}`;
  const name = S.stopInfo?.description || `stop ${S.stop}`;
  if (navigator.share) {
    try { await navigator.share({ title: `SG Bus — ${name}`, text: `Live bus arrivals for ${name}`, url }); return; }
    catch (e) { if (e && e.name === "AbortError") return; }  // user dismissed — fall through to copy
  }
  try {
    if (!navigator.clipboard) throw new Error("no clipboard");
    await navigator.clipboard.writeText(url);
    toast("Stop link copied to clipboard");
  } catch {
    fallbackCopy(url);  // legacy execCommand path + its own copied toast (defined below)
  }
});

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

// Chart.js (~200 KB) is only needed once someone opens a stats section, so
// it's fetched then instead of on every app start.
let _chartJsP = null;
function _loadChartJs() {
  if (typeof Chart !== "undefined") return Promise.resolve();
  _chartJsP ||= new Promise((resolve, reject) => {
    const s = document.createElement("script");
    s.src = "https://cdn.jsdelivr.net/npm/chart.js@4.4.3/dist/chart.umd.min.js";
    s.integrity = "sha384-JUh163oCRItcbPme8pYnROHQMC6fNKTBWtRG3I3I0erJkzNgL7uxKlNwcrcFKeqF";
    s.crossOrigin = "anonymous";
    s.onload = resolve;
    s.onerror = () => { _chartJsP = null; reject(new Error("Chart.js failed to load")); };
    document.head.appendChild(s);
  });
  return _chartJsP;
}

function renderCharts(stats) {
  if (typeof Chart === "undefined") {
    _loadChartJs().then(() => renderCharts(stats)).catch(() => {});
    return;
  }
  S.chartsDirty = false;
  destroyCharts();
  if (!stats || stats.total_records === 0) {
    show($("no-stats")); hide($("charts-wrap")); hide($("accuracy-scorecard"));
    return;
  }
  hide($("no-stats")); show($("charts-wrap"));

  // ── Accuracy scorecard ──────────────────────────────────────────────
  const acc = stats.accuracy;
  if (acc && acc.samples >= 50) {
    $("acc-lta").textContent = `${acc.lta_pct}%`;
    $("acc-ai").textContent  = `${acc.ai_pct}%`;
    const d = acc.delta_pct;
    const sign = d >= 0 ? "+" : "";
    $("acc-delta").textContent = `${sign}${d}% more accurate with AI`;
    $("acc-delta").style.background = d >= 0 ? "" : "var(--bad-soft)";
    $("acc-delta").style.color      = d >= 0 ? "" : "var(--bad)";
    // Average error in seconds — a fairer read than the ±1 min hit-rate,
    // which can look flat even when the AI is meaningfully closer.
    const maeEl = $("acc-mae");
    if (maeEl && acc.lta_mae_sec != null && acc.ai_mae_sec != null) {
      maeEl.textContent =
        `Average error: LTA ${Math.round(acc.lta_mae_sec)}s · AI ${Math.round(acc.ai_mae_sec)}s`;
      show(maeEl);
    } else if (maeEl) {
      hide(maeEl);
    }
    show($("accuracy-scorecard"));
  } else {
    hide($("accuracy-scorecard"));
  }

  const css = getComputedStyle(document.documentElement);
  const ink  = css.getPropertyValue("--ink").trim();
  const ink2 = css.getPropertyValue("--ink-2").trim();
  const ink3 = css.getPropertyValue("--ink-3").trim();
  const line = css.getPropertyValue("--line").trim();
  const accent = css.getPropertyValue("--accent").trim();
  const good = css.getPropertyValue("--good").trim();
  const warn = css.getPropertyValue("--warn").trim();
  const bad  = css.getPropertyValue("--bad").trim();

  const fmtDelay = (v) => {
    if (v === null || v === undefined) return "no data";
    const a = Math.abs(v);
    if (a < 5) return "on time";
    const m = Math.floor(a / 60), s = Math.round(a % 60);
    const t = m ? `${m}m ${s}s` : `${s}s`;
    return v > 0 ? `${t} late` : `${t} early`;
  };

  // Shared scale/plugin factories
  const yDelayScale = (extra = {}) => ({
    grid: { color: line, drawTicks: false },
    border: { display: false },
    ticks: {
      color: ink3, font: { size: 10 }, padding: 4,
      callback: (v) => v === 0 ? "on time" : `${v > 0 ? "+" : ""}${Math.round(v)}s`,
    },
    ...extra,
  });
  const xScale = (extra = {}) => ({
    grid: { display: false }, border: { display: false },
    ticks: { color: ink3, font: { size: 10 }, padding: 2 },
    ...extra,
  });
  const noLegend = { legend: { display: false } };
  const delayTooltip = {
    displayColors: false,
    backgroundColor: "var(--surface)",
    borderColor: line, borderWidth: 1,
    titleColor: ink, bodyColor: ink2,
    padding: 8, cornerRadius: 6,
    callbacks: {
      label: (i) => ` ${fmtDelay(i.raw)}`,
      afterLabel: (i) => i.dataset.counts ? ` (${i.dataset.counts[i.dataIndex]} observations)` : "",
    },
  };
  const base = {
    responsive: true, maintainAspectRatio: false,
    animation: { duration: 350 },
    plugins: { ...noLegend, tooltip: delayTooltip },
    scales: { y: yDelayScale(), x: xScale() },
  };

  // ── Chart 1: Average delay by route ─────────────────────────────────
  if (stats.by_service?.length) {
    // Sort by absolute delay so the most extreme routes (late AND early) rank high
    const sorted = [...stats.by_service].sort((a, b) =>
      Math.abs(b.avg_delay_sec) - Math.abs(a.avg_delay_sec));
    const counts = sorted.map((s) => s.count);
    const maxCount = Math.max(...counts, 1);

    // Colour: shades of bad/good scaled by magnitude
    const barColors = sorted.map((s) => {
      const d = s.avg_delay_sec;
      if (Math.abs(d) < 15) return ink3;
      return d > 0 ? accent : good;
    });

    $("chart-service-hint").textContent =
      `(${sorted.length} routes · ${stats.total_records.toLocaleString()} total observations)`;

    // bar thickness proportional to observation count (min 40%, max 100%)
    charts.service = new Chart($("chart-service"), {
      type: "bar",
      data: {
        labels: sorted.map((s) => s.service),
        datasets: [{
          data: sorted.map((s) => s.avg_delay_sec),
          backgroundColor: barColors,
          borderRadius: 5,
          counts,
        }],
      },
      options: {
        ...base,
        plugins: {
          ...noLegend,
          tooltip: {
            ...delayTooltip,
            callbacks: {
              title: (items) => `Bus ${items[0].label}`,
              label: (i) => ` Avg: ${fmtDelay(i.raw)}`,
              afterLabel: (i) => {
                const s = sorted[i.dataIndex];
                return [
                  ` Range: ${fmtDelay(s.min_delay_sec)} to ${fmtDelay(s.max_delay_sec)}`,
                  ` On time: ${s.on_time_pct}%`,
                  ` Observations: ${s.count}`,
                ];
              },
            },
          },
        },
        scales: {
          y: yDelayScale({ title: { display: true, text: "seconds", color: ink3, font: { size: 9 } } }),
          x: xScale(),
        },
      },
    });
  }

  // ── Chart 2: On-time rate by route ───────────────────────────────────
  if (stats.by_service?.length) {
    const sorted = [...stats.by_service].sort((a, b) => b.on_time_pct - a.on_time_pct);
    const barColors = sorted.map((s) =>
      s.on_time_pct >= 80 ? good : s.on_time_pct >= 60 ? warn : bad);
    charts.ontime = new Chart($("chart-ontime"), {
      type: "bar",
      data: {
        labels: sorted.map((s) => s.service),
        datasets: [{
          data: sorted.map((s) => s.on_time_pct),
          backgroundColor: barColors,
          borderRadius: 5,
        }],
      },
      options: {
        responsive: true, maintainAspectRatio: false,
        animation: { duration: 350 },
        plugins: {
          ...noLegend,
          tooltip: {
            ...delayTooltip,
            callbacks: {
              title: (items) => `Bus ${items[0].label}`,
              label: (i) => ` ${i.raw}% arrived within ±1 min`,
              afterLabel: (i) => ` Observations: ${sorted[i.dataIndex].count}`,
            },
          },
        },
        scales: {
          y: {
            grid: { color: line, drawTicks: false }, border: { display: false },
            min: 0, max: 100,
            ticks: { color: ink3, font: { size: 10 }, padding: 4,
              callback: (v) => `${v}%` },
            title: { display: true, text: "% on time", color: ink3, font: { size: 9 } },
          },
          x: xScale(),
        },
      },
    });
  }

  // ── Chart 3: Average delay by hour ───────────────────────────────────
  if (stats.by_hour) {
    const isPeak = (h) => (h >= 7 && h < 9) || (h >= 17 && h < 19);
    const noBus  = (h) => h >= 1 && h <= 5;
    // Clean labels: midnight, 6am, noon, 6pm only; others abbreviated
    const hl = (h) => {
      if (h === 0)  return "Midnight";
      if (h === 6)  return "6 am";
      if (h === 12) return "Noon";
      if (h === 18) return "6 pm";
      return h < 12 ? `${h}am` : `${h - 12}pm`;
    };
    const vals = stats.by_hour.map((v, i) => (noBus(i) ? null : v));
    charts.hour = new Chart($("chart-hour"), {
      type: "bar",
      data: {
        labels: Array.from({ length: 24 }, (_, i) => hl(i)),
        datasets: [{
          data: vals,
          backgroundColor: Array.from({ length: 24 }, (_, i) =>
            noBus(i) ? "transparent" : isPeak(i) ? warn : ink2),
          borderRadius: 3,
        }],
      },
      options: {
        ...base,
        plugins: {
          ...noLegend,
          tooltip: {
            ...delayTooltip,
            callbacks: {
              title: (items) => {
                const h = items[0].dataIndex;
                const next = (h + 1) % 24;
                return `${hl(h)} – ${hl(next)}`;
              },
              label: (i) => i.raw === null ? " No service" : ` Avg: ${fmtDelay(i.raw)}`,
              afterLabel: (i) => isPeak(i.dataIndex) ? " ⚡ Peak hour" : "",
            },
          },
          annotation: undefined,
        },
        scales: {
          y: yDelayScale({ title: { display: true, text: "seconds", color: ink3, font: { size: 9 } } }),
          x: xScale({ ticks: { ...xScale().ticks, maxRotation: 0, maxTicksLimit: 8 } }),
        },
      },
    });
  }

  // ── Chart 4: 14-day trend ────────────────────────────────────────────
  if (stats.trend?.length) {
    const vals = stats.trend.map((t) => t.avg_delay_sec).filter((v) => v !== null);
    if (vals.length >= 2) {
      const half = Math.ceil(vals.length / 2);
      const a = vals.slice(0, half).reduce((x, y) => x + y, 0) / half;
      const b = vals.slice(-half).reduce((x, y) => x + y, 0) / half;
      const dir = b < a - 2 ? "↓ improving" : b > a + 2 ? "↑ worsening" : "→ stable";
      $("trend-dir").textContent = `(${dir})`;
    }
    const trendLabels = stats.trend.map((t) =>
      new Date(t.date + "T00:00:00").toLocaleDateString("en-SG",
        { day: "numeric", month: "short", timeZone: "Asia/Singapore" }));

    // Gradient fill: red above 0, green below
    const gradientFill = (ctx) => {
      const grad = ctx.chart.ctx.createLinearGradient(0, 0, 0, ctx.chart.height);
      grad.addColorStop(0, accent + "55");
      grad.addColorStop(1, accent + "00");
      return grad;
    };

    charts.trend = new Chart($("chart-trend"), {
      type: "line",
      data: {
        labels: trendLabels,
        datasets: [{
          data: stats.trend.map((t) => t.avg_delay_sec),
          borderColor: accent,
          backgroundColor: (ctx) => gradientFill(ctx),
          fill: true,
          tension: 0.4, borderWidth: 2,
          pointRadius: 4, pointBackgroundColor: accent,
          pointHoverRadius: 6,
        }],
      },
      options: {
        ...base,
        plugins: {
          ...noLegend,
          tooltip: {
            ...delayTooltip,
            callbacks: {
              title: (items) => trendLabels[items[0].dataIndex],
              label: (i) => ` ${fmtDelay(i.raw)}`,
            },
          },
        },
        scales: {
          y: yDelayScale({ title: { display: true, text: "seconds", color: ink3, font: { size: 9 } } }),
          x: xScale({ ticks: { ...xScale().ticks, maxTicksLimit: 7 } }),
        },
      },
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
    showConfirm("Remove this saved stop?", "Remove", () => {
      removeFav(rm.dataset.remove);
      if (S.stop === rm.dataset.remove) syncSaveBtn();
      toast("Removed");
    });
    return;
  }
  const card = e.target.closest(".saved-card");
  if (card) loadStop(card.dataset.code);
});

$("saved-journeys-list").addEventListener("click", (e) => {
  const rm = e.target.closest("[data-sj-remove]");
  if (rm) {
    showConfirm("Remove this saved route?", "Remove", () => {
      removeJourney(parseInt(rm.dataset.sjRemove));
      toast("Route removed");
    });
    return;
  }
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
  $("data-grid").innerHTML = Array.from({ length: 7 }, () => `<div class="skel" style="height:70px"></div>`).join("");
  // Fire every section's request at once and render each as it lands —
  // these used to run one after another (data → feedback → notifications →
  // analytics → heatmap), so the page took the sum of five round trips.
  const main = (async () => {
    const d = await api("/api/data");
    const cards = [
      ["Today", Number(d.database.records_today ?? 0).toLocaleString(), "snapshots collected"],
      ["Database", d.database.type, ""],
      ["Snapshots", Number(d.database.arrival_records).toLocaleString(), "arrival records"],
      ["Labeled", Number(d.database.labeled_records).toLocaleString(), "with measured delay"],
      ["Stops known", Number(d.database.bus_stops).toLocaleString(), "in directory"],
      ["Model error", `±${d.model.mae_seconds ?? "–"}s`, "mean absolute error"],
      ["Training set", Number(d.model.training_rows).toLocaleString(), "samples"],
    ];
    $("data-grid").innerHTML = cards.map(([l, v, s]) => `
      <div class="stat-card">
        <div class="stat-label">${esc(l)}</div>
        <div class="stat-value">${esc(v)}</div>
        ${s ? `<div class="stat-sub">${esc(s)}</div>` : ""}
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

    // Leaderboards
    const lb = d.leaderboard || {};
    const fmtDelay = (s) => {
      if (s === null || s === undefined) return "–";
      const sign = s > 0 ? "+" : "";
      const abs = Math.abs(s);
      return abs >= 60
        ? `${sign}${(s / 60).toFixed(1)}m`
        : `${sign}${Math.round(s)}s`;
    };
    const medal = (i) => ["🥇","🥈","🥉"][i] ?? `${i+1}`;
    const buses = lb.top_buses || [];
    $("lb-buses-tbody").innerHTML = buses.map((b, i) => `
      <tr>
        <td class="num">${medal(i)}</td>
        <td><strong>${esc(b.service)}</strong></td>
        <td class="num delay-pos">${fmtDelay(b.avg_delay_sec)}</td>
        <td class="num">${b.n.toLocaleString()}</td>
      </tr>`).join("");
    $("leaderboard-block").classList.toggle("hidden", !buses.length);

    const stops = lb.top_stops || [];
    $("lb-stops-tbody").innerHTML = stops.map((s, i) => `
      <tr>
        <td class="num">${medal(i)}</td>
        <td>
          <div style="font-weight:600">${esc(s.stop_name)}</div>
          <div style="font-size:.72rem;color:var(--ink-3)">${esc(s.stop_code)}</div>
        </td>
        <td class="num delay-pos">${fmtDelay(s.avg_delay_sec)}</td>
        <td class="num">${s.n.toLocaleString()}</td>
      </tr>`).join("");
    $("leaderboard-stops-block").classList.toggle("hidden", !stops.length);

  })().catch((err) => {
    $("data-grid").innerHTML = "";
    const el = $("data-error");
    el.textContent = `Couldn't load data: ${err.message}`;
    show(el);
  });

  // Feedback (admin only)
  const feedback = (async () => {
      const fb = await api("/api/feedback?limit=200");
      const items = fb.items || [];
      $("feedback-admin-count").textContent = items.length;
      const fmtDate = (iso) => new Date(iso + "Z").toLocaleString("en-SG", {
        day: "numeric", month: "short", year: "numeric",
        hour: "2-digit", minute: "2-digit", hour12: false, timeZone: "Asia/Singapore",
      });
      const starHtml = (n) => n
        ? `<span class="fb-admin-stars">${"★".repeat(n)}<span class="fb-admin-empty-stars">${"★".repeat(5 - n)}</span></span>`
        : "";
      const list = $("feedback-admin-list");
      if (!items.length) {
        list.innerHTML = `<p class="fb-admin-empty">No feedback yet.</p>`;
      } else {
        list.innerHTML = items.map((f) => `
          <div class="fb-admin-card" data-fbid="${f.id}">
            <div class="fb-admin-top">
              ${starHtml(f.rating)}
              ${f.context ? `<span class="fb-admin-ctx">${esc(f.context)}</span>` : ""}
              <span class="fb-admin-time">${esc(fmtDate(f.submitted_at))}</span>
              <div class="fb-admin-actions">
                ${f.email ? `<a class="fb-admin-reply" href="mailto:${esc(f.email)}?subject=${encodeURIComponent("Re: Your SG Bus feedback")}" title="Reply by email">
                  <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 8l7.89 5.26a2 2 0 0 0 2.22 0L21 8M5 19h14a2 2 0 0 0 2-2V7a2 2 0 0 0-2-2H5a2 2 0 0 0-2 2v10a2 2 0 0 0 2 2z"/></svg>
                </a>` : ""}
                <button class="fb-admin-del" data-del-fb="${f.id}" aria-label="Delete">
                  <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M3 6h18M19 6l-1 14H6L5 6M10 11v6M14 11v6M9 6V4h6v2"/></svg>
                </button>
              </div>
            </div>
            <div class="fb-admin-who">
              ${f.username ? `<strong>${esc(f.username)}</strong>` : `<span class="fb-admin-anon">Anonymous</span>`}
              ${f.email ? `<span class="fb-admin-email">&lt;${esc(f.email)}&gt;</span>` : ""}
            </div>
            ${f.message ? `<div class="fb-admin-msg">${esc(f.message)}</div>` : ""}
            <div class="fb-admin-meta">${esc(f.ip_address || "–")} · ${esc((f.user_agent || "–").slice(0, 80))}</div>
          </div>`).join("");
        // Wire up delete buttons
        list.querySelectorAll("[data-del-fb]").forEach((btn) => {
          btn.addEventListener("click", async () => {
            const id = btn.dataset.delFb;
            if (!confirm("Delete this feedback entry?")) return;
            try {
              await api(`/api/feedback/${id}`, { method: "DELETE" });
              btn.closest(".fb-admin-card").remove();
              const cnt = $("feedback-admin-count");
              cnt.textContent = Math.max(0, parseInt(cnt.textContent || "0") - 1);
            } catch (e) { toast("Could not delete: " + e.message); }
          });
        });
      }
      show($("feedback-admin-block"));
  })().catch(() => { /* not admin or endpoint unavailable */ });

  const notifs = _loadAdminNotifications()
    .then(() => show($("notif-admin-block"))).catch(() => { /* not admin */ });
  const analytics = loadAdminAnalytics()
    .then(() => show($("analytics-block"))).catch(() => { /* not admin */ });
  const heatmap = loadHeatmap()
    .then(() => show($("heatmap-block"))).catch(() => { /* not admin or no data */ });

  await Promise.all([main, feedback, notifs, analytics, heatmap]);
}

// ── Admin analytics dashboard ──────────────────────────────────────────────────

let _analyticsChart = null;

async function loadAdminAnalytics() {
  const [d] = await Promise.all([api("/api/analytics"), _loadChartJs().catch(() => {})]);
  const q = d.queries;
  const u = d.users;
  const fb = d.feedback;

  // Summary metrics row
  const change = q.yesterday > 0
    ? Math.round(((q.today - q.yesterday) / q.yesterday) * 100)
    : null;
  const changeTxt = change === null ? "" :
    `<span class="anlyt-delta ${change >= 0 ? "pos" : "neg"}">${change >= 0 ? "▲" : "▼"}${Math.abs(change)}% vs yesterday</span>`;

  $("anlyt-today").textContent    = q.today.toLocaleString();
  $("anlyt-delta").innerHTML      = changeTxt;
  $("anlyt-week").textContent     = q.week_avg.toLocaleString();
  $("anlyt-users").textContent    = u.total.toLocaleString();
  $("anlyt-sessions").textContent = u.active_sessions_30d.toLocaleString();
  $("anlyt-fb").textContent       = fb.avg_rating ? `${fb.avg_rating}★ (${fb.total})` : fb.total;

  // Breakdown today
  const bd = q.breakdown || {};
  $("anlyt-arrivals").textContent  = (bd.arrivals        || 0).toLocaleString();
  $("anlyt-plans").textContent     = ((bd.journey_plan || 0) + (bd.multimodal_plan || 0)).toLocaleString();

  // 30-day sparkline chart (Chart.js)
  if (typeof Chart !== "undefined") {
    if (_analyticsChart) { _analyticsChart.destroy(); _analyticsChart = null; }
    const canvas = $("anlyt-chart");
    if (canvas) {
      const labels = q.series.map((s) => {
        const d = new Date(s.date + "T00:00:00");
        return d.toLocaleDateString("en-SG", { day: "numeric", month: "short" });
      });
      const counts = q.series.map((s) => s.count);
      const accent = getComputedStyle(document.documentElement).getPropertyValue("--accent").trim() || "#4285f4";
      _analyticsChart = new Chart(canvas, {
        type: "bar",
        data: {
          labels,
          datasets: [{
            data: counts,
            backgroundColor: accent + "55",
            borderColor: accent,
            borderWidth: 1.5,
            borderRadius: 3,
          }],
        },
        options: {
          responsive: true,
          maintainAspectRatio: false,
          plugins: { legend: { display: false }, tooltip: {
            callbacks: { label: (c) => ` ${c.raw.toLocaleString()} queries` },
          }},
          scales: {
            x: { ticks: { maxTicksLimit: 7, maxRotation: 0, font: { size: 10 } }, grid: { display: false } },
            y: { beginAtZero: true, ticks: { maxTicksLimit: 4, font: { size: 10 } } },
          },
        },
      });
    }
  }

  // Query totals by type (today / 7d / 30d / all-time)
  const totals = q.totals || [];
  $("anlyt-query-totals").innerHTML = totals.length
    ? totals.map((t) => `
        <tr>
          <td>${esc(t.label)}</td>
          <td class="num">${t.today.toLocaleString()}</td>
          <td class="num">${t.d7.toLocaleString()}</td>
          <td class="num">${t.d30.toLocaleString()}</td>
          <td class="num"><strong>${t.all.toLocaleString()}</strong></td>
        </tr>`).join("")
    : `<tr><td colspan="5" style="color:var(--ink-3)">No data yet</td></tr>`;

  // Users summary line
  const prov = u.by_provider || {};
  const provBits = Object.entries(prov).map(([k, v]) => `${v} ${k}`).join(" · ");
  $("anlyt-users-summary").innerHTML =
    `<strong>${u.total.toLocaleString()}</strong> total · ` +
    `<strong>${(u.new_7d || 0).toLocaleString()}</strong> new this week · ` +
    `<strong>${(u.new_30d || 0).toLocaleString()}</strong> new this month` +
    (provBits ? `<br><span style="color:var(--ink-3)">${esc(provBits)}</span>` : "");

  // Top stops
  const tops = d.top_stops || [];
  const maxCount = tops[0]?.count || 1;
  $("anlyt-top-stops").innerHTML = tops.length
    ? tops.map((s, i) => `
        <div class="anlyt-stop-row">
          <span class="anlyt-stop-rank">${i + 1}</span>
          <div class="anlyt-stop-info">
            <div class="anlyt-stop-name">${esc(s.name || s.stop_code)}</div>
            <div class="anlyt-stop-bar-wrap">
              <div class="anlyt-stop-bar" style="width:${Math.round((s.count / maxCount) * 100)}%"></div>
            </div>
          </div>
          <span class="anlyt-stop-count">${s.count.toLocaleString()}</span>
        </div>`).join("")
    : `<p style="color:var(--ink-3);font-size:.85rem;margin:0">No queries yet this week</p>`;

  // User list
  const users = u.list || [];
  const fmtDay = (iso) => {
    if (!iso) return "–";
    return new Date(iso + "Z").toLocaleDateString("en-SG", {
      day: "numeric", month: "short", year: "2-digit", timeZone: "Asia/Singapore",
    });
  };
  const relDays = (iso) => {
    if (!iso) return "never";
    const days = Math.floor((Date.now() - new Date(iso + "Z").getTime()) / 86400000);
    if (days <= 0) return "today";
    if (days === 1) return "1d ago";
    if (days < 30) return `${days}d ago`;
    return fmtDay(iso);
  };
  $("anlyt-users-list").innerHTML = users.length
    ? users.map((usr) => `
        <tr>
          <td>
            <div class="anlyt-user-name">${esc(usr.username)}${usr.is_admin ? ' <span class="anlyt-user-admin">admin</span>' : ""}</div>
            ${usr.email ? `<div class="anlyt-user-email">${esc(usr.email)}</div>` : ""}
          </td>
          <td><span class="anlyt-prov anlyt-prov-${esc(usr.auth_provider)}">${esc(usr.auth_provider === "google" ? "Google" : "Pw")}</span></td>
          <td>${fmtDay(usr.created_at)}</td>
          <td>${relDays(usr.last_seen)}</td>
          <td class="num">${usr.favourites}★ / ${usr.journeys}⤳</td>
        </tr>`).join("")
    : `<tr><td colspan="5" style="color:var(--ink-3)">No registered users yet</td></tr>`;
}

// ── Punctuality heatmap (admin) ────────────────────────────────────────────────

async function loadHeatmap() {
  const d = await api("/api/analytics/heatmap");
  renderHeatmap(d);
}

// Map an average delay (seconds) to a cell colour: green = early, neutral =
// on time, red = late, intensity scaling with magnitude (clamped at ±2 min).
function _heatColor(avg) {
  if (Math.abs(avg) < 10) return "rgba(34,197,94,.32)";  // near on-time: clear green baseline
  const mag = Math.min(Math.abs(avg), 120) / 120;        // 0..1
  const a = (0.34 + 0.56 * mag).toFixed(2);
  return avg > 0 ? `rgba(220,38,38,${a})` : `rgba(34,197,94,${a})`;
}

function renderHeatmap(d) {
  const grid = $("heatmap-grid");
  if (!grid) return;
  const DAYS = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];
  if (!d || !d.total_records) {
    grid.innerHTML = `<p class="empty" style="grid-column:1/-1">No ground-truth records yet — the heatmap fills in as buses are tracked.</p>`;
    return;
  }
  let html = `<div class="heatmap-corner"></div>`;
  for (let h = 0; h < 24; h++) {
    html += `<div class="heatmap-hour">${h % 3 === 0 ? h : ""}</div>`;
  }
  d.grid.forEach((row, di) => {
    html += `<div class="heatmap-day">${DAYS[di]}</div>`;
    row.forEach((cell, h) => {
      if (!cell) { html += `<div class="heatmap-cell empty"></div>`; return; }
      const sign = cell.avg > 0 ? "+" : "";
      html += `<div class="heatmap-cell" style="background:${_heatColor(cell.avg)}"
        title="${DAYS[di]} ${String(h).padStart(2, "0")}:00 · ${sign}${Math.round(cell.avg)}s avg · ${cell.n.toLocaleString()} obs"></div>`;
    });
  });
  grid.innerHTML = html;
}

// ── Admin notifications ────────────────────────────────────────────────────────

async function _loadAdminNotifications() {
  const data = await api("/api/notifications");
  const items = data.items || [];
  const fmtDate = (iso) => new Date(iso + "Z").toLocaleString("en-SG", {
    day: "numeric", month: "short", year: "numeric",
    hour: "2-digit", minute: "2-digit", hour12: false, timeZone: "Asia/Singapore",
  });
  const adminList = $("notif-admin-list");
  adminList.innerHTML = items.length
    ? items.map((n) => `
        <div class="notif-admin-item" data-nid="${n.id}">
          <div class="notif-admin-meta">
            <span class="notif-admin-level notif-level-${esc(n.level)}">${esc(n.level)}</span>
            <strong>${esc(n.title)}</strong>
            <span class="fb-admin-time">${esc(fmtDate(n.created_at))}</span>
            <button class="notif-admin-push" data-push-notif="${n.id}" title="Push to popup" aria-label="Push to popup">
              <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M6 8a6 6 0 0 1 12 0c0 7 3 9 3 9H3s3-2 3-9"/><path d="M10.3 21a1.94 1.94 0 0 0 3.4 0"/></svg>
              Popup
            </button>
            <button class="fb-admin-del" data-del-notif="${n.id}" aria-label="Delete">
              <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M3 6h18M19 6l-1 14H6L5 6M10 11v6M14 11v6M9 6V4h6v2"/></svg>
            </button>
          </div>
          ${n.body ? `<div class="notif-admin-body">${esc(_notifParts(n.body).text)}</div>` : ""}
        </div>`).join("")
    : `<p class="fb-admin-empty">No notifications sent yet.</p>`;

  adminList.querySelectorAll("[data-del-notif]").forEach((btn) => {
    btn.addEventListener("click", async () => {
      const id = btn.dataset.delNotif;
      try {
        await api(`/api/notifications/${id}`, { method: "DELETE" });
        btn.closest(".notif-admin-item").remove();
      } catch (e) { toast("Could not delete: " + e.message); }
    });
  });

  // "Push to popup" — re-broadcast this notice so it pops for everyone again.
  adminList.querySelectorAll("[data-push-notif]").forEach((btn) => {
    btn.addEventListener("click", async () => {
      const id = btn.dataset.pushNotif;
      btn.disabled = true;
      try {
        await api(`/api/notifications/${id}/popup`, { method: "POST" });
        toast("Pushed — it'll pop up for everyone on next open");
      } catch (e) { toast("Could not push: " + e.message); btn.disabled = false; }
    });
  });
}

$("notif-create-form")?.addEventListener("submit", async (e) => {
  e.preventDefault();
  const title = $("notif-title").value.trim();
  const body  = $("notif-body").value.trim() || null;
  const level = $("notif-level").value;
  if (!title) return;
  try {
    await api("/api/notifications", {
      method: "POST",
      body: JSON.stringify({ title, body, level }),
    });
    $("notif-title").value = "";
    $("notif-body").value = "";
    toast("Notification sent!");
    await _loadAdminNotifications();
  } catch (e) { toast("Failed: " + e.message); }
});

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
    if (field === "from") _updatePlanHomeChip();
    clearTimeout(acTmr);
    acTmr = setTimeout(async () => {
      if (!v || v.length < 2) { hide(ac); ac.innerHTML = ""; return; }
      const [stops, places] = await Promise.all([
        api(`/api/stops/search?q=${encodeURIComponent(v)}&limit=5`).catch(() => localStopSearch(v, 5)),
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
    clearSel();
    if (field === "from") _updatePlanHomeChip();
    input.focus();
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
  if (field === "from") _updatePlanHomeChip();
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
  _updatePlanHomeChip();
});

$("plan-set-home-chip").addEventListener("click", () => {
  if (planState.fromLat === null) { toast("Set a FROM location first"); return; }
  saveHome(planState.fromName, planState.fromLat, planState.fromLng);
  toast(`Home set to ${planState.fromName}`);
});

$("plan-btn").addEventListener("click", doJourneyPlan);

// Departure-time control: Now / Today / Tomorrow selector.
(() => {
  const t = $("plan-time"), day = $("plan-day");
  if (!t || !day) return;
  const wrap = t.closest(".plan-time-wrap");

  const applyMode = () => {
    const isNow = day.value === "now";
    wrap?.classList.toggle("now-mode", isNow);
    if (isNow) t.value = "";
  };

  day.addEventListener("change", () => {
    // Switching away from Now: pre-fill with current time as a starting point.
    if (day.value !== "now" && !t.value) {
      const n = new Date();
      t.value = `${String(n.getHours()).padStart(2,"0")}:${String(n.getMinutes()).padStart(2,"0")}`;
    }
    applyMode();
  });
  t.addEventListener("input", () => {
    if (t.value && day.value === "now") day.value = "0";
    applyMode();
  });

  applyMode();
})();
$("plan-results").addEventListener("click", (e) => {
  const go = e.target.closest(".jcard-go");
  if (go) {
    const card = go.closest(".journey-card");
    const nowOpen = card.classList.toggle("open");
    if (nowOpen && _planData && _planCoords) {
      const idx = parseInt(card.dataset.optIndex, 10);
      if (!isNaN(idx)) _openCardMap(card, _planData, _planCoords, idx);
    }
    return;
  }

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

// Build the &depart_at=… query suffix when a future time is set, else "".
function _departQueryParam() {
  const timeVal = $("plan-time")?.value; // "HH:MM" or ""
  if (!timeVal || $("plan-day")?.value === "now") return "";
  const dayOffset = parseInt($("plan-day")?.value || "0", 10);
  const [h, m] = timeVal.split(":").map(Number);
  // Build local-time Date for today+offset at chosen time (local clock = SGT for SG)
  const d = new Date();
  d.setDate(d.getDate() + dayOffset);
  d.setHours(h, m, 0, 0);
  if (d.getTime() <= Date.now() + 3 * 60000) return ""; // not meaningfully future
  const pad = n => String(n).padStart(2, "0");
  const iso = `${d.getFullYear()}-${pad(d.getMonth()+1)}-${pad(d.getDate())}T${pad(h)}:${pad(m)}`;
  return `&depart_at=${encodeURIComponent(iso)}`;
}

// Banner shown above results when planning for a future time.
function _futureBanner(d) {
  if (!d?.is_future || !d.planned_for) return "";
  let txt = d.planned_for;
  try {
    txt = new Date(d.planned_for).toLocaleString("en-SG", {
      weekday: "short", day: "numeric", month: "short", hour: "numeric", minute: "2-digit",
    });
  } catch {}
  return `<div class="plan-future-note">
      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/></svg>
      Planned for <b>${esc(txt)}</b> · live bus waits aren't shown for future trips — times are schedule estimates
    </div>`;
}

async function doJourneyPlan() {
  const { fromCode, fromLat, fromLng, fromName,
          toCode,   toLat,   toLng,   toName } = planState;

  const hasFrom = fromCode || (fromLat !== null);
  const hasTo   = toCode   || (toLat   !== null);
  if (!hasFrom || !hasTo) { toast("Select both a From and To location first"); return; }

  const err  = $("plan-error");
  const res  = $("plan-results");
  const load = $("plan-loading");
  // Dispose per-card Leaflet maps before wiping the DOM — L.map registers a
  // window resize listener, so discarded maps (tiles, layers, containers)
  // stay reachable forever without an explicit remove().
  res.querySelectorAll(".journey-card").forEach((card) => {
    try { card._jmap?.remove(); } catch {}
  });
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

    const departParam = _departQueryParam();
    let planData = null;
    if (fLat !== null && tLat !== null) {
      planData = await api(
        `/api/journey/multimodal?from_lat=${fLat}&from_lng=${fLng}` +
        `&to_lat=${tLat}&to_lng=${tLng}` +
        `&from_name=${encodeURIComponent(fromName || "Origin")}` +
        `&to_name=${encodeURIComponent(toName || "Destination")}` +
        departParam
      );
      res.innerHTML = _futureBanner(planData) + renderMultimodalResult(planData);
    } else if (fromCode && toCode) {
      planData = await api(
        `/api/journey/plan?from_code=${encodeURIComponent(fromCode)}&to_code=${encodeURIComponent(toCode)}` +
        departParam
      );
      res.innerHTML = _futureBanner(planData) + renderBusOnlyResult(planData);
    } else {
      err.textContent = "Couldn't resolve location. Try a more specific address or bus stop.";
      show(err);
    }
    if (planData) {
      updatePlanMap(planData, { fLat, fLng, tLat, tLng, fromName, toName });
      updateShareUrl();
    }
    updateJourneyCardSaveBtns();
    pushRecentPlan();
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

// NOTE: distinct name from pushRecent(code, info) above — two top-level
// declarations of the same name would silently shadow the stop-recents one.
function pushRecentPlan() {
  const { fromName, fromLat, fromLng, fromCode, toName, toLat, toLng, toCode } = planState;
  if (!fromName || !toName) return;
  const list = readJSON(RECENTS_KEY, []).filter(
    (r) => !(r.fromName === fromName && r.toName === toName)
  );
  list.unshift({ fromName, fromLat, fromLng, fromCode, toName, toLat, toLng, toCode });
  writeJSON(RECENTS_KEY, list.slice(0, 5));
  renderRecents();
}

function removeRecentPlan(i) {
  const list = readJSON(RECENTS_KEY, []);
  list.splice(i, 1);
  writeJSON(RECENTS_KEY, list);
  renderRecents();
}

function renderRecents() {
  const box = $("plan-recents");
  if (!box) return;
  const list = readJSON(RECENTS_KEY, []);
  if (!list.length) { box.classList.add("hidden"); return; }
  box.innerHTML = `<span class="recents-label">Recent</span>` + list.map((r, i) => `
    <div class="recent-chip-wrap">
      <button class="recent-chip" data-i="${i}">
        ${esc(r.fromName)} <span class="recent-arrow">→</span> ${esc(r.toName)}
      </button>
      <button class="recent-chip-del" data-del="${i}" aria-label="Remove">×</button>
    </div>`).join("");
  box.classList.remove("hidden");
}

$("plan-recents")?.addEventListener("click", (e) => {
  const del = e.target.closest(".recent-chip-del");
  if (del) { removeRecentPlan(+del.dataset.del); return; }
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

function renderBusOnlyCard(opt, idx = 0) {
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
    <div class="journey-card" data-opt-index="${idx}"
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
      <div class="jcard-detail">${detailHtml}<div class="jcard-map-wrap"><div class="jcard-map"></div></div></div>
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
    .filter((l) => l.type === "bus" || l.type === "mrt" || l.service_no)
    .map((l) => l.type === "mrt"
      ? `<span class="jcard-badge mrt-badge" style="opacity:.45">${esc(l.line || "MRT")}</span>`
      : `<span class="jcard-badge" style="opacity:.45">${esc(l.service_no)}</span>`)
    .join("") || `<span class="jcard-badge" style="opacity:.45">${esc(opt.mode === "mrt" ? "MRT" : "Bus")}</span>`;
  return `
    <div class="journey-card unavailable-card">
      <div class="jcard-summary">
        <div class="jcard-routes">${badgesHtml}</div>
        <div class="jcard-meta">
          <span class="unavail-reason">${esc(opt.unavailable_reason || "Not running right now")}</span>
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

function renderMultimodalCard(opt, idx = 0) {
  const active = opt.legs.filter((l) => l.type !== "walk");
  const ARROW = `<svg class="jcard-arrow" width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round"><path d="m9 18 6-6-6-6"/></svg>`;
  const mkBadge = (l) => l.type === "mrt"
    ? `<span class="jcard-badge mrt-badge" style="border-color:${esc(l.line_color)};color:${esc(l.line_color)}">${esc(l.line)}</span>`
    : `<span class="jcard-badge">${esc(l.service_no)}</span>`;
  let badgesHtml;
  if (!active.length) {
    badgesHtml = `<span class="jcard-badge jcard-walk-only">Walk</span>`;
  } else if (active.length <= 3) {
    badgesHtml = active.map((l, i, a) => mkBadge(l) + (i < a.length - 1 ? ARROW : "")).join("");
  } else {
    badgesHtml = mkBadge(active[0]) + ARROW
      + `<span class="jcard-badge jcard-more">+${active.length - 2}</span>` + ARROW
      + mkBadge(active[active.length - 1]);
  }

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
    <div class="journey-card" data-opt-index="${idx}"
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
      <div class="jcard-detail">${detailHtml}<div class="jcard-map-wrap"><div class="jcard-map"></div></div></div>
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
    <div class="journey-leg mrt-leg" style="--leg-color:${esc(leg.line_color)}">
      <div class="leg-top">
        <span class="leg-route mrt-route" style="border-color:${esc(leg.line_color)};color:${esc(leg.line_color)}">${esc(leg.line)}</span>
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
    <div class="journey-leg bus-leg">
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

// Backend reachability → full-screen maintenance page. The health check resolves
// whenever the FastAPI process answers (even an error status), and rejects only
// when the box / Tailscale tunnel is unreachable or times out — exactly the
// "service is down / restarting" case the maintenance page is for.
let _backendDown    = false;
let _backendRetryTmr = null;
let _backendChecking = false;

async function checkBackend() {
  if (_backendChecking) return !_backendDown;
  _backendChecking = true;
  let ok = false;
  try {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), 6000);
    const r = await fetch(API_BASE + "/api/health", { signal: ctrl.signal, cache: "no-store" });
    clearTimeout(t);
    ok = r.ok;
  } catch { ok = false; }
  _backendChecking = false;
  setBackendStatus(ok);
  return ok;
}

function setBackendStatus(ok) {
  const overlay = $("maintenance-overlay");
  if (ok) {
    const wasDown = _backendDown;
    _backendDown = false;
    hide(overlay);
    document.body.classList.remove("maintenance-open");
    if (_backendRetryTmr) { clearInterval(_backendRetryTmr); _backendRetryTmr = null; }
    // Recovered mid-session: re-pull account state and any open stop quietly.
    if (wasDown) {
      hydrateServerFavs();
      loadNotifications();
      if (S.stop) refreshStop(S.stop);
    }
  } else {
    _backendDown = true;
    show(overlay);
    document.body.classList.add("maintenance-open");
    const txt = $("maintenance-status-txt");
    if (txt) txt.textContent = "Reconnecting…";
    // Keep probing so the page dismisses itself the moment the backend is back.
    if (!_backendRetryTmr) _backendRetryTmr = setInterval(checkBackend, 15000);
  }
}

$("maintenance-retry")?.addEventListener("click", async () => {
  const btn = $("maintenance-retry");
  const txt = $("maintenance-status-txt");
  btn.disabled = true;
  if (txt) txt.textContent = "Checking…";
  const ok = await checkBackend();
  if (!ok && txt) txt.textContent = "Still offline — retrying automatically…";
  btn.disabled = false;
});

// ── Change password ───────────────────────────────────────
function _clearPwForm() {
  ["pw-current", "pw-new", "pw-confirm"].forEach((id) => {
    const el = $(id);
    if (el) { el.value = ""; el.type = "password"; }
  });
  const hint = $("pw-match-hint");
  if (hint) { hint.textContent = ""; hint.className = "pw-match-hint hidden"; }
  const err = $("pw-error");
  if (err) hide(err);
}

document.querySelectorAll(".pw-eye").forEach((btn) => {
  btn.addEventListener("click", () => {
    const input = $(btn.dataset.target);
    if (!input) return;
    const shown = input.type === "text";
    input.type = shown ? "password" : "text";
    btn.setAttribute("aria-label", shown ? "Show password" : "Hide password");
    if (shown) {
      btn.innerHTML = `<svg xmlns="http://www.w3.org/2000/svg" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/><circle cx="12" cy="12" r="3"/></svg>`;
    } else {
      btn.innerHTML = `<svg xmlns="http://www.w3.org/2000/svg" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M17.94 17.94A10.07 10.07 0 0 1 12 20c-7 0-11-8-11-8a18.45 18.45 0 0 1 5.06-5.94M9.9 4.24A9.12 9.12 0 0 1 12 4c7 0 11 8 11 8a18.5 18.5 0 0 1-2.16 3.19m-6.72-1.07a3 3 0 1 1-4.24-4.24"/><line x1="1" y1="1" x2="23" y2="23"/></svg>`;
    }
  });
});

$("pw-confirm")?.addEventListener("input", () => {
  const nw   = $("pw-new")?.value || "";
  const conf = $("pw-confirm")?.value || "";
  const hint = $("pw-match-hint");
  if (!hint) return;
  if (!conf) { hint.textContent = ""; hint.className = "pw-match-hint hidden"; return; }
  if (conf === nw) {
    hint.textContent = "Passwords match";
    hint.className = "pw-match-hint match";
  } else {
    hint.textContent = "Passwords don't match";
    hint.className = "pw-match-hint mismatch";
  }
});

$("pw-cancel-btn")?.addEventListener("click", () => {
  const details = document.querySelector(".pw-change");
  if (details) details.open = false;
  _clearPwForm();
});

$("pw-change-btn")?.addEventListener("click", async () => {
  const cur  = $("pw-current")?.value.trim() || "";
  const nw   = $("pw-new")?.value || "";
  const conf = $("pw-confirm")?.value || "";
  const err  = $("pw-error");
  const btn  = $("pw-change-btn");
  hide(err);
  if (!cur) {
    err.textContent = "Please enter your current password."; show(err); return;
  }
  if (nw.length < 8) {
    err.textContent = "New password must be at least 8 characters."; show(err); return;
  }
  if (nw !== conf) {
    err.textContent = "New passwords don't match."; show(err); return;
  }
  btn.disabled = true; btn.textContent = "Saving…";
  try {
    await api("/api/auth/change-password", {
      method: "POST",
      body: JSON.stringify({ current_password: cur, new_password: nw }),
    });
    const details = document.querySelector(".pw-change");
    if (details) details.open = false;
    _clearPwForm();
    toast("Password changed — signing you out…");
    setTimeout(() => {
      clearAuth();
      setTimeout(() => openSheet(), 400);
    }, 1800);
  } catch (e) {
    err.textContent = e.message || "Couldn't update password.";
    show(err);
    btn.disabled = false; btn.textContent = "Save";
  }
});

// ── Display name ──────────────────────────────────────────
// The name the app greets you by. Separate from the login handle (which is
// [A-Za-z0-9_] only), so it can hold spaces and real punctuation.
function _openNameEdit() {
  const form = $("name-edit-form");
  if (!form) return;
  $("name-input").value = S.displayName || "";
  hide($("name-error"));
  show(form);
  $("name-input").focus();
  $("name-input").select();
}

function _closeNameEdit() {
  hide($("name-edit-form"));
  hide($("name-error"));
}

$("name-edit-btn")?.addEventListener("click", () => {
  const form = $("name-edit-form");
  if (form && !form.classList.contains("hidden")) _closeNameEdit();
  else _openNameEdit();
});

$("name-cancel-btn")?.addEventListener("click", _closeNameEdit);

$("name-input")?.addEventListener("keydown", (e) => {
  if (e.key === "Enter") { e.preventDefault(); $("name-save-btn").click(); }
  if (e.key === "Escape") { e.preventDefault(); _closeNameEdit(); }
});

$("name-save-btn")?.addEventListener("click", async () => {
  const input = $("name-input");
  const err   = $("name-error");
  const btn   = $("name-save-btn");
  const name  = (input.value || "").trim().replace(/\s+/g, " ");
  hide(err);
  if (name && name.length < 2) {
    err.textContent = "Name must be at least 2 characters."; show(err); return;
  }
  btn.disabled = true; btn.textContent = "Saving…";
  try {
    const res = await api("/api/auth/display-name", {
      method: "POST",
      body: JSON.stringify({ display_name: name }),
    });
    S.displayName = res.display_name || null;
    if (S.displayName) localStorage.setItem(DISPLAY_KEY, S.displayName);
    else localStorage.removeItem(DISPLAY_KEY);
    syncAccountUI();
    _closeNameEdit();
    toast(name ? `Name updated to ${res.effective_name}` : "Name reset");
  } catch (e) {
    err.textContent = e.message || "Couldn't update name.";
    show(err);
  } finally {
    btn.disabled = false; btn.textContent = "Save";
  }
});

// ── Arrivals map ──────────────────────────────────────────
let _arrMap       = null;
let _cpMap        = null;   // Carpark tab map (see the Carpark section)
let _mrtMap       = null;   // MRT tab map (see the MRT section)
let _arrLocMarker = null;
let _arrPinStore  = new Map(); // code → { marker, label }

function _syncTopbarH() { /* topbar removed */ }

// ── Draggable bottom sheet ────────────────────────────────
function _setSheetH(px) {
  document.documentElement.style.setProperty("--sheet-h", Math.round(px) + "px");
  // The locate button rides on top of the sheet; when the sheet is pulled up
  // high it would sit over the search bar, so it's hidden there.
  document.documentElement.classList.toggle("sheet-high", px > innerHeight * 0.62);
}
// Compute the three snap heights in px. The max is capped so the sheet's top
// always stays just below the floating search bar — otherwise it swallows the
// search bar and the drag handle becomes unreachable.
// The Arrivals and Carpark tabs each have a map + sheet; the snap height
// (--sheet-h) is shared, measured against whichever tab is on screen.
function _sheetSnaps() {
  const sheet  = document.querySelector(".view.active .arr-sheet") || document.querySelector(".arr-sheet");
  const search = document.querySelector(".view.active .arr-search-wrap") || document.querySelector(".arr-search-wrap");
  const bottomY = sheet ? sheet.getBoundingClientRect().bottom : innerHeight;
  const searchBottom = search ? search.getBoundingClientRect().bottom : 80;
  const min = Math.round(innerHeight * 0.22);
  const mid = Math.round(innerHeight * 0.46);
  const max = Math.max(mid + 1, Math.round(bottomY - searchBottom - 12));
  return { min, mid, max };
}
let _sheetSnapName = "mid";
function _snapSheet(name) {
  const s = _sheetSnaps();
  _sheetSnapName = name in s ? name : "mid";
  _setSheetH(s[_sheetSnapName]);
  setTimeout(() => { _arrMap?.invalidateSize(); _cpMap?.invalidateSize(); _mrtMap?.invalidateSize(); }, 280);
}
// Folding/unfolding an iPhone Duo, rotating, or resizing a Split View pane
// changes the window size in one jump. The sheet's height is in px computed
// for the old size, so re-apply the current snap for the new one (this also
// has Leaflet re-measure the map, which can change size with the layout).
let _sheetResizeTimer = null;
addEventListener("resize", () => {
  clearTimeout(_sheetResizeTimer);
  _sheetResizeTimer = setTimeout(() => _snapSheet(_sheetSnapName), 120);
});
function _initSheetDrag() {
  document.querySelectorAll(".arr-sheet").forEach(_initOneSheetDrag);
  _snapSheet("mid");
}
function _initOneSheetDrag(sheet) {
  const handle = sheet.querySelector(".arr-sheet-handle");
  if (!handle) return;

  let startY = 0, startH = 0, dragging = false;

  handle.addEventListener("pointerdown", (e) => {
    dragging = true;
    sheet.classList.add("dragging");
    startY = e.clientY;
    startH = sheet.getBoundingClientRect().height;
    handle.setPointerCapture?.(e.pointerId);
  });
  handle.addEventListener("pointermove", (e) => {
    if (!dragging) return;
    const s = _sheetSnaps();
    const h = Math.max(s.min, Math.min(s.max, startH + (startY - e.clientY)));
    _setSheetH(h);                                       // drag up → taller
    e.preventDefault();
  });
  const end = () => {
    if (!dragging) return;
    dragging = false;
    sheet.classList.remove("dragging");
    const h = sheet.getBoundingClientRect().height;
    const s = _sheetSnaps();
    _snapSheet(Object.keys(s).reduce((a, b) => (Math.abs(s[b] - h) < Math.abs(s[a] - h) ? b : a)));
  };
  handle.addEventListener("pointerup", end);
  handle.addEventListener("pointercancel", end);
}

let _arrMapP = null;
let _arrUserLL = null;        // last known position of the user
let _arrLastStops = [];       // last nearby-stops result, pinned once the map exists
function initArrMap() {
  if (!_leafletReady()) { _whenLeaflet(initArrMap); return; }
  _syncTopbarH();
  if (_arrMap) { setTimeout(() => _arrMap.invalidateSize(), 60); return; }
  if (_arrMapP) return;
  $("arr-locate-btn").addEventListener("click", _arrRefreshNearby);
  // The nearby list doesn't wait for the map (the 3D library is ~1 MB on a
  // first visit): locate and list stops now, pin them when the map is up.
  _arrGeolocate();
  _arrMapP = _sgCreateMap($("arr-map"), _arrUserLL ? [_arrUserLL.lat, _arrUserLL.lng] : [1.3521, 103.8198], 15).then((m) => {
    _arrMap = m;
    _sgTiltBtn("view-arrivals", () => _arrMap);
    if (_arrUserLL) _arrShowMyLocation(_arrUserLL.lat, _arrUserLL.lng);
    _arrAddPins(_arrLastStops);
    if (S.stop) _arrHighlightPin(S.stop);   // a stop opened before the map was ready
  });
}

// Theme toggle hook — the dark map look is a pure-CSS filter keyed on the
// theme attribute, so the tiles themselves never need swapping.
function _swapArrTiles() {}

function _arrShowMyLocation(lat, lng) {
  _arrUserLL = { lat, lng };
  if (!_arrMap) return;
  _arrMap.setView([lat, lng], Math.max(_arrMap.getZoom(), 16));
  if (_arrLocMarker) _arrLocMarker.remove();
  _arrLocMarker = SGL.circleMarker([lat, lng], {
    radius: 8, color: "#fff", fillColor: "#3b82f6", fillOpacity: 1, weight: 2.5,
  }).addTo(_arrMap);
}

// First load: show central Singapore immediately, then switch to the user's
// position once (a possibly cached) fix arrives.
function _arrGeolocate() {
  _loadArrStops(1.3521, 103.8198);
  navigator.geolocation?.getCurrentPosition(
    ({ coords: { latitude: lat, longitude: lng } }) => {
      _arrShowMyLocation(lat, lng);
      _loadArrStops(lat, lng);
    },
    () => {},
    { enableHighAccuracy: false, timeout: 8000, maximumAge: 300000 }
  );
}

// Locate button + "Refresh" in the Nearby stops header: get a fresh fix
// (no cached position, no flash of central-Singapore stops) and reload the
// list. Without location access, list the stops around the map's centre.
let _arrRefreshing = false;
function _arrRefreshNearby() {
  if (_arrRefreshing) return;
  _arrRefreshing = true;
  const btn = $("arr-nearby-refresh");
  btn?.classList.add("spinning");
  const done = () => { _arrRefreshing = false; btn?.classList.remove("spinning"); };
  const fromMapCentre = (msg) => {
    const c = _arrMap ? _arrMap.getCenter() : { lat: 1.3521, lng: 103.8198 };
    _loadArrStops(c.lat, c.lng).finally(done);
    if (msg) toast(msg);
  };
  if (!navigator.geolocation) { fromMapCentre("Location unavailable — showing stops near the map centre"); return; }
  navigator.geolocation.getCurrentPosition(
    ({ coords: { latitude: lat, longitude: lng } }) => {
      _arrShowMyLocation(lat, lng);
      _loadArrStops(lat, lng).finally(done);
    },
    () => fromMapCentre("Couldn't get your location — showing stops near the map centre"),
    { enableHighAccuracy: true, timeout: 10000, maximumAge: 0 }
  );
}
$("arr-nearby-refresh")?.addEventListener("click", _arrRefreshNearby);

let _arrLoadSeq = 0;
async function _loadArrStops(lat, lng) {
  // Only the newest request may update the list: the first-load "central
  // Singapore" fetch can finish after the one for the user's real position.
  const seq = ++_arrLoadSeq;
  try {
    const d = await api(`/api/stops/nearby?lat=${lat}&lng=${lng}&limit=20`)
      .catch(() => localNearby(lat, lng, 20));
    if (seq !== _arrLoadSeq) return;
    const stops = d.results || [];
    _arrLastStops = stops;
    _arrAddPins(stops);
    _renderArrNearbyList(stops);
    _liveNearby();
  } catch {}
}

function _arrAddPins(stops) {
  if (!_arrMap) return;
    stops.forEach((s) => {
      if (!s.latitude || _arrPinStore.has(s.bus_stop_code)) return;
      const label = s.description || s.bus_stop_code;
      const marker = SGL.marker([s.latitude, s.longitude], {
        icon: _stopPinIcon(label, true), title: label,
      }).addTo(_arrMap);
      // Bind on the marker, not the icon's inner DOM — setIcon() (highlight /
      // clear-highlight) replaces the icon element, which would strip a DOM-
      // level listener and leave every once-selected pin permanently dead.
      marker.on("click", () => loadStop(s.bus_stop_code));
      _arrPinStore.set(s.bus_stop_code, { marker, label, stop: s });
    });
    _evictArrPins();
}

// Markers accumulate as the user pans / re-geolocates; cap the store so the map
// can't grow unbounded. Evict the oldest pins (Map preserves insertion order),
// never the currently-selected stop.
const _ARR_PIN_CAP = 80;
function _evictArrPins() {
  if (_arrPinStore.size <= _ARR_PIN_CAP) return;
  for (const code of _arrPinStore.keys()) {
    if (_arrPinStore.size <= _ARR_PIN_CAP) break;
    if (code === S.stop || code === S._arrHighlightCode) continue;
    _arrPinStore.get(code)?.marker?.remove();
    _arrPinStore.delete(code);
  }
}

function _renderArrNearbyList(stops) {
  const section = $("arr-stops-section");
  const list    = $("arr-stops-list");
  if (!stops.length) return;
  $("arr-stops-count").textContent = stops.length;
  list.innerHTML = stops.map((s) => `
    <button class="arr-stop-item" data-code="${esc(s.bus_stop_code)}">
      <span class="arr-stop-code-badge">${esc(s.bus_stop_code)}</span>
      <span class="arr-stop-info">
        <span class="arr-stop-name">${esc(s.description || "Bus stop")}</span>
        <span class="arr-stop-road">${esc(s.road_name || "")}</span>
      </span>
      <span class="arr-stop-dist">${_cpDist(Math.round(s.distance_m))}</span>
      <svg class="arr-stop-chev" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round"><path d="m9 18 6-6-6-6"/></svg>
    </button>`).join("");
  show(section);
}

$("arr-stops-list").addEventListener("click", (e) => {
  const btn = e.target.closest(".arr-stop-item");
  if (btn) loadStop(btn.dataset.code);
});

// Buses heading to the stops nearest you, on the map while no stop is open.
function _liveNearby() {
  if (S.stop || S.view !== "arrivals") return;
  window.LiveBuses?.nearby(_arrLastStops.map((s) => s.bus_stop_code));
}

$("arr-back-btn").addEventListener("click", () => {
  window.LiveBuses?.clear();
  setTimeout(_liveNearby, 0);
  clearInterval(S.refreshTmr);
  clearInterval(S.tickTmr);
  S.stop = null;
  _arrClearHighlight();
  hide($("arr-detail"));
  show($("arr-nearby"));
  _snapSheet("mid");
  setTimeout(() => _arrMap?.invalidateSize(), 50);
});

function _arrHighlightPin(code) {
  _arrClearHighlight();
  const entry = _arrPinStore.get(code);
  if (!entry) return;
  const { marker, label } = entry;
  marker.setIcon(SGL.divIcon({
    className: "stop-pin",
    html: `<button class="stop-pin-btn" style="background:#e5282a;transform:scale(1.4)" aria-label="${esc(label)}"></button><span class="stop-pin-label" style="font-weight:700">${esc(label)}</span>`,
    iconSize: [22, 22], iconAnchor: [11, 11],
  }));
  _arrMap?.panTo(marker.getLatLng(), { animate: true, duration: 0.4 });
  S._arrHighlightCode = code;
}

function _arrClearHighlight() {
  if (!S._arrHighlightCode) return;
  const entry = _arrPinStore.get(S._arrHighlightCode);
  if (entry) entry.marker.setIcon(_stopPinIcon(entry.label, true));
  S._arrHighlightCode = null;
}

// ── Maps ──────────────────────────────────────────────────
// Leaflet is loaded async (defer); guard every call with typeof L check.
let _planData = null;  // last plan response, for per-card map drawing
let _planCoords = null;

function _leafletReady() { return typeof L !== "undefined"; }

// Leaflet is now a synchronous script loaded before app.js, so it's always
// ready by the time any of this code runs. The fallback is kept for safety.
function _whenLeaflet(fn) {
  if (_leafletReady()) { fn(); return; }
  document.addEventListener("DOMContentLoaded", fn, { once: true });
}

// ── Live maps: native MapLibre (tilt + 3D buildings) ──────
// The Bus, Parking and MRT maps run on MapLibre GL directly, so they can tilt,
// rotate and show 3D buildings (Leaflet can't). The app's map code was written
// against Leaflet, so `SGL` mirrors the small slice of Leaflet it uses —
// markers with HTML icons, circle markers, polylines, layer groups, setView /
// panTo / fitBounds — with a MapLibre implementation. When WebGL or the library
// isn't available, the same calls fall back to real Leaflet + OneMap tiles, so
// every phone still gets a working map. (The archived journey planner's maps
// stay on Leaflet.) Zoom levels are kept in Leaflet terms throughout:
// MapLibre's 512 px tiles make its zoom one less for the same scale.
let _sgMode = null;            // "gl" | "leaflet", decided by the first live map
const _sgGLMaps = new Set();   // GL maps, for theme swaps
const SG_PITCH = 50;           // default tilt for the 3D view
const _toLL = (ll) => Array.isArray(ll) ? { lat: ll[0], lng: ll[1] } : { lat: ll.lat, lng: ll.lng };
const _toLngLat = (ll) => { const p = _toLL(ll); return [p.lng, p.lat]; };
let _sgUid = 0;

class GLGroup {
  constructor() { this._kids = []; this._map = null; }
  addTo(t) { if (t instanceof GLGroup) { t._add(this); return this; } this._map = t; this._kids.forEach((k) => k.addTo(t)); return this; }
  _add(k) { this._kids.push(k); if (this._map) k.addTo(this._map); }
  remove() { this._kids.forEach((k) => k.remove()); this._map = null; return this; }
}

class GLMarker {
  constructor(ll, o = {}) {
    this._ll = _toLL(ll);
    this._el = document.createElement("div");
    this._el.className = "sgm";
    this._inner = document.createElement("div");
    this._el.appendChild(this._inner);
    if (o.title) this._el.title = o.title;
    this._handlers = [];
    this._el.addEventListener("click", (e) => { e.stopPropagation(); this._handlers.forEach((f) => f(e)); });
    this.setIcon(o.icon || { className: "", html: "", iconSize: [0, 0] });
    this.setZIndexOffset(o.zIndexOffset || 0);
  }
  setIcon(icon) {
    const [w, h] = icon.iconSize || [0, 0];
    const [ax, ay] = icon.iconAnchor || [w / 2, h / 2];
    this._inner.className = "sgm-icon " + (icon.className || "");
    this._inner.innerHTML = icon.html || "";
    Object.assign(this._inner.style, { width: w + "px", height: h + "px", left: -ax + "px", top: -ay + "px" });
    return this;
  }
  setZIndexOffset(z) { this._el.style.zIndex = String(1 + (z > 0 ? 1000 : 0)); return this; }
  getLatLng() { return { ...this._ll }; }
  setLatLng(ll) { this._ll = _toLL(ll); this._mk?.setLngLat(_toLngLat(this._ll)); return this; }
  on(evt, fn) { if (evt === "click") this._handlers.push(fn); return this; }
  bindTooltip(text) { this._el.title = String(text).replace(/<[^>]+>/g, ""); return this; }
  addTo(t) {
    if (t instanceof GLGroup) { t._add(this); return this; }
    this._mk?.remove();
    this._mk = new maplibregl.Marker({ element: this._el, anchor: "top-left" }).setLngLat(_toLngLat(this._ll)).addTo(t._gl);
    return this;
  }
  remove() { this._mk?.remove(); this._mk = null; return this; }
}

class GLCircle extends GLMarker {
  constructor(ll, o = {}) {
    const r = o.radius ?? 6, w = o.weight ?? 2;
    super(ll, { ...o, icon: {
      className: "sgm-dot", iconSize: [r * 2, r * 2], iconAnchor: [r, r],
      html: `<div style="width:100%;height:100%;box-sizing:border-box;border-radius:50%;background:${o.fillColor || "#fff"};opacity:${o.opacity ?? 1};border:${w}px solid ${o.color || "#3b82f6"};box-shadow:0 1px 4px rgba(0,0,0,.35)"></div>`,
    } });
  }
}

class GLLine {
  constructor(lls, o = {}) { this._coords = lls.map(_toLngLat); this._o = o; this._id = `sgl-${++_sgUid}`; this._map = null; }
  addTo(t) { if (t instanceof GLGroup) { t._add(this); return this; } this._map = t; t._lines.set(this._id, this); t._drawLine(this); return this; }
  remove() { if (this._map) { this._map._lines.delete(this._id); this._map._eraseLine(this); } this._map = null; return this; }
}

class GLMap {
  constructor(el, center, zoom, style) {
    this._el = el; this._lines = new Map(); this._pitched = true;
    this._gl = new maplibregl.Map({
      container: el, style, center: _toLngLat(center), zoom: zoom - 1,
      pitch: SG_PITCH, maxPitch: 70, attributionControl: false,
      dragRotate: true, touchPitch: true, pitchWithRotate: true, fadeDuration: 0,
    });
    this._gl.touchZoomRotate.enableRotation();
    // Overlays can be added once the style itself has loaded (tiles may still
    // be streaming in). A theme swap replaces the style, so redraw after it.
    this._ready = false;
    this._gl.on("style.load", () => { this._ready = true; this._lines.forEach((l) => this._drawLine(l)); });
    el.classList.add("sg-gl");
    _sgGLMaps.add(this);
  }
  setView(ll, z) { this._gl.jumpTo({ center: _toLngLat(ll), zoom: (z ?? this.getZoom()) - 1 }); return this; }
  getZoom() { return this._gl.getZoom() + 1; }
  getCenter() { const c = this._gl.getCenter(); return { lat: c.lat, lng: c.lng }; }
  panTo(ll, o = {}) { this._gl.easeTo({ center: _toLngLat(ll), duration: (o.duration ?? 0.25) * 1000 }); return this; }
  fitBounds(lls, o = {}) {
    const [l, t] = o.paddingTopLeft || [20, 20], [r, b] = o.paddingBottomRight || [20, 20];
    const pts = lls.map(_toLngLat);
    const lo = [Math.min(...pts.map((p) => p[0])), Math.min(...pts.map((p) => p[1]))];
    const hi = [Math.max(...pts.map((p) => p[0])), Math.max(...pts.map((p) => p[1]))];
    this._gl.fitBounds([lo, hi], { padding: { top: t, left: l, right: r, bottom: b }, maxZoom: (o.maxZoom ?? 18) - 1, duration: 600, pitch: this._gl.getPitch(), bearing: this._gl.getBearing() });
    return this;
  }
  // Centre `ll` in the visible strip between `top` and `bottom` (px insets).
  focusIn(ll, { top = 0, bottom = 0 } = {}) {
    this._gl.easeTo({ center: _toLngLat(ll), padding: { top, bottom, left: 0, right: 0 }, duration: 400 });
  }
  invalidateSize() { this._gl.resize(); return this; }
  getContainer() { return this._el; }
  setTilt(on) { this._pitched = on; this._gl.easeTo({ pitch: on ? SG_PITCH : 0, bearing: on ? this._gl.getBearing() : 0, duration: 500 }); }
  _drawLine(l) {
    const m = this._gl;
    if (!this._ready || m.getSource(l._id)) return;   // drawn on style.load otherwise
    m.addSource(l._id, { type: "geojson", data: { type: "Feature", geometry: { type: "LineString", coordinates: l._coords } } });
    const w = l._o.weight ?? 3;
    const paint = { "line-color": l._o.color || "#3b82f6", "line-width": w, "line-opacity": l._o.opacity ?? 1 };
    if (l._o.dashArray) paint["line-dasharray"] = String(l._o.dashArray).split(/[\s,]+/).map((x) => +x / w);
    // Under the labels, over the roads.
    const firstSymbol = m.getStyle().layers.find((x) => x.type === "symbol")?.id;
    m.addLayer({ id: l._id, type: "line", source: l._id, layout: { "line-join": "round", "line-cap": "round" }, paint }, firstSymbol);
  }
  _eraseLine(l) {
    const m = this._gl;
    if (m.getLayer(l._id)) m.removeLayer(l._id);
    if (m.getSource(l._id)) m.removeSource(l._id);
  }
}

// Factory used by all live-map code: MapLibre objects in GL mode, plain
// Leaflet otherwise.
const SGL = {
  divIcon: (o) => _sgMode === "gl" ? o : L.divIcon(o),
  marker: (ll, o) => _sgMode === "gl" ? new GLMarker(ll, o) : L.marker(ll, o),
  circleMarker: (ll, o) => _sgMode === "gl" ? new GLCircle(ll, o) : L.circleMarker(ll, o),
  polyline: (lls, o) => _sgMode === "gl" ? new GLLine(lls, o) : L.polyline(lls, o),
  layerGroup: () => _sgMode === "gl" ? new GLGroup() : L.layerGroup(),
  latLng: (a, b) => ({ lat: a, lng: b }),
  latLngBounds: (lls) => _sgMode === "gl" ? lls : L.latLngBounds(lls),
};

// Create a live map in `el`. Resolves to a GLMap, or a Leaflet map with
// OneMap tiles if MapLibre can't run here (no WebGL, blocked CDN, timeout).
function _sgCreateMap(el, center, zoom) {
  const leaflet = () => {
    _sgMode = _sgMode || "leaflet";
    const m = L.map(el, { zoomControl: false, attributionControl: false }).setView(center, zoom);
    _sgTiles().addTo(m);
    return m;
  };
  if (_sgMode === "leaflet") return Promise.resolve(leaflet());
  const timeout = new Promise((_, rej) => setTimeout(() => rej(new Error("map timeout")), 8000));
  return Promise.race([_loadVectorMaps(), timeout]).then((base) => {
    _sgMode = "gl";
    const m = new GLMap(el, center, zoom, _sgTuneStyle(base, _isDark(), { buildings3d: true }));
    m._styleBase = base; m._dark = _isDark();
    return m;
  }).catch((e) => { console.warn("3D map unavailable, using flat map:", e?.message); _sgMode = "leaflet"; return leaflet(); });
}

// Centre a point in the visible part of a live map (between search bar and
// bottom sheet on phones; plain centre in the landscape side-panel layout).
function _mapFocus(m, viewId, latlng) {
  if (!m) return;
  const c = m.getContainer().getBoundingClientRect();
  const view = $(viewId);
  const sh = view.querySelector(".arr-sheet").getBoundingClientRect();
  const sb = view.querySelector(".arr-search-wrap").getBoundingClientRect();
  const overlapX = Math.min(sh.right, c.right) - Math.max(sh.left, c.left);
  const covered = overlapX > c.width / 2 && sh.top > c.top;
  if (m instanceof GLMap) {
    // Use the sheet's target height (--sheet-h), not its on-screen top: it may
    // still be sliding after a snap.
    const sheetH = parseFloat(getComputedStyle(document.documentElement).getPropertyValue("--sheet-h")) || (c.bottom - sh.top);
    m.focusIn(latlng, covered ? { top: Math.max(0, sb.bottom - c.top), bottom: Math.max(0, Math.min(c.height - 120, c.bottom - (innerHeight - sheetH))) } : {});
    return;
  }
  let y = c.height / 2;
  if (covered) y = ((sb.bottom - c.top) + (sh.top - c.top)) / 2;
  const target = m.project(_toLL(latlng)).add([0, c.height / 2 - y]);
  m.panTo(m.unproject(target), { animate: true, duration: 0.4 });
}

// 2D / 3D toggle (GL maps only): one button per map view.
function _sgTiltBtn(viewId, getMap) {
  if (_sgMode !== "gl") return;
  const view = $(viewId);
  if (!view || view.querySelector(".sg-tilt-btn")) return;
  const b = document.createElement("button");
  b.type = "button"; b.className = "sg-tilt-btn"; b.textContent = "2D";
  b.setAttribute("aria-label", "Switch to a flat 2D map");
  b.addEventListener("click", () => {
    const m = getMap(); if (!(m instanceof GLMap)) return;
    m.setTilt(!m._pitched);
    b.textContent = m._pitched ? "2D" : "3D";
    b.setAttribute("aria-label", m._pitched ? "Switch to a flat 2D map" : "Switch to the 3D map");
  });
  view.appendChild(b);
}

function _isDark() {
  const t = document.documentElement.dataset.theme;
  return t === "dark" || (!t && window.matchMedia("(prefers-color-scheme: dark)").matches);
}

// ── Base maps ─────────────────────────────────────────────
// Arrivals + stop-picker maps: OpenFreeMap vector tiles (free, no API key,
// OpenStreetMap data) drawn by MapLibre GL inside Leaflet, with the stock
// "liberty" style tuned by _sgTuneStyle below — no shop icons, OSM bus stops
// or 3D buildings, bold MRT/LRT lines + labelled stations, and a derived
// dark palette. Vector rendering simplifies HDB blocks when zoomed out
// instead of baking every outline into raster images.
//
// Everything else (route mini-maps on the Plan screen, which can be several
// at once — each vector map holds a WebGL context and phones cap those), and
// the fallback when WebGL / the library / the style isn't available, uses
// OneMap raster tiles (Singapore Land Authority, free, Singapore-only):
// "Grey" in light mode, "Default" under a CSS invert filter in dark mode.
const _ONEMAP_ATTR = '<a href="https://www.onemap.gov.sg/" target="_blank" rel="noopener">OneMap</a> © contributors | <a href="https://www.sla.gov.sg/" target="_blank" rel="noopener">Singapore Land Authority</a>';
const _sgTileLayers = new Set();   // OneMap raster layers (theme-swapped by URL)
const _sgVectorLayers = new Set(); // MapLibre layers (theme-swapped by style)

function _sgTileUrl() {
  return `https://www.onemap.gov.sg/maps/tiles/${_isDark() ? "Default" : "Grey"}_HD/{z}/{x}/{y}.png`;
}
function _sgTiles() {
  const layer = L.tileLayer(_sgTileUrl(),
    { minZoom: 11, maxZoom: 19, detectRetina: true, keepBuffer: 3, attribution: _ONEMAP_ATTR });
  layer._sgBase = true;
  _sgTileLayers.add(layer);
  return layer;
}

// Lazy-load MapLibre + the Leaflet bridge + the base style once, in the
// background, so the 1 MB library never delays the app's first paint.
const _VEC_LIBS = [
  ["link", "https://unpkg.com/maplibre-gl@5.24.0/dist/maplibre-gl.css", "sha384-uTttxo/aOKbdE5RlD/SPzSDoDmNvGlUYPjONi2MN/b7c9HPSvW07OIuyP7uL6jxK"],
  ["script", "https://unpkg.com/maplibre-gl@5.24.0/dist/maplibre-gl.js", "sha384-5+cfbwT0iiub6VsQAdn6yz16nr6sDiQoHx6tm4O8OVYXHYOxcffFmCJBL0dgdvGp"],
  ["script", "https://unpkg.com/@maplibre/maplibre-gl-leaflet@0.1.4/leaflet-maplibre-gl.js", "sha384-tXYNKOHx4T02jMP7YYCtBxPIv1B5gaA5mcVPBzqMp6d7VzWzxJgI2aWF/nJLrQdS"],
];
let _vecReady = null;
function _loadVectorMaps() {
  if (_vecReady) return _vecReady;
  const webgl = (() => { try { const c = document.createElement("canvas"); return !!(c.getContext("webgl2") || c.getContext("webgl")); } catch { return false; } })();
  if (!webgl) return (_vecReady = Promise.reject(new Error("no WebGL")));
  const load = ([tag, url, integrity]) => new Promise((res, rej) => {
    const el = document.createElement(tag);
    if (tag === "link") { el.rel = "stylesheet"; el.href = url; } else { el.src = url; el.async = false; }
    el.integrity = integrity; el.crossOrigin = "anonymous";
    el.onload = res; el.onerror = () => rej(new Error("failed to load " + url));
    document.head.appendChild(el);
  });
  _vecReady = Promise.all([
    Promise.all(_VEC_LIBS.map(load)),
    fetch("https://tiles.openfreemap.org/styles/liberty").then((r) => { if (!r.ok) throw new Error("style " + r.status); return r.json(); }),
  ]).then(([, style]) => {
    if (typeof L.maplibreGL !== "function") throw new Error("maplibre-gl-leaflet missing");
    return style;
  });
  return _vecReady;
}

// Add the base map to `map`. vector=true tries MapLibre first; until it's
// ready (or if it can't be used) the map shows its land colour, then OneMap.
function _sgAddBase(map, vector) {
  if (!vector) { _sgTiles().addTo(map); return; }
  let settled = false;
  const fallback = () => { if (settled) return; settled = true; _sgTiles().addTo(map); };
  const timer = setTimeout(fallback, 6000);
  _loadVectorMaps().then((base) => {
    if (settled) return;
    settled = true; clearTimeout(timer);
    const layer = L.maplibreGL({ style: _sgTuneStyle(base, _isDark()), attributionControl: false });
    layer._sgBase = true; layer._sgStyleBase = base; layer._sgDark = _isDark();
    _sgVectorLayers.add(layer);
    layer.addTo(map);
    map.getContainer().classList.add("sg-vector");
  }).catch(fallback);
}

function _syncTileTheme() {
  const dark0 = _isDark();
  _sgGLMaps.forEach((m) => {
    if (m._dark === dark0) return;
    m._dark = dark0;
    m._ready = false;
    m._gl.setStyle(_sgTuneStyle(m._styleBase, dark0, { buildings3d: true }));
  });
  const url = _sgTileUrl();
  _sgTileLayers.forEach((l) => { if (l._url !== url) l.setUrl(url); });
  const dark = _isDark();
  _sgVectorLayers.forEach((l) => {
    if (l._sgDark === dark) return;
    l._sgDark = dark;
    l.getMaplibreMap()?.setStyle(_sgTuneStyle(l._sgStyleBase, dark));
  });
}
matchMedia("(prefers-color-scheme: dark)").addEventListener?.("change", () => {
  if (typeof L !== "undefined") _syncTileTheme();
});

// Tune OpenFreeMap's "liberty" style for a transit app: drop clutter (shop
// POIs, OSM bus stops, 3D buildings, relief shading, one-way arrows, road
// shields), quiet the palette so the red stop pins lead, make MRT/LRT lines
// bold and label their stations. Dark mode derives every colour by inverting
// its lightness (hue kept, saturation muted), then hand-sets the key groups.
const _sgColorCtx = document.createElement("canvas").getContext("2d");
function _sgIsColor(c) {
  // Style expressions also hold plain strings ("match", "get", property names).
  const x = _sgColorCtx;
  x.fillStyle = "#010203"; x.fillStyle = c; const a = x.fillStyle;
  x.fillStyle = "#040506"; x.fillStyle = c; return a === x.fillStyle;
}
function _sgDarkColor(c) {
  if (typeof c !== "string" || !_sgIsColor(c)) return c;
  const x = _sgColorCtx; x.fillStyle = c; const v = x.fillStyle;
  const [r, g, b, al] = v[0] === "#"
    ? [parseInt(v.slice(1, 3), 16), parseInt(v.slice(3, 5), 16), parseInt(v.slice(5, 7), 16), 1]
    : (() => { const m = v.match(/[\d.]+/g).map(Number); return [m[0], m[1], m[2], m[3] ?? 1]; })();
  const R = r / 255, G = g / 255, B = b / 255, mx = Math.max(R, G, B), mn = Math.min(R, G, B), l = (mx + mn) / 2;
  let h = 0, s = 0;
  if (mx !== mn) {
    const d = mx - mn; s = l > .5 ? d / (2 - mx - mn) : d / (mx + mn);
    h = (mx === R ? (G - B) / d + (G < B ? 6 : 0) : mx === G ? (B - R) / d + 2 : (R - G) / d + 4) * 60;
  }
  return `hsla(${Math.round(h)}, ${Math.round(s * 45)}%, ${Math.round((0.11 + (1 - l) * 0.72) * 100)}%, ${al})`;
}
function _sgMapColors(v, f) {
  if (typeof v === "string") return f(v);
  if (Array.isArray(v)) return v.map((x) => _sgMapColors(x, f));
  if (v && typeof v === "object" && v.stops) return { ...v, stops: v.stops.map(([z, c]) => [z, _sgMapColors(c, f)]) };
  return v;
}
const _SG_DROP = /^(natural_earth|poi_r\d+|building-3d|road_one_way_arrow.*|highway-shield.*|road_shield_us|road_area_pattern|.*_hatching)$/;
function _sgTuneStyle(base, dark, { buildings3d = false } = {}) {
  const s = JSON.parse(JSON.stringify(base));
  delete s.sources.ne2_shaded;
  s.layers = s.layers.filter((l) => !_SG_DROP.test(l.id) || (buildings3d && l.id === "building-3d"));
  const P = dark
    ? { bg: "#1c1d20", building: "#2a2c31", bOutline: "#34373d", minor: "#33363c", major: "#41444b", motorway: "#4d4a43",
        casing: "#1c1d20", rail: "#8a93a6", railTunnel: "#5d6372", label: "#c9ccd2", halo: "#1c1d20", station: "#e8ebf0",
        water: "#1f3448", green: "#20302a", special: "#2b2a30" }
    : { bg: "#f4f3f0", building: "#e6e4df", bOutline: "#dbd8d2", minor: "#ffffff", major: "#ffffff", motorway: "#fde3a7",
        casing: "#dcd9d3", rail: "#5f6b7e", railTunnel: "#9aa3b2", label: "#4a4f58", halo: "#ffffff", station: "#2b3240",
        water: "#aad3ee", green: "#d8ecd2", special: null };
  for (const l of s.layers) {
    const p = (l.paint = l.paint || {});
    const id = l.id;
    if (dark) for (const k of Object.keys(p)) if (/color$/.test(k)) p[k] = _sgMapColors(p[k], _sgDarkColor);
    if (id === "background") p["background-color"] = P.bg;
    else if (id === "water") p["fill-color"] = P.water;
    else if (/^(park|landcover_(grass|wood)|landuse_pitch)$/.test(id)) { p["fill-color"] = P.green; p["fill-opacity"] = 0.9; }
    else if (dark && /^landuse_(hospital|school|cemetery|track|residential)$/.test(id)) { p["fill-color"] = P.special; p["fill-opacity"] = 0.6; }
    else if (id === "building") { p["fill-color"] = P.building; p["fill-outline-color"] = P.bOutline; p["fill-opacity"] = 1; }
    else if (id === "building-3d") {
      // Soft, matte blocks so HDB estates read as 3D without stealing focus.
      p["fill-extrusion-color"] = dark ? "#2d3036" : "#e4e1db";
      p["fill-extrusion-opacity"] = dark ? 0.9 : 0.85;
      p["fill-extrusion-vertical-gradient"] = true;
      l.minzoom = 14;
    }
    else if (/_casing$/.test(id) && l.type === "line") p["line-color"] = P.casing;
    else if (/motorway(_link)?$/.test(id) && l.type === "line") p["line-color"] = P.motorway;
    else if (/(trunk_primary|secondary_tertiary)$/.test(id)) p["line-color"] = P.major;
    else if (/(minor|street|link|service_track)$/.test(id) && l.type === "line") p["line-color"] = P.minor;
    else if (/(transit|major)_rail$/.test(id)) {
      const tunnel = id.startsWith("tunnel");
      p["line-color"] = tunnel ? P.railTunnel : P.rail;
      p["line-width"] = ["interpolate", ["exponential", 1.4], ["zoom"], 11, 1, 14, 2.2, 17, 4.5];
      p["line-opacity"] = tunnel ? 0.7 : 1;
      if (tunnel) p["line-dasharray"] = [2, 1.5]; else delete p["line-dasharray"];
      l.minzoom = 10;
    }
    if (l.type === "symbol" && p["text-color"] !== undefined && !/^label_(city|town|country|state)/.test(id)) {
      p["text-color"] = P.label; p["text-halo-color"] = P.halo;
    }
  }
  // poi_transit = airports + OSM bus stops (the app has its own stop pins);
  // swap it for MRT/LRT stations, which liberty never labels (OpenMapTiles
  // tags them class "railway", subclass subway / light_rail).
  const i = s.layers.findIndex((l) => l.id === "poi_transit");
  if (i >= 0) {
    const font = (s.layers[i].layout?.["text-font"] || ["Noto Sans Italic"]).map((f) => f.replace("Italic", "Bold"));
    s.layers.splice(i, 1, {
      id: "sg_mrt_station", type: "symbol", source: "openmaptiles", "source-layer": "poi", minzoom: 12,
      filter: ["all", ["==", ["get", "class"], "railway"], ["match", ["get", "subclass"], ["subway", "light_rail"], true, false]],
      layout: {
        "icon-image": ["match", ["get", "subclass"], "light_rail", "railway_light", "railway_metro"],
        "icon-size": ["interpolate", ["linear"], ["zoom"], 12, 0.75, 16, 1],
        "text-field": ["coalesce", ["get", "name_en"], ["get", "name"]],
        "text-font": font,
        "text-size": ["interpolate", ["linear"], ["zoom"], 12, 10.5, 16, 13],
        "text-anchor": "left", "text-offset": [0.95, 0], "text-optional": true,
      },
      paint: { "text-color": P.station, "text-halo-color": P.halo, "text-halo-width": 1.4 },
    });
  }
  return s;
}

// HTML divIcon marker — taps fire reliably on iOS, unlike SVG circleMarkers
// (Leaflet 1.7+ dropped its tap handler, so vector layers miss touch clicks).
// noLabel: omit the text label (used on the arrivals map where many pins
// would otherwise overlap into an unreadable mess).
function _stopPinIcon(label, noLabel = false) {
  const lbl = noLabel ? "" : `<span class="stop-pin-label">${esc(label || "")}</span>`;
  return SGL.divIcon({
    className: "stop-pin",
    html: `<button class="stop-pin-btn" aria-label="${esc(label || "")}"></button>${lbl}`,
    iconSize: [22, 22],
    iconAnchor: [11, 11],
  });
}


// Line colors for MRT (matches mrt_data.py line_color values)
const MRT_COLORS = {
  EWL: "#009645", NSL: "#d42e12", NEL: "#9900aa",
  CCL: "#fa9e0d", DTL: "#005ec4", TEL: "#9D5B25",
};

// Client-side MRT station coords + line sequences for waypoint fallback
const _MRT_COORDS = {
  EW1:[1.3731,103.9496],EW2:[1.3530,103.9450],EW3:[1.3432,103.9530],EW4:[1.3273,103.9463],EW5:[1.3240,103.9300],EW6:[1.3208,103.9132],EW7:[1.3196,103.9030],EW8:[1.3180,103.8924],EW9:[1.3163,103.8828],EW10:[1.3115,103.8711],EW11:[1.3073,103.8634],EW12:[1.3008,103.8565],EW13:[1.2930,103.8520],EW14:[1.2840,103.8516],EW15:[1.2765,103.8454],EW16:[1.2803,103.8394],EW17:[1.2863,103.8270],EW18:[1.2894,103.8165],EW19:[1.2944,103.8061],EW20:[1.3022,103.7984],EW21:[1.3073,103.7898],EW22:[1.3111,103.7787],EW23:[1.3151,103.7651],EW24:[1.3331,103.7422],EW25:[1.3424,103.7323],EW26:[1.3441,103.7213],EW27:[1.3386,103.7060],EW28:[1.3378,103.6968],EW29:[1.3278,103.6784],EW30:[1.3195,103.6609],EW31:[1.3209,103.6488],EW32:[1.3300,103.6393],EW33:[1.3407,103.6366],
  NS1:[1.3331,103.7422],NS2:[1.3492,103.7496],NS3:[1.3589,103.7516],NS4:[1.3854,103.7448],NS5:[1.3970,103.7473],NS7:[1.4253,103.7621],NS8:[1.4326,103.7746],NS9:[1.4369,103.7864],NS10:[1.4408,103.8010],NS11:[1.4489,103.8198],NS12:[1.4432,103.8299],NS13:[1.4294,103.8353],NS14:[1.4172,103.8330],NS15:[1.3817,103.8449],NS16:[1.3700,103.8496],NS17:[1.3510,103.8484],NS18:[1.3404,103.8470],NS19:[1.3326,103.8473],NS20:[1.3203,103.8438],NS21:[1.3124,103.8382],NS22:[1.3041,103.8322],NS23:[1.3006,103.8388],NS24:[1.2990,103.8455],NS25:[1.2930,103.8520],NS26:[1.2840,103.8516],NS27:[1.2765,103.8543],NS28:[1.2706,103.8633],
  NE1:[1.2654,103.8204],NE3:[1.2803,103.8394],NE4:[1.2845,103.8445],NE5:[1.2884,103.8462],NE6:[1.2990,103.8455],NE7:[1.3065,103.8517],NE8:[1.3124,103.8544],NE9:[1.3198,103.8611],NE10:[1.3316,103.8686],NE11:[1.3394,103.8704],NE12:[1.3499,103.8730],NE13:[1.3600,103.8852],NE14:[1.3712,103.8924],NE15:[1.3829,103.8925],NE16:[1.3917,103.8954],NE17:[1.4051,103.9022],
  CC1:[1.2990,103.8455],CC2:[1.2965,103.8502],CC3:[1.2934,103.8554],CC4:[1.2936,103.8607],CC5:[1.2997,103.8634],CC6:[1.3026,103.8749],CC7:[1.3061,103.8820],CC8:[1.3083,103.8883],CC9:[1.3180,103.8924],CC10:[1.3266,103.8900],CC11:[1.3356,103.8878],CC12:[1.3428,103.8798],CC13:[1.3499,103.8730],CC14:[1.3514,103.8644],CC15:[1.3510,103.8484],CC16:[1.3467,103.8394],CC17:[1.3376,103.8323],CC19:[1.3223,103.8152],CC20:[1.3175,103.8076],CC21:[1.3113,103.7963],CC22:[1.3073,103.7898],CC23:[1.2998,103.7873],CC24:[1.2937,103.7844],CC25:[1.2825,103.7820],CC26:[1.2763,103.7914],CC27:[1.2724,103.8026],CC28:[1.2706,103.8095],CC29:[1.2654,103.8204],
  DT1:[1.3783,103.7762],DT2:[1.3697,103.7836],DT3:[1.3621,103.7672],DT5:[1.3412,103.7759],DT6:[1.3354,103.7838],DT7:[1.3307,103.7968],DT8:[1.3249,103.8077],DT9:[1.3223,103.8152],DT10:[1.3202,103.8257],DT11:[1.3124,103.8382],DT12:[1.3065,103.8517],DT13:[1.3034,103.8556],DT14:[1.3008,103.8565],DT15:[1.2936,103.8607],DT16:[1.2823,103.8594],DT17:[1.2791,103.8528],DT18:[1.2822,103.8483],DT19:[1.2845,103.8445],DT20:[1.2917,103.8440],DT21:[1.2983,103.8497],DT22:[1.3048,103.8556],DT23:[1.3141,103.8615],DT24:[1.3213,103.8710],DT25:[1.3273,103.8832],DT26:[1.3266,103.8900],DT27:[1.3298,103.8989],DT28:[1.3353,103.9068],DT29:[1.3341,103.9166],DT30:[1.3362,103.9326],DT31:[1.3454,103.9380],DT32:[1.3530,103.9450],DT33:[1.3568,103.9538],DT34:[1.3413,103.9610],DT35:[1.3353,103.9613],
  TE1:[1.4481,103.8195],TE2:[1.4369,103.7864],TE3:[1.4251,103.7968],TE4:[1.4039,103.8162],TE5:[1.3866,103.8355],TE6:[1.3742,103.8383],TE7:[1.3624,103.8376],TE8:[1.3543,103.8319],TE9:[1.3376,103.8323],TE11:[1.3202,103.8257],TE12:[1.3059,103.8177],TE13:[1.3015,103.8227],TE14:[1.3041,103.8322],TE15:[1.2944,103.8227],TE16:[1.2880,103.8352],TE17:[1.2803,103.8394],TE18:[1.2796,103.8444],TE19:[1.2773,103.8497],TE20:[1.2765,103.8543],TE22:[1.2815,103.8631],TE23:[1.2978,103.8708],TE24:[1.3018,103.8820],TE25:[1.3023,103.8909],TE26:[1.3028,103.9007],TE27:[1.3056,103.9110],TE28:[1.3102,103.9260],TE29:[1.3167,103.9392],TE30:[1.3226,103.9492],TE31:[1.3299,103.9604],
};
const _MRT_SEQS = {
  EWL:["EW33","EW32","EW31","EW30","EW29","EW28","EW27","EW26","EW25","EW24","EW23","EW22","EW21","EW20","EW19","EW18","EW17","EW16","EW15","EW14","EW13","EW12","EW11","EW10","EW9","EW8","EW7","EW6","EW5","EW4","EW3","EW2","EW1"],
  NSL:["NS1","NS2","NS3","NS4","NS5","NS7","NS8","NS9","NS10","NS11","NS12","NS13","NS14","NS15","NS16","NS17","NS18","NS19","NS20","NS21","NS22","NS23","NS24","NS25","NS26","NS27","NS28"],
  NEL:["NE1","NE3","NE4","NE5","NE6","NE7","NE8","NE9","NE10","NE11","NE12","NE13","NE14","NE15","NE16","NE17"],
  CCL:["CC1","CC2","CC3","CC4","CC5","CC6","CC7","CC8","CC9","CC10","CC11","CC12","CC13","CC14","CC15","CC16","CC17","CC19","CC20","CC21","CC22","CC23","CC24","CC25","CC26","CC27","CC28","CC29"],
  DTL:["DT1","DT2","DT3","DT5","DT6","DT7","DT8","DT9","DT10","DT11","DT12","DT13","DT14","DT15","DT16","DT17","DT18","DT19","DT20","DT21","DT22","DT23","DT24","DT25","DT26","DT27","DT28","DT29","DT30","DT31","DT32","DT33","DT34","DT35"],
  TEL:["TE1","TE2","TE3","TE4","TE5","TE6","TE7","TE8","TE9","TE11","TE12","TE13","TE14","TE15","TE16","TE17","TE18","TE19","TE20","TE22","TE23","TE24","TE25","TE26","TE27","TE28","TE29","TE30","TE31"],
};

function _mrtClientWaypoints(fromCode, toCode) {
  for (const seq of Object.values(_MRT_SEQS)) {
    const fi = seq.indexOf(fromCode), ti = seq.indexOf(toCode);
    if (fi === -1 || ti === -1) continue;
    const lo = Math.min(fi, ti), hi = Math.max(fi, ti);
    const slice = seq.slice(lo, hi + 1);
    if (fi > ti) slice.reverse();
    return slice.map((c) => _MRT_COORDS[c]).filter(Boolean);
  }
  return null;
}

// Smooth a sparse point list (e.g. MRT station coords) into a curved path with
// a Catmull-Rom spline so the line bends through the stations instead of
// cutting straight across them.
function _smoothLine(points, segments = 16) {
  if (!points || points.length < 2) return points;
  // For a 2-point leg (adjacent stations), insert a midpoint offset slightly
  // perpendicular to the segment so the spline can produce a visible arc.
  if (points.length === 2) {
    const [p0, p1] = points;
    const dlat = p1[0] - p0[0], dlng = p1[1] - p0[1];
    const len = Math.sqrt(dlat * dlat + dlng * dlng);
    const scale = len * 0.25;
    // Perpendicular unit vector: rotate 90° (swap, negate one)
    const mid = [
      (p0[0] + p1[0]) / 2 - (dlng / len) * scale,
      (p0[1] + p1[1]) / 2 + (dlat / len) * scale,
    ];
    points = [p0, mid, p1];
  }
  const out = [];
  for (let i = 0; i < points.length - 1; i++) {
    const p0 = points[i - 1] || points[i];
    const p1 = points[i];
    const p2 = points[i + 1];
    const p3 = points[i + 2] || p2;
    for (let t = 0; t < segments; t++) {
      const s = t / segments, s2 = s * s, s3 = s2 * s;
      const lat = 0.5 * ((2 * p1[0]) + (-p0[0] + p2[0]) * s +
        (2 * p0[0] - 5 * p1[0] + 4 * p2[0] - p3[0]) * s2 +
        (-p0[0] + 3 * p1[0] - 3 * p2[0] + p3[0]) * s3);
      const lng = 0.5 * ((2 * p1[1]) + (-p0[1] + p2[1]) * s +
        (2 * p0[1] - 5 * p1[1] + 4 * p2[1] - p3[1]) * s2 +
        (-p0[1] + 3 * p1[1] - 3 * p2[1] + p3[1]) * s3);
      out.push([lat, lng]);
    }
  }
  out.push(points[points.length - 1]);
  return out;
}

// Fetch real MRT track geometry from OSM Overpass API so lines follow actual
// rail curves instead of straight station-to-station segments.
const _mrtOsmCache = new Map();

async function _osmMrtTrack(leg) {
  const lat1 = leg.board_lat, lng1 = leg.board_lng;
  const lat2 = leg.alight_lat, lng2 = leg.alight_lng;
  if (!lat1 || !lat2) return null;
  const key = `${leg.from_code}|${leg.to_code}`;
  if (_mrtOsmCache.has(key)) return _mrtOsmCache.get(key);
  const pad = 0.008;
  const bbox = `${Math.min(lat1,lat2)-pad},${Math.min(lng1,lng2)-pad},${Math.max(lat1,lat2)+pad},${Math.max(lng1,lng2)+pad}`;
  const q = `[out:json][timeout:10];way["railway"="subway"](${bbox});out geom;`;
  try {
    const r = await fetch(`https://overpass-api.de/api/interpreter?data=${encodeURIComponent(q)}`,
      { signal: AbortSignal.timeout(12000) });
    if (!r.ok) throw 0;
    const d = await r.json();
    const segs = (d.elements || [])
      .filter(e => e.type === "way" && e.geometry?.length >= 2)
      .map(e => e.geometry.map(n => [n.lat, n.lon]));
    const track = segs.length ? _stitchWays(segs, [lat1, lng1], [lat2, lng2]) : null;
    _mrtOsmCache.set(key, track);
    return track;
  } catch {
    _mrtOsmCache.set(key, null);
    return null;
  }
}

// Fetch road-following geometry for bus legs via OSRM (public routing engine).
// Routes through a sampled set of DB waypoints (bus stops) so the line follows
// actual roads between stops, not just straight stop-to-stop segments.
const _busOsrmCache = new Map();

async function _busOsrmTrack(leg) {
  const b = leg.board_stop, a = leg.alight_stop;
  if (!b?.lat || !a?.lat) return null;
  const key = `${b.lat},${b.lng}|${a.lat},${a.lng}`;
  if (_busOsrmCache.has(key)) return _busOsrmCache.get(key);

  // Build waypoint list: board + sampled intermediate stops + alight.
  // Limit to ~12 points to keep the OSRM URL short.
  const wps = (leg.waypoints?.length >= 3)
    ? leg.waypoints
    : [{ lat: b.lat, lng: b.lng }, { lat: a.lat, lng: a.lng }];
  const step = wps.length > 12 ? Math.ceil(wps.length / 12) : 1;
  const sampled = [];
  for (let i = 0; i < wps.length; i += step) sampled.push(wps[i]);
  if (sampled[sampled.length - 1] !== wps[wps.length - 1]) sampled.push(wps[wps.length - 1]);

  const coords = sampled.map(p => `${p.lng},${p.lat}`).join(';');
  try {
    const r = await fetch(
      `https://router.project-osrm.org/route/v1/driving/${coords}?overview=full&geometries=geojson&continue_straight=true`,
      { signal: AbortSignal.timeout(8000) }
    );
    if (!r.ok) throw 0;
    const j = await r.json();
    const geom = j.routes?.[0]?.geometry?.coordinates;
    if (!geom?.length) throw 0;
    const track = geom.map(([lng, lat]) => [lat, lng]);
    _busOsrmCache.set(key, track);
    return track;
  } catch {
    _busOsrmCache.set(key, null);
    return null;
  }
}

function _stitchWays(segs, start, end) {
  const d2 = (a, b) => (a[0]-b[0])**2 + (a[1]-b[1])**2;
  const remaining = segs.map(s => [...s]);
  // Start from the segment whose nearest endpoint is closest to start
  let bestI = 0, bestD = Infinity;
  remaining.forEach((s, i) => {
    const d = Math.min(d2(s[0], start), d2(s[s.length-1], start));
    if (d < bestD) { bestD = d; bestI = i; }
  });
  let seg = remaining.splice(bestI, 1)[0];
  if (d2(seg[0], start) > d2(seg[seg.length-1], start)) seg = [...seg].reverse();
  const chain = [...seg];
  // Greedily extend the chain by connecting adjacent segments
  const EPS2 = 6e-8; // ~25 m tolerance
  let changed = true;
  while (remaining.length && changed) {
    changed = false;
    const tail = chain[chain.length - 1];
    for (let i = 0; i < remaining.length; i++) {
      const s = remaining[i];
      if (d2(s[0], tail) < EPS2) {
        chain.push(...s.slice(1)); remaining.splice(i, 1); changed = true; break;
      }
      if (d2(s[s.length - 1], tail) < EPS2) {
        chain.push(...[...s].reverse().slice(1)); remaining.splice(i, 1); changed = true; break;
      }
    }
  }
  // Trim to the node closest to end
  let endI = chain.length - 1, endD = Infinity;
  chain.forEach((p, i) => { const d = d2(p, end); if (d < endD) { endD = d; endI = i; } });
  return chain.slice(0, endI + 1);
}

// Bus leg colours: pink for the first bus, bright yellow for the second.
// Neither clashes with any MRT line colour so transfers read clearly on the map.
const BUS_COLORS      = ["#e91e8c", "#FF6E00"]; // pink (1st bus), orange (2nd bus)
const BUS_TEXT_COLORS = ["#fff",    "#fff"]; // contrast text for badges
function _legColor(leg, busIdx = 0) {
  if (leg.type === "walk") return "#888";
  if (leg.type === "mrt") return leg.line_color || MRT_COLORS[leg.line] || "#555";
  return BUS_COLORS[Math.min(busIdx, BUS_COLORS.length - 1)];
}

function updatePlanMap(data, coords, optIdx = 0) {
  _planData = data; _planCoords = coords;
}

function _openCardMap(card, data, coords, optIdx) {
  if (!_leafletReady()) { _whenLeaflet(() => _openCardMap(card, data, coords, optIdx)); return; }
  const container = card.querySelector(".jcard-map");
  if (!container) return;
  if (!card._jmap) {
    card._jmap = L.map(container, { zoomControl: false, attributionControl: false })
                  .setView([1.3521, 103.8198], 13);
    _sgAddBase(card._jmap, false);
    // Add fit-to-route button
    const wrap = card.querySelector(".jcard-map-wrap");
    if (wrap) {
      const btn = document.createElement("button");
      btn.className = "jcard-map-fit";
      btn.title = "Fit route";
      btn.innerHTML = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" width="16" height="16"><path d="M12 22s-8-4.5-8-11.8A8 8 0 0 1 12 2a8 8 0 0 1 8 8.2c0 7.3-8 11.8-8 11.8z"/><circle cx="12" cy="10" r="3"/></svg>`;
      const _fitRoute = (e) => {
        e.stopPropagation();
        if (card._jmapBounds?.length) card._jmap.fitBounds(card._jmapBounds, { padding: [24, 24] });
      };
      btn.addEventListener("click", _fitRoute);
      // Chrome on iOS can swallow click events on elements overlaid on a Leaflet
      // map. Handle touchend directly so the button works in all browsers.
      btn.addEventListener("touchend", (e) => { e.preventDefault(); _fitRoute(e); }, { passive: false });
      wrap.appendChild(btn);
    }
  }
  card._jmapBounds = _drawOnMap(card._jmap, data, coords, optIdx);
  // Invalidate size as soon as the max-height expand transition ends (fires in
  // ~300 ms). Falls back to 320 ms if the event never fires (e.g. prefers-reduced-motion).
  const detail = card.querySelector(".jcard-detail");
  const onEnd = () => { card._jmap?.invalidateSize(); detail?.removeEventListener("transitionend", onEnd); };
  detail?.addEventListener("transitionend", onEnd, { once: true });
  setTimeout(onEnd, 320);
}

function _drawOnMap(map, data, coords, optIdx = 0) {
  map.eachLayer((l) => { if (!l._sgBase) l.remove(); });

  let { fLat, fLng, tLat, tLng, fromName, toName } = coords;
  // Fall back to coords in the response (bus-only plan has them in data.from/to)
  fLat = fLat ?? data?.from?.lat; fLng = fLng ?? data?.from?.lng;
  tLat = tLat ?? data?.to?.lat;   tLng = tLng ?? data?.to?.lng;
  fromName = fromName || data?.from?.name || "Origin";
  toName   = toName   || data?.to?.name   || "Destination";
  if (!fLat || !tLat) return;

  const bounds = [];

  // Origin + destination pins
  const pinIcon = (color, label) => L.divIcon({
    className: "",
    html: `<div style="width:34px;height:34px;border-radius:50% 50% 50% 0;background:${color};transform:rotate(-45deg);border:3px solid #fff;box-shadow:0 3px 8px rgba(0,0,0,.45)">
      <span style="display:block;transform:rotate(45deg);text-align:center;font-size:11px;font-weight:800;color:#fff;line-height:28px">${label}</span></div>`,
    iconSize: [34, 34], iconAnchor: [17, 34],
  });
  L.marker([fLat, fLng], { icon: pinIcon("#3b82f6", "A") })
   .bindPopup(`<b>From:</b> ${esc(fromName || "Origin")}`)
   .addTo(map);
  bounds.push([fLat, fLng]);

  L.marker([tLat, tLng], { icon: pinIcon("#e5282a", "B") })
   .bindPopup(`<b>To:</b> ${esc(toName || "Destination")}`)
   .addTo(map);
  bounds.push([tLat, tLng]);

  // Draw the selected option's legs
  const safeIdx = Math.min(Math.max(0, optIdx), (data.options?.length || 1) - 1);
  const option = data.options?.[safeIdx];
  if (option?.legs) {
    let _busIdx = 0;
    // Track the explicit endpoint/startpoint of each leg (from leg fields, NOT
    // from waypoint array — DB waypoints may exclude stops missing coordinates,
    // so the array endpoint can be a mid-route stop rather than the real alight stop).
    const _legEdges = [];
    option.legs.forEach((leg) => {
      const busIdx = leg.type === "bus" ? _busIdx++ : 0;
      const color = _legColor(leg, busIdx);
      const isWalk = leg.type === "walk";
      const points = _legPoints(leg);

      let edgeStart = null, edgeEnd = null;
      if (leg.type === "bus") {
        edgeStart = leg.board_stop?.lat  ? [leg.board_stop.lat,  leg.board_stop.lng]  : points[0] ?? null;
        edgeEnd   = leg.alight_stop?.lat ? [leg.alight_stop.lat, leg.alight_stop.lng] : points[points.length-1] ?? null;
      } else if (leg.type === "mrt") {
        edgeStart = leg.board_lat  ? [leg.board_lat,  leg.board_lng]  : points[0] ?? null;
        edgeEnd   = leg.alight_lat ? [leg.alight_lat, leg.alight_lng] : points[points.length-1] ?? null;
      } else if (leg.type === "walk") {
        edgeStart = leg.from_lat != null ? [leg.from_lat, leg.from_lng] : points[0] ?? null;
        edgeEnd   = leg.to_lat   != null ? [leg.to_lat,   leg.to_lng]   : points[points.length-1] ?? null;
      }
      if (edgeStart && edgeEnd) _legEdges.push({ start: edgeStart, end: edgeEnd });

      const drawPoints = leg.type === "mrt" ? _smoothLine(points) : points;
      if (points.length >= 2) {
        const poly = L.polyline(drawPoints, {
          color, opacity: isWalk ? .55 : .9,
          weight: isWalk ? 2 : 5,
          dashArray: isWalk ? "4,7" : null,
          lineCap: "round", lineJoin: "round",
        }).addTo(map);
        // Async-replace with real geometry so lines follow actual rail/road curves.
        if (leg.type === "mrt") {
          _osmMrtTrack(leg).then(track => {
            if (track?.length > 2) {
              poly.setLatLngs([
                [leg.board_lat, leg.board_lng],
                ...track,
                [leg.alight_lat, leg.alight_lng],
              ]);
            }
          });
        }
        if (leg.type === "bus") {
          const bl = leg.board_stop, al = leg.alight_stop;
          _busOsrmTrack(leg).then(track => {
            if (track?.length > 2) {
              poly.setLatLngs([
                [bl.lat, bl.lng],
                ...track,
                [al.lat, al.lng],
              ]);
            }
          });
        }
        points.forEach((p) => bounds.push(p));

        // Compact route badge at midpoint
        const mid = points[Math.floor(points.length / 2)];
        const badge = leg.type === "bus" ? (leg.service_no || "Bus")
                    : leg.type === "mrt" ? (leg.line || "MRT") : "";
        if (badge) {
          L.marker(mid, {
            icon: L.divIcon({
              className: "",
              html: `<div style="color:${color};font-size:11px;font-weight:800;white-space:nowrap;text-shadow:0 0 6px rgba(0,0,0,1),0 1px 4px rgba(0,0,0,.9),-1px -1px 0 rgba(0,0,0,.6)">${esc(badge)}</div>`,
              iconAnchor: [0, 0],
            }),
            interactive: false,
          }).addTo(map);
        }
      }
      // Small board/alight dots for transit legs only
      if (leg.type === "bus" && leg.board_stop?.lat) {
        L.circleMarker([leg.board_stop.lat, leg.board_stop.lng], { radius: 4, color, fillColor: "#fff", fillOpacity: 1, weight: 2 }).addTo(map);
        L.circleMarker([leg.alight_stop.lat, leg.alight_stop.lng], { radius: 4, color, fillColor: "#fff", fillOpacity: 1, weight: 2 }).addTo(map);
      }
      if (leg.type === "mrt" && leg.board_lat) {
        L.circleMarker([leg.board_lat, leg.board_lng], { radius: 4, color, fillColor: "#fff", fillOpacity: 1, weight: 2 }).addTo(map);
        L.circleMarker([leg.alight_lat, leg.alight_lng], { radius: 4, color, fillColor: "#fff", fillOpacity: 1, weight: 2 }).addTo(map);
      }
    });

    // Stitch any gap between consecutive legs
    for (let i = 1; i < _legEdges.length; i++) {
      const a = _legEdges[i - 1].end, b = _legEdges[i].start;
      if (a && b && (Math.abs(a[0] - b[0]) > 5e-5 || Math.abs(a[1] - b[1]) > 5e-5)) {
        L.polyline([a, b], {
          color: "#aaa", opacity: 0.7, weight: 2, dashArray: "3,6", lineCap: "round",
        }).addTo(map);
      }
    }
  }

  if (bounds.length) map.fitBounds(bounds, { padding: [24, 24] });
  return bounds;
}

function _legPoints(leg) {
  // MRT: always use client-side station sequence — backend may only have 2 points.
  if (leg.type === "mrt") {
    const pts = _mrtClientWaypoints(leg.from_code, leg.to_code);
    if (pts?.length >= 2) return pts;
    if (leg.waypoints?.length >= 2) return leg.waypoints.map((w) => [w.lat, w.lng]);
    const r = [];
    if (leg.board_lat) r.push([leg.board_lat, leg.board_lng]);
    if (leg.alight_lat) r.push([leg.alight_lat, leg.alight_lng]);
    return r;
  }
  // Bus: prefer backend waypoints (real route geometry from DB).
  if (leg.waypoints?.length >= 2) {
    return leg.waypoints.map((w) => [w.lat, w.lng]);
  }
  if (leg.type === "walk") {
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
  return [];
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
  if (!PLAN_ENABLED) return;
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

// ── Bus stop picker modal ─────────────────────────────────
let _pickerMap    = null;
let _pickerField  = null;   // "from" | "to"
let _pickerStop   = null;   // currently highlighted stop object
let _pickerLayers = [];     // all stop markers currently on the map

const SG_CENTER = [1.3521, 103.8198];

function openStopPicker(field) {
  _pickerField  = field;
  _pickerStop   = null;
  $("stop-picker-selected").classList.add("hidden");
  show($("stop-picker-modal"));
  show($("stop-picker-backdrop"));
  document.body.style.overflow = "hidden";

  _whenLeaflet(() => {
    const container = $("stop-picker-map");
    if (!_pickerMap) {
      // Start at Singapore centre; jump to user location if available
      _pickerMap = L.map(container, { zoomControl: true, attributionControl: false })
                   .setView(SG_CENTER, 15);
      _sgAddBase(_pickerMap, true);
      _pickerMap.on("moveend", _onPickerMove);

      // Try to centre on user GPS first
      if (navigator.geolocation) {
        navigator.geolocation.getCurrentPosition(
          (pos) => {
            _pickerMap.setView([pos.coords.latitude, pos.coords.longitude], 16);
            _loadPickerStops(pos.coords.latitude, pos.coords.longitude);
          },
          () => _loadPickerStops(...SG_CENTER),
          { timeout: 4000 }
        );
      } else {
        _loadPickerStops(...SG_CENTER);
      }
    } else {
      setTimeout(() => _pickerMap.invalidateSize(), 100);
      const c = _pickerMap.getCenter();
      _loadPickerStops(c.lat, c.lng);
    }
  });
}

function closeStopPicker() {
  hide($("stop-picker-modal"));
  hide($("stop-picker-backdrop"));
  document.body.style.overflow = "";
  _pickerStop = null;
}

let _pickerMoveTimer = null;
function _onPickerMove() {
  clearTimeout(_pickerMoveTimer);
  _pickerMoveTimer = setTimeout(() => {
    const c = _pickerMap.getCenter();
    _loadPickerStops(c.lat, c.lng);
  }, 350);
}

function _loadPickerStops(lat, lng) {
  api(`/api/stops/nearby?lat=${lat}&lng=${lng}&limit=40`)
    .catch(() => localNearby(lat, lng, 40))
    .then((d) => {
    if (!_pickerMap) return;
    _pickerLayers.forEach((m) => m.remove());
    _pickerLayers = [];

    d.results?.forEach((s) => {
      if (!s.latitude) return;
      const isSelected = _pickerStop?.bus_stop_code === s.bus_stop_code;
      const m = L.marker([s.latitude, s.longitude], { icon: _pickerIcon(isSelected) })
        .on("click", () => _selectPickerStop(s))
        .addTo(_pickerMap);
      m._stopCode = s.bus_stop_code;
      // Simple tooltip on hover for desktop
      m.bindTooltip(`<b>${esc(s.description)}</b><br><span style="font-size:.8em;color:#888">${s.bus_stop_code} · ${s.road_name || ""}</span>`,
        { direction: "top", offset: [0, -8], opacity: 1 });
      _pickerLayers.push(m);
    });
  }).catch(() => {});
}

function _pickerIcon(selected) {
  return selected
    ? L.divIcon({
        className: "",
        html: `<div style="width:16px;height:16px;border-radius:50%;background:var(--accent);border:3px solid #fff;box-shadow:0 2px 6px rgba(0,0,0,.5)"></div>`,
        iconSize: [16, 16], iconAnchor: [8, 8],
      })
    : L.divIcon({
        className: "",
        html: `<div style="width:12px;height:12px;border-radius:50%;background:var(--accent);border:2.5px solid #fff;box-shadow:0 1px 4px rgba(0,0,0,.35)"></div>`,
        iconSize: [12, 12], iconAnchor: [6, 6],
      });
}

function _selectPickerStop(stop) {
  _pickerStop = stop;
  $("stop-picker-sel-name").textContent = stop.description || stop.bus_stop_code;
  $("stop-picker-sel-meta").textContent =
    [stop.road_name, stop.bus_stop_code, stop.distance_m ? `${stop.distance_m} m away` : ""]
    .filter(Boolean).join(" · ");
  show($("stop-picker-selected"));
  // Swap icons in place — a full _loadPickerStops here refired the nearby
  // fetch and rebuilt all 40 markers just to restyle two of them, so the
  // highlight lagged by a network round trip.
  _pickerLayers.forEach((m) => m.setIcon(_pickerIcon(m._stopCode === stop.bus_stop_code)));
}

function _confirmPickerStop() {
  if (!_pickerStop || !_pickerField) return;
  const s = _pickerStop;
  const name = s.description || s.bus_stop_code;
  if (_pickerField === "from") {
    planState.fromName = name;
    planState.fromCode = s.bus_stop_code;
    planState.fromLat  = s.latitude;
    planState.fromLng  = s.longitude;
    $("plan-from-input").value = name;
    show($("plan-from-clear"));
    _updatePlanHomeChip();
  } else {
    planState.toName = name;
    planState.toCode = s.bus_stop_code;
    planState.toLat  = s.latitude;
    planState.toLng  = s.longitude;
    $("plan-to-input").value = name;
    show($("plan-to-clear"));
  }
  closeStopPicker();
}

$("plan-from-pick").addEventListener("click", () => openStopPicker("from"));
$("plan-to-pick").addEventListener("click",   () => openStopPicker("to"));
$("stop-picker-close").addEventListener("click", closeStopPicker);
$("stop-picker-backdrop").addEventListener("click", closeStopPicker);
$("stop-picker-confirm").addEventListener("click", _confirmPickerStop);

// ── Carpark tab ───────────────────────────────────────────
// Live available lots for HDB, URA and LTA carparks (LTA DataMall, refreshed
// every minute server-side — see carpark_routes.py). Same shape as Arrivals:
// map + floating search + sheet listing what's nearby; tap a pin, a list row
// or a search result for the detail card. Only *available* lots are
// published (no capacity), so colours are by absolute count.
const CP = {
  items: new Map(),     // id → carpark (last seen data)
  pins: new Map(),      // id → Leaflet marker
  sel: null,            // selected carpark id
  locMarker: null,
  detailTmr: null,
  acTimer: null,
  acSeq: 0,
  busy: false,
  saved: [],            // the user's saved carparks (server-synced, live lots merged in)
};
const CP_AGENCY = { HDB: "HDB", URA: "URA", LTA: "LTA" };

// LTA sends HDB carparks in capitals ("BLK 270/271 ALBERT CENTRE"); title-
// case those, leaving mixed-case names (malls) alone.
function _cpName(n) {
  n = String(n || "").trim();
  if (!n || n !== n.toUpperCase()) return n;
  return n.toLowerCase().replace(/\b([a-z])/g, (c) => c.toUpperCase())
    .replace(/\b(Hdb|Ura|Lta|Mscp|Scp|Ntu|Nus|Sgh|Cbd)\b/g, (w) => w.toUpperCase());
}
function _cpLevel(n) { return n == null ? "na" : n === 0 ? "full" : n < 10 ? "low" : "ok"; }
function _cpDist(m) { return m == null ? "" : m < 1000 ? `${m} m` : `${(m / 1000).toFixed(1)} km`; }
function _cpCar(cp) { return cp?.lots?.car ?? null; }

function _cpPinIcon(cp, selected = false) {
  const n = _cpCar(cp);
  return SGL.divIcon({
    className: "cp-pin-wrap",
    html: `<div class="cp-pin ${_cpLevel(n)}${selected ? " sel" : ""}">${n == null ? "P" : n}</div>`,
    iconSize: [36, 24], iconAnchor: [18, 12],
  });
}

let _cpMapP = null;
function _cpInit() {
  if (_cpMap) { setTimeout(() => _cpMap.invalidateSize(), 60); return; }
  if (!_leafletReady()) { _whenLeaflet(_cpInit); return; }
  if (_cpMapP) return;
  _cpMapP = _sgCreateMap($("cp-map"), _arrUserLL ? [_arrUserLL.lat, _arrUserLL.lng] : SG_CENTER, 16).then((m) => {
    _cpMap = m;
    _sgTiltBtn("view-carpark", () => _cpMap);
    setTimeout(() => _cpMap.invalidateSize(), 60);
    CP.items.forEach((cp) => _cpPutPin(cp));   // anything loaded (e.g. saved) before the map
    _cpLocate(false);
  });
}

// fresh=false on first open (a recent cached fix is fine and fast); the
// Refresh / locate buttons ask for a fresh one. Without location access the
// list falls back to the carparks around the map's centre.
function _cpLocate(fresh) {
  if (!_cpMap || CP.busy) return;
  CP.busy = true;
  $("cp-refresh")?.classList.add("spinning");
  const done = () => { CP.busy = false; $("cp-refresh")?.classList.remove("spinning"); };
  const fromCentre = (msg) => {
    const c = _cpMap.getCenter();
    _cpLoadNearby(c.lat, c.lng).finally(done);
    if (msg) toast(msg);
  };
  if (!navigator.geolocation) { fromCentre("Location unavailable — showing carparks near the map centre"); return; }
  navigator.geolocation.getCurrentPosition(
    ({ coords: { latitude: lat, longitude: lng } }) => {
      _cpMap.setView([lat, lng], Math.max(_cpMap.getZoom(), 16));
      if (CP.locMarker) CP.locMarker.remove();
      CP.locMarker = SGL.circleMarker([lat, lng], {
        radius: 8, color: "#fff", fillColor: "#3b82f6", fillOpacity: 1, weight: 2.5,
      }).addTo(_cpMap);
      _cpLoadNearby(lat, lng).finally(done);
    },
    () => fromCentre(fresh ? "Couldn't get your location — showing carparks near the map centre" : ""),
    fresh ? { enableHighAccuracy: true, timeout: 10000, maximumAge: 0 }
          : { enableHighAccuracy: false, timeout: 8000, maximumAge: 300000 }
  );
}

async function _cpLoadNearby(lat, lng) {
  const status = $("cp-status");
  try {
    const d = await api(`/api/carparks/nearby?lat=${lat}&lng=${lng}&limit=30`);
    const list = d.results || [];
    list.forEach((cp) => CP.items.set(cp.id, cp));
    _cpSyncPins(list);
    _cpRenderList(list, d);
  } catch (e) {
    status.textContent = `Couldn't load carparks: ${e.message}`;
    show(status);
  }
}

// Keep pins for the latest nearby set plus the selected carpark; drop the rest.
function _cpSyncPins(list) {
  const keep = new Set(list.map((c) => c.id));
  if (CP.sel) keep.add(CP.sel);
  for (const [id, m] of CP.pins) if (!keep.has(id)) { m.remove(); CP.pins.delete(id); }
  list.forEach(_cpPutPin);
}
function _cpPutPin(cp) {
  if (cp.lat == null) return;
  const icon = _cpPinIcon(cp, cp.id === CP.sel);
  const m = CP.pins.get(cp.id);
  if (m) { m.setIcon(icon); return; }
  if (!_cpMap) return;
  const marker = SGL.marker([cp.lat, cp.lng], { icon, title: _cpName(cp.name), zIndexOffset: cp.id === CP.sel ? 1000 : 0 }).addTo(_cpMap);
  marker.on("click", () => _cpOpen(cp.id));
  CP.pins.set(cp.id, marker);
}

function _cpRow(cp, { removable = false } = {}) {
  const n = _cpCar(cp);
  const meta = [CP_AGENCY[cp.agency] || cp.agency, cp.area].filter(Boolean).join(" · ");
  return `
    <button class="arr-stop-item cp-item" data-cp="${esc(cp.id)}">
      <span class="cp-lots ${_cpLevel(n)}"><b>${n == null ? "–" : n}</b><small>${n === 0 ? "full" : "lots"}</small></span>
      <span class="arr-stop-info">
        <span class="arr-stop-name">${esc(_cpName(cp.name))}</span>
        <span class="arr-stop-road">${esc(meta)}</span>
      </span>
      ${cp.distance_m != null ? `<span class="arr-stop-dist">${_cpDist(cp.distance_m)}</span>` : ""}
      ${removable
        ? `<span class="saved-remove cp-unsave" data-cp-unsave="${esc(cp.id)}" role="button" aria-label="Remove from saved">
            <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M18 6 6 18M6 6l12 12"/></svg></span>`
        : `<svg class="arr-stop-chev" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round"><path d="m9 18 6-6-6-6"/></svg>`}
    </button>`;
}
function _cpRenderList(list, d) {
  const status = $("cp-status");
  $("cp-count").textContent = list.length;
  $("cp-count").classList.toggle("hidden", !list.length);
  if (!list.length) {
    status.textContent = "No carparks with live data around here. Try moving the map and tapping Refresh.";
    show(status);
  } else if (d.stale) {
    status.textContent = `Live feed is delayed — showing lots as of ${fmtClock(parseUTC(d.updated_at))}.`;
    show(status);
  } else hide(status);
  $("cp-list").innerHTML = list.map(_cpRow).join("");
}

async function _cpOpen(id) {
  const prev = CP.sel;
  CP.sel = id;
  if (prev && CP.items.has(prev)) _cpPutPin(CP.items.get(prev));
  const cp = CP.items.get(id);
  if (cp) _cpShowDetail(cp, null);
  hide($("cp-nearby")); show($("cp-detail"));
  $("view-carpark").querySelector(".arr-sheet-scroll").scrollTop = 0;
  _snapSheet("mid");
  clearInterval(CP.detailTmr);
  CP.detailTmr = setInterval(() => { if (S.view === "carpark" && !document.hidden) _cpRefreshDetail(); }, 60_000);
  await _cpRefreshDetail();
}
async function _cpRefreshDetail() {
  const id = CP.sel;
  if (!id) return;
  try {
    const d = await api(`/api/carparks/${encodeURIComponent(id)}`);
    if (CP.sel !== id) return;
    const prev = CP.items.get(id);
    const cp = { ...d.carpark, distance_m: prev?.distance_m ?? null };
    CP.items.set(id, cp);
    _cpShowDetail(cp, d);
  } catch (e) {
    if (CP.sel === id && !CP.items.has(id)) $("cp-card").innerHTML = `<p class="cp-status">Couldn't load this carpark: ${esc(e.message)}</p>`;
  }
}

function _cpShowDetail(cp, d) {
  _cpPutPin(cp);
  const m = CP.pins.get(cp.id);
  if (m) { m.setZIndexOffset(1000); _cpFocus(m.getLatLng()); }
  const lots = [
    ["car", "Car lots"], ["motorcycle", "Motorcycle lots"], ["heavy", "Heavy vehicle lots"],
  ].filter(([k]) => cp.lots?.[k] != null);
  const ios = /iP(hone|ad|od)/.test(navigator.userAgent) || (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1);
  const dir = cp.lat == null ? null : ios
    ? `https://maps.apple.com/?daddr=${cp.lat},${cp.lng}&dirflg=d`
    : `https://www.google.com/maps/dir/?api=1&destination=${cp.lat},${cp.lng}&travelmode=driving`;
  const meta = [CP_AGENCY[cp.agency] ? `${CP_AGENCY[cp.agency]} carpark` : cp.agency, cp.area, _cpDist(cp.distance_m)].filter(Boolean).join(" · ");
  const when = d?.updated_at ? fmtClock(parseUTC(d.updated_at)) : null;
  $("cp-card").innerHTML = `
    <div class="stop-card-top">
      <div class="stop-id">
        <div class="stop-name">${esc(_cpName(cp.name))}</div>
        <div class="stop-meta">${esc(meta)}</div>
      </div>
      <div class="cp-actions">
        <button id="cp-save-btn" class="pillbtn cp-save${_cpIsSaved(cp.id) ? " on" : ""}" aria-pressed="${_cpIsSaved(cp.id)}">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linejoin="round"><path d="m19 21-7-4-7 4V5a2 2 0 0 1 2-2h10a2 2 0 0 1 2 2z"/></svg>
          <span>${_cpIsSaved(cp.id) ? "Saved" : "Save"}</span>
        </button>
        ${dir ? `<a class="pillbtn cp-dir" href="${dir}" target="_blank" rel="noopener">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polygon points="3 11 22 2 13 21 11 13 3 11"/></svg>
          Directions</a>` : ""}
      </div>
    </div>
    <div class="cp-lot-grid">
      ${lots.length ? lots.map(([k, label]) => {
        const n = cp.lots[k];
        return `<div class="cp-lot ${_cpLevel(n)}"><div class="cp-lot-n">${n}</div><div class="cp-lot-l">${label}${n === 0 ? " · full" : ""}</div></div>`;
      }).join("") : `<p class="cp-status">No lot counts published for this carpark.</p>`}
    </div>
    <div class="stop-card-foot">
      <span>${when ? `Updated ${when}` : "Loading latest…"}</span>
      <span class="foot-sep">·</span>
      <span>auto-refresh 60s</span>
      ${d?.stale ? `<span class="foot-sep">·</span><span class="cp-stale">feed delayed</span>` : ""}
    </div>`;
}

function _cpFocus(latlng) { _mapFocus(_cpMap, "view-carpark", latlng); }

// ── Saved carparks (account-synced; see /api/saved-carparks) ──
function _cpIsSaved(id) { return CP.saved.some((c) => c.id === id); }

async function _cpLoadSaved() {
  if (!S.token) { CP.saved = []; _cpRenderSaved(); return; }
  try {
    const d = await api("/api/saved-carparks");
    CP.saved = d.results || [];
    CP.saved.forEach((c) => { if (c.live) CP.items.set(c.id, { ...CP.items.get(c.id), ...c }); });
  } catch { /* keep what we had */ }
  _cpRenderSaved();
}

// Saved list appears at the top of the Carpark tab and in the Saved tab.
function _cpRenderSaved() {
  const rows = CP.saved.map((c) => {
    const known = CP.items.get(c.id);
    return { ...c, name: c.saved_name && !c.live ? c.saved_name : c.name, distance_m: known?.distance_m ?? null };
  });
  const tabSec = $("cp-saved");
  if (tabSec) {
    tabSec.classList.toggle("hidden", !rows.length);
    $("cp-saved-list").innerHTML = rows.map((c) => _cpRow(c)).join("");
  }
  const savedTab = $("saved-cp-list");
  if (savedTab) {
    $("saved-cp-empty").classList.toggle("hidden", !!rows.length);
    savedTab.innerHTML = rows.map((c) => _cpRow(c, { removable: true })).join("");
  }
  if (CP.sel) _cpSyncSaveBtn();
}

function _cpSyncSaveBtn() {
  const btn = $("cp-save-btn");
  if (!btn) return;
  const on = _cpIsSaved(CP.sel);
  btn.classList.toggle("on", on);
  btn.setAttribute("aria-pressed", on);
  btn.querySelector("span").textContent = on ? "Saved" : "Save";
}

async function _cpToggleSave(id) {
  if (!S.token) { toast("Log in to save carparks"); openSheet(); return; }
  const cp = CP.items.get(id) || CP.saved.find((c) => c.id === id);
  if (_cpIsSaved(id)) {
    showConfirm("Remove this carpark from saved?", "Remove", async () => {
      CP.saved = CP.saved.filter((c) => c.id !== id);
      _cpRenderSaved();
      try { await api(`/api/saved-carparks/${encodeURIComponent(id)}`, { method: "DELETE" }); toast("Removed from saved carparks"); }
      catch (e) { toast(`Couldn't remove: ${e.message}`); _cpLoadSaved(); }
    });
    return;
  }
  CP.saved = [{ ...(cp || { id, lots: {} }), saved_name: cp ? _cpName(cp.name) : null, live: true }, ...CP.saved];
  _cpRenderSaved();
  try {
    await api(`/api/saved-carparks/${encodeURIComponent(id)}`, {
      method: "POST", body: JSON.stringify({ name: cp ? _cpName(cp.name) : null }),
    });
    toast("Carpark saved");
  } catch (e) {
    toast(`Couldn't save: ${e.message}`);
    _cpLoadSaved();
  }
}

function _cpBack() {
  clearInterval(CP.detailTmr);
  const prev = CP.sel;
  CP.sel = null;
  if (prev && CP.items.has(prev)) { _cpPutPin(CP.items.get(prev)); CP.pins.get(prev)?.setZIndexOffset(0); }
  hide($("cp-detail")); show($("cp-nearby"));
  _snapSheet("mid");
}

// Search (debounced; stale responses from earlier keystrokes are dropped).
function _cpSearch(q) {
  const ac = $("cp-ac");
  clearTimeout(CP.acTimer);
  if (q.trim().length < 2) { hide(ac); ac.innerHTML = ""; return; }
  CP.acTimer = setTimeout(async () => {
    const seq = ++CP.acSeq;
    try {
      const d = await api(`/api/carparks/search?q=${encodeURIComponent(q.trim())}&limit=8`);
      if (seq !== CP.acSeq) return;
      const list = d.results || [];
      list.forEach((cp) => { if (!CP.items.has(cp.id)) CP.items.set(cp.id, cp); });
      ac.innerHTML = list.length ? list.map((cp) => {
        const n = _cpCar(cp);
        return `<button class="ac-item cp-ac-item" data-cp="${esc(cp.id)}">
          <span class="cp-lots sm ${_cpLevel(n)}"><b>${n == null ? "–" : n}</b></span>
          <span class="ac-txt"><span class="ac-name">${esc(_cpName(cp.name))}</span>
          <span class="ac-road">${esc([CP_AGENCY[cp.agency] || cp.agency, cp.area].filter(Boolean).join(" · "))}</span></span>
        </button>`;
      }).join("") : `<div class="ac-empty">No carparks match “${esc(q.trim())}”</div>`;
      show(ac);
    } catch { /* keep the previous suggestions */ }
  }, 250);
}

$("cp-input").addEventListener("input", (e) => {
  $("cp-search-clear").classList.toggle("hidden", !e.target.value);
  _cpSearch(e.target.value);
});
$("cp-search-clear").addEventListener("click", () => {
  $("cp-input").value = ""; hide($("cp-search-clear")); hide($("cp-ac"));
});
$("cp-ac").addEventListener("click", (e) => {
  const it = e.target.closest("[data-cp]");
  if (!it) return;
  hide($("cp-ac")); $("cp-input").blur();
  const cp = CP.items.get(it.dataset.cp);
  if (cp?.lat != null) _cpMap?.setView([cp.lat, cp.lng], 17);
  _cpOpen(it.dataset.cp);
});
$("cp-list").addEventListener("click", (e) => {
  const it = e.target.closest("[data-cp]");
  if (it) _cpOpen(it.dataset.cp);
});
$("cp-back").addEventListener("click", _cpBack);
$("cp-saved-list").addEventListener("click", (e) => {
  const it = e.target.closest("[data-cp]");
  if (it) _cpOpen(it.dataset.cp);
});
$("cp-card").addEventListener("click", (e) => {
  if (e.target.closest("#cp-save-btn") && CP.sel) _cpToggleSave(CP.sel);
});
// Saved tab: tap opens it in the Carpark tab; × unsaves.
$("saved-cp-list").addEventListener("click", (e) => {
  const rm = e.target.closest("[data-cp-unsave]");
  if (rm) { e.stopPropagation(); _cpToggleSave(rm.dataset.cpUnsave); return; }
  const it = e.target.closest("[data-cp]");
  if (!it) return;
  switchView("carpark");
  const open = () => {
    const cp = CP.items.get(it.dataset.cp);
    if (cp?.lat != null) _cpMap.setView([cp.lat, cp.lng], 17);
    _cpOpen(it.dataset.cp);
  };
  if (_cpMap) open(); else _cpMapP?.then(() => setTimeout(open, 100));
});
$("cp-refresh").addEventListener("click", () => _cpLocate(true));
$("cp-locate-btn").addEventListener("click", () => _cpLocate(true));

// ── MRT tab ───────────────────────────────────────────────
// Scheduled train info, like Apple / Google Maps: typical frequency, first /
// last trains per direction (SMRT lines) and live disruption alerts. There is
// no public live train-arrival feed in Singapore, so nothing here is a live
// countdown — see mrt_routes.py.
const MRT = {
  stations: null,       // all stations (fetched once)
  pins: new Map(),      // name → marker
  sel: null,            // selected station name
  data: null,           // last /api/mrt/station response for sel
  locMarker: null,
  tick: null,
  refresh: null,
  busy: false,
  saved: [],            // the user's saved stations (account-synced)
};

function _mrtChips(lines) {
  return lines.map((l) => `<span class="mrt-code" style="background:${esc(l.color)}">${esc(l.code)}</span>`).join("");
}

function _mrtPinIcon(st, selected = false) {
  const cols = st.lines.map((l) => l.color);
  const bg = cols.length === 1 ? cols[0]
    : `conic-gradient(${cols.map((c, i) => `${c} ${(i * 360) / cols.length}deg ${((i + 1) * 360) / cols.length}deg`).join(", ")})`;
  return SGL.divIcon({
    className: "mrt-pin-wrap",
    html: `<div class="mrt-pin${selected ? " sel" : ""}" style="background:${bg}"></div>`,
    iconSize: [18, 18], iconAnchor: [9, 9],
  });
}

async function _mrtStations() {
  if (MRT.stations) return MRT.stations;
  const d = await api("/api/mrt/stations");
  MRT.stations = d.results || [];
  return MRT.stations;
}

let _mrtMapP = null;
function _mrtInit() {
  if (_mrtMap) { setTimeout(() => _mrtMap.invalidateSize(), 60); return; }
  if (!_leafletReady()) { _whenLeaflet(_mrtInit); return; }
  if (_mrtMapP) return;
  _mrtMapP = _sgCreateMap($("mrt-map"), _arrUserLL ? [_arrUserLL.lat, _arrUserLL.lng] : SG_CENTER, 15).then((m) => {
    _mrtMap = m;
    _sgTiltBtn("view-mrt", () => _mrtMap);
    setTimeout(() => _mrtMap.invalidateSize(), 60);
    _mrtStations().then((list) => list.forEach((st) => {
      const pin = SGL.marker([st.lat, st.lng], { icon: _mrtPinIcon(st, st.name === MRT.sel), title: st.name }).addTo(_mrtMap);
      pin.on("click", () => _mrtOpen(st.name));
      MRT.pins.set(st.name, pin);
    })).catch(() => {});
    _mrtLocate(false);
  });
}

function _mrtLocate(fresh) {
  if (!_mrtMap || MRT.busy) return;
  MRT.busy = true;
  $("mrt-refresh")?.classList.add("spinning");
  const done = () => { MRT.busy = false; $("mrt-refresh")?.classList.remove("spinning"); };
  const fromCentre = (msg) => {
    const c = _mrtMap.getCenter();
    _mrtLoadNearby(c.lat, c.lng).finally(done);
    if (msg) toast(msg);
  };
  if (!navigator.geolocation) { fromCentre("Location unavailable — showing stations near the map centre"); return; }
  navigator.geolocation.getCurrentPosition(
    ({ coords: { latitude: lat, longitude: lng } }) => {
      _mrtMap.setView([lat, lng], Math.max(_mrtMap.getZoom(), 15));
      if (MRT.locMarker) MRT.locMarker.remove();
      MRT.locMarker = SGL.circleMarker([lat, lng], {
        radius: 8, color: "#fff", fillColor: "#3b82f6", fillOpacity: 1, weight: 2.5,
      }).addTo(_mrtMap);
      _mrtLoadNearby(lat, lng).finally(done);
    },
    () => fromCentre(fresh ? "Couldn't get your location — showing stations near the map centre" : ""),
    fresh ? { enableHighAccuracy: true, timeout: 10000, maximumAge: 0 }
          : { enableHighAccuracy: false, timeout: 8000, maximumAge: 300000 }
  );
}

async function _mrtLoadNearby(lat, lng) {
  const status = $("mrt-status");
  try {
    const d = await api(`/api/mrt/nearby?lat=${lat}&lng=${lng}&limit=8`);
    hide(status);
    $("mrt-list").innerHTML = (d.results || []).map(_mrtRow).join("");
  } catch (e) {
    status.textContent = `Couldn't load stations: ${e.message}`;
    show(status);
  }
}

function _mrtRow(st, { removable = false } = {}) {
  return `
    <button class="arr-stop-item mrt-item" data-mrt="${esc(st.name)}">
      <span class="mrt-codes">${_mrtChips(st.lines)}</span>
      <span class="arr-stop-info">
        <span class="arr-stop-name">${esc(st.name)}</span>
        <span class="arr-stop-road" ${removable ? `data-mrt-preview="${esc(st.name)}"` : ""}>${esc(st.lines.map((l) => l.name).join(" · "))}</span>
      </span>
      ${st.distance_m != null ? `<span class="arr-stop-dist">${_cpDist(st.distance_m)}</span>` : ""}
      ${removable
        ? `<span class="saved-remove" data-mrt-unsave="${esc(st.name)}" role="button" aria-label="Remove from saved">
            <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M18 6 6 18M6 6l12 12"/></svg></span>`
        : `<svg class="arr-stop-chev" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round"><path d="m9 18 6-6-6-6"/></svg>`}
    </button>`;
}

// Singapore time, and minutes into the service day (which starts ~04:30, so
// a 00:25 last train is still late "today").
function _mrtSgt(offsetMs = 0) { return new Date(Date.now() + 8 * 3600e3 + offsetMs); }  // read with getUTC*
function _mrtMins(hhmm) {
  if (!hhmm) return null;
  const [h, m] = hhmm.split(":").map(Number);
  return (h < 4 || (h === 4 && m < 30) ? h + 24 : h) * 60 + m;
}
function _mrtNowMins() {
  const t = _mrtSgt();
  return _mrtMins(`${String(t.getUTCHours()).padStart(2, "0")}:${String(t.getUTCMinutes()).padStart(2, "0")}`);
}
// "weekday" / "saturday" / "sunday" for today's service day (offset 0) or the next (1).
function _mrtDayType(offsetDays = 0) {
  const wd = _mrtSgt(-(4 * 60 + 30) * 60e3 + offsetDays * 86400e3).getUTCDay();
  return wd === 0 ? "sunday" : wd === 6 ? "saturday" : "weekday";
}
function _mrtToday(dir) { return dir[_mrtDayType()] || dir.today || null; }

// Status for one direction right now. After the last train, the "first
// train" quoted is the next service day's (e.g. Monday's after Sunday night).
function _mrtStatus(dir) {
  const today = _mrtToday(dir);
  if (!today) return null;
  const now = _mrtNowMins(), first = _mrtMins(today.first), last = _mrtMins(today.last);
  if (first != null && now < first) return { cls: "off", ended: true, txt: `Starts at ${today.first}` };
  if (last != null && now > last) {
    const next = dir[_mrtDayType(1)]?.first || today.first;
    return { cls: "off", ended: true, txt: next ? `Service ended · first train ${next}` : "Service ended" };
  }
  if (last != null && last - now <= 45) return { cls: "warn", txt: last - now <= 0 ? "Last train now" : `Last train in ${last - now} min` };
  return null;
}

// Estimated departures for one direction: there's no public per-train
// timetable, so trains are spaced from today's first train at the line's
// typical headway (peak or off-peak at that hour) up to the last train.
// Returns the train just missed and the next three, or null outside service.
function _mrtHeadway(l, m) {
  const t = m % 1440;
  const peak = _mrtDayType() === "weekday" && ((t >= 420 && t < 570) || (t >= 1020 && t < 1200));
  const r = l.headways ? (peak ? l.headways.peak : l.headways.offpeak) : [l.frequency.min, l.frequency.max];
  return Math.max(1.5, (r[0] + r[1]) / 2);
}
function _mrtFmt(m) {
  const t = ((Math.round(m) % 1440) + 1440) % 1440;
  return `${String(Math.floor(t / 60)).padStart(2, "0")}:${String(t % 60).padStart(2, "0")}`;
}
function _mrtTrains(l, d) {
  const today = _mrtToday(d);
  const first = _mrtMins(today?.first), last = _mrtMins(today?.last);
  if (first == null || last == null) return null;
  const now = _mrtNowMins();
  if (now > last) return null;
  const times = [];
  for (let t = first; t < last - 0.5; t += _mrtHeadway(l, t)) times.push(Math.round(t));
  times.push(last);
  const i = times.findIndex((x) => x >= now);
  if (i < 0) return null;
  return { prev: i > 0 ? times[i - 1] : null, next: times.slice(i, i + 3), now };
}
function _mrtTrainsHtml(tr) {
  if (!tr) return "";
  const chip = (t, cls, sub) => `<span class="mrt-train ${cls}"><b>${_mrtFmt(t)}</b><small>${sub}</small></span>`;
  return `<div class="mrt-trains">
    ${tr.prev != null ? chip(tr.prev, "missed", "Missed") : ""}
    ${tr.next.map((t, k) => chip(t, k === 0 ? "next" : "", t - tr.now <= 0 ? "Now" : `${t - tr.now} min`)).join("")}
  </div>`;
}

function _mrtLineHtml(l) {
  const f = l.frequency;
  const main = l.directions.filter((d) => d.kind === "main");
  const lastOnly = l.directions.filter((d) => d.kind === "short" && d.note === "Last trains only" && _mrtToday(d)?.last);
  const ends = l.directions.filter((d) => d.kind === "short" && /^Ends at/.test(d.note) && _mrtToday(d)?.last);
  const early = l.directions.filter((d) => d.kind === "short" && d.note === "Early trains only" && _mrtToday(d)?.first);
  const statuses = main.map(_mrtStatus);
  const now = _mrtNowMins();
  const noService = l.timetable
    ? statuses.length > 0 && statuses.every((x) => x?.ended)
    : now > 24 * 60 + 30 && now < 29 * 60 + 30;   // ~00:30–05:30, from general hours
  const dirRows = main.map((d, i) => {
    const st = statuses[i], today = _mrtToday(d);
    return `
      <div class="mrt-dir">
        <div class="mrt-dir-to"><span class="mrt-arrow">→</span>${esc(d.to)}</div>
        ${_mrtTrainsHtml(_mrtTrains(l, d))}
        ${today ? `<div class="mrt-dir-times">
          <span><small>First</small> ${esc(today.first || "–")}</span>
          <span><small>Last</small> ${esc(today.last || "–")}</span>
        </div>` : ""}
        ${st ? `<div class="mrt-dir-status ${st.cls}">${esc(st.txt)}</div>` : ""}
      </div>`;
  }).join("");
  const extras = [
    lastOnly.length ? `Last trains that end early: ${lastOnly.map((d) => `${esc(d.to)} ${esc(_mrtToday(d).last)}`).join(" · ")}` : "",
    ends.length ? `Late trains that end early: ${ends.map((d) => `${esc(d.note.replace(/^Ends at /, ""))} ${esc(_mrtToday(d).last)}`).join(" · ")}` : "",
    early.length ? `First trains start from ${early.map((d) => `${esc(d.to)} (${esc(_mrtToday(d).first)})`).join(", ")}` : "",
    !l.timetable ? `Runs ${esc(l.general_hours || "")}. ${esc(l.operator)} doesn't publish first/last train times per station.` : "",
  ].filter(Boolean);
  const disrupted = l.disruption?.length;
  return `
    <section class="mrt-line">
      <div class="mrt-line-hd">
        <span class="mrt-code" style="background:${esc(l.color)}">${esc(l.code)}</span>
        <span class="mrt-line-name">${esc(l.name)}</span>
        <span class="mrt-op">${esc(l.operator)}</span>
      </div>
      ${disrupted ? `<div class="mrt-disrupt">Disruption on this line${l.disruption[0].stations ? ` (${esc(l.disruption[0].stations.replace(/,/g, ", "))})` : ""}</div>` : ""}
      ${noService
        ? `<div class="mrt-freq off"><b>No trains running now</b><span>every ${f.min}–${f.max} min when running</span></div>`
        : `<div class="mrt-freq"><b>Every ${f.min}–${f.max} min</b><span>${f.period === "peak" ? "peak hours" : "off-peak"} · typical</span></div>`}
      ${dirRows}
      ${extras.length ? `<div class="mrt-extras">${extras.map((x) => `<p>${x}</p>`).join("")}</div>` : ""}
    </section>`;
}

function _mrtRender() {
  const d = MRT.data;
  if (!d) return;
  $("mrt-card").innerHTML = `
    <div class="stop-card mrt-head">
      <div class="mrt-head-top">
        <div>
          <div class="stop-name">${esc(d.name)}</div>
          <div class="mrt-head-codes">${_mrtChips(d.lines)}</div>
        </div>
        <button id="mrt-save-btn" class="pillbtn cp-save mrt-save" type="button" aria-pressed="false">
          <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M20.84 4.61a5.5 5.5 0 0 0-7.78 0L12 5.67l-1.06-1.06a5.5 5.5 0 0 0-7.78 7.78l1.06 1.06L12 21.23l7.78-7.78 1.06-1.06a5.5 5.5 0 0 0 0-7.78z"/></svg>
          <span>Save</span>
        </button>
      </div>
      ${d.alert_messages?.length ? `<div class="mrt-alert">${d.alert_messages.map((m) => `<p>${esc(m)}</p>`).join("")}</div>` : ""}
    </div>
    ${d.lines.map(_mrtLineHtml).join("")}
    <p class="mrt-foot">Not live: Singapore doesn't publish live train arrivals. Next trains are estimated from the first train and the line's typical frequency, so they can be a few minutes off. First and last trains are from SMRT's timetable; disruptions are live from LTA.</p>`;
  _mrtSyncSaveBtn();
}

async function _mrtOpen(name) {
  const prev = MRT.sel;
  MRT.sel = name;
  const st = (MRT.stations || []).find((s) => s.name === name);
  if (prev && prev !== name) { const p = (MRT.stations || []).find((s) => s.name === prev); MRT.pins.get(prev)?.setIcon(_mrtPinIcon(p)); }
  if (st) {
    MRT.pins.get(name)?.setIcon(_mrtPinIcon(st, true));
    MRT.pins.get(name)?.setZIndexOffset(1000);
    _mapFocus(_mrtMap, "view-mrt", SGL.latLng(st.lat, st.lng));
  }
  hide($("mrt-nearby")); show($("mrt-detail"));
  $("view-mrt").querySelector(".arr-sheet-scroll").scrollTop = 0;
  $("mrt-card").innerHTML = `<div class="stop-card mrt-head"><div class="stop-name">${esc(name)}</div><p class="cp-status">Loading timings…</p></div>`;
  _snapSheet("mid");
  clearInterval(MRT.tick); clearInterval(MRT.refresh);
  MRT.tick = setInterval(() => { if (S.view === "mrt" && !document.hidden) _mrtRender(); }, 30_000);
  MRT.refresh = setInterval(() => { if (S.view === "mrt" && !document.hidden) _mrtFetch(); }, 120_000);
  await _mrtFetch();
}
async function _mrtFetch() {
  const name = MRT.sel;
  if (!name) return;
  try {
    const d = await api(`/api/mrt/station/${encodeURIComponent(name)}`);
    if (MRT.sel !== name) return;
    MRT.data = d;
    _mrtRender();
  } catch (e) {
    if (MRT.sel === name && !MRT.data) $("mrt-card").innerHTML = `<p class="cp-status">Couldn't load ${esc(name)}: ${esc(e.message)}</p>`;
  }
}
function _mrtBack() {
  clearInterval(MRT.tick); clearInterval(MRT.refresh);
  const prev = MRT.sel;
  MRT.sel = null; MRT.data = null;
  if (prev) { const p = (MRT.stations || []).find((s) => s.name === prev); if (p) { MRT.pins.get(prev)?.setIcon(_mrtPinIcon(p)); MRT.pins.get(prev)?.setZIndexOffset(0); } }
  hide($("mrt-detail")); show($("mrt-nearby"));
  _snapSheet("mid");
}

// ── Saved stations (account-synced; see /api/saved-stations) ──
function _mrtIsSaved(name) { return MRT.saved.some((st) => st.name === name); }

async function _mrtLoadSaved() {
  if (!S.token) { MRT.saved = []; _mrtRenderSaved(); return; }
  try { MRT.saved = (await api("/api/saved-stations")).results || []; }
  catch { /* keep what we had */ }
  _mrtRenderSaved();
}

// Saved stations show at the top of the MRT map list and in the Saved tab;
// the Saved tab rows also preview each direction's next train.
function _mrtRenderSaved() {
  const tabSec = $("mrt-saved");
  if (tabSec) {
    tabSec.classList.toggle("hidden", !MRT.saved.length);
    $("mrt-saved-list").innerHTML = MRT.saved.map((st) => _mrtRow(st)).join("");
  }
  const list = $("saved-mrt-list");
  if (list) {
    $("saved-mrt-empty").classList.toggle("hidden", !!MRT.saved.length);
    list.innerHTML = MRT.saved.map((st) => _mrtRow(st, { removable: true })).join("");
    if (S.view === "saved") _mrtLoadPreviews();
  }
  _mrtSyncSaveBtn();
}

async function _mrtLoadPreviews() {
  await Promise.all(MRT.saved.map(async (st) => {
    try {
      const d = await api(`/api/mrt/station/${encodeURIComponent(st.name)}`);
      const parts = [];
      d.lines.forEach((l) => {
        if (!l.timetable) { parts.push(`${l.code} every ${l.frequency.min}–${l.frequency.max} min`); return; }
        l.directions.filter((x) => x.kind === "main").forEach((x) => {
          const tr = _mrtTrains(l, x);
          parts.push(`→ ${x.to} ${tr ? (tr.next[0] - tr.now <= 0 ? "now" : `${tr.next[0] - tr.now} min`) : "ended"}`);
        });
      });
      document.querySelectorAll(`[data-mrt-preview="${CSS.escape(st.name)}"]`).forEach((el) => {
        el.textContent = parts.join(" · ");
      });
    } catch { /* keep the line names */ }
  }));
}

function _mrtSyncSaveBtn() {
  const btn = $("mrt-save-btn");
  if (!btn || !MRT.sel) return;
  const on = _mrtIsSaved(MRT.sel);
  btn.classList.toggle("on", on);
  btn.setAttribute("aria-pressed", on);
  btn.querySelector("span").textContent = on ? "Saved" : "Save";
}

async function _mrtToggleSave(name) {
  if (!S.token) { toast("Log in to save stations"); openSheet(); return; }
  const path = `/api/saved-stations/${encodeURIComponent(name)}`;
  if (_mrtIsSaved(name)) {
    showConfirm("Remove this station from saved?", "Remove", async () => {
      MRT.saved = MRT.saved.filter((st) => st.name !== name);
      _mrtRenderSaved();
      try { await api(path, { method: "DELETE" }); toast("Removed from saved stations"); }
      catch (e) { toast(`Couldn't remove: ${e.message}`); _mrtLoadSaved(); }
    });
    return;
  }
  const st = (MRT.stations || []).find((x) => x.name === name)
    || (MRT.data?.name === name ? { name, lat: MRT.data.lat, lng: MRT.data.lng, lines: MRT.data.lines } : { name, lines: [] });
  MRT.saved = [st, ...MRT.saved];
  _mrtRenderSaved();
  try { await api(path, { method: "POST" }); toast("Station saved"); }
  catch (e) { toast(`Couldn't save: ${e.message}`); _mrtLoadSaved(); }
}

$("mrt-card").addEventListener("click", (e) => {
  if (e.target.closest("#mrt-save-btn") && MRT.sel) _mrtToggleSave(MRT.sel);
});
$("mrt-saved-list").addEventListener("click", (e) => { const it = e.target.closest("[data-mrt]"); if (it) _mrtOpen(it.dataset.mrt); });
// Saved tab: tap opens the station in MRT mode; × unsaves.
$("saved-mrt-list").addEventListener("click", (e) => {
  const rm = e.target.closest("[data-mrt-unsave]");
  if (rm) { e.stopPropagation(); _mrtToggleSave(rm.dataset.mrtUnsave); return; }
  const it = e.target.closest("[data-mrt]");
  if (!it) return;
  switchView("mrt");
  const open = () => {
    const st = MRT.saved.find((x) => x.name === it.dataset.mrt);
    if (st?.lat != null) _mrtMap.setView([st.lat, st.lng], 16);
    _mrtOpen(it.dataset.mrt);
  };
  if (_mrtMap) open(); else _mrtMapP?.then(() => setTimeout(open, 100));
});

// Search — the station list is small and static, so it's filtered locally.
$("mrt-input").addEventListener("input", async (e) => {
  const q = e.target.value.trim().toLowerCase();
  $("mrt-search-clear").classList.toggle("hidden", !e.target.value);
  const ac = $("mrt-ac");
  if (!q) { hide(ac); return; }
  const list = await _mrtStations().catch(() => []);
  const hits = list.filter((s) => s.name.toLowerCase().includes(q) || s.lines.some((l) => l.code.toLowerCase() === q))
    .sort((a, b) => (a.name.toLowerCase().startsWith(q) ? 0 : 1) - (b.name.toLowerCase().startsWith(q) ? 0 : 1) || a.name.localeCompare(b.name))
    .slice(0, 8);
  ac.innerHTML = hits.length ? hits.map((s) => `
    <button class="ac-item cp-ac-item" data-mrt="${esc(s.name)}">
      <span class="mrt-codes">${_mrtChips(s.lines)}</span>
      <span class="ac-txt"><span class="ac-name">${esc(s.name)}</span></span>
    </button>`).join("") : `<div class="ac-empty">No station matches “${esc(e.target.value.trim())}”</div>`;
  show(ac);
});
$("mrt-search-clear").addEventListener("click", () => { $("mrt-input").value = ""; hide($("mrt-search-clear")); hide($("mrt-ac")); });
$("mrt-ac").addEventListener("click", (e) => {
  const it = e.target.closest("[data-mrt]");
  if (!it) return;
  hide($("mrt-ac")); $("mrt-input").blur();
  _mrtOpen(it.dataset.mrt);
});
$("mrt-list").addEventListener("click", (e) => { const it = e.target.closest("[data-mrt]"); if (it) _mrtOpen(it.dataset.mrt); });
$("mrt-back").addEventListener("click", _mrtBack);
$("mrt-refresh").addEventListener("click", () => _mrtLocate(true));
$("mrt-locate-btn").addEventListener("click", () => _mrtLocate(true));

initTheme();
syncAccountUI();
afterFavsChanged();
renderChips();
loadModelInfo();
hydrateServerFavs();
loadNotifications();
checkBackend();
setupPlanField("from");
setupPlanField("to");
setupHomeSearch();
renderRecents();
_updateSettingsUI();
_updatePlanHomeChip();
_initSheetDrag();
_whenLeaflet(initArrMap);
if ("serviceWorker" in navigator) {
  navigator.serviceWorker.register("sw.js").catch(() => {});
}

// ── First-visit "Add to Home Screen" guide (iPhone + Android) ─
// A one-off guide for first-time phone visitors, with an iPhone / Android
// switch. Each shows a looping, illustrated walkthrough (drawn, not real
// screenshots) with the matching step highlighted. On Android Chrome the
// browser's own install prompt is offered as a one-tap button when available.
// Never shown once installed; reopenable from Settings › Add to Home Screen.
const A2HS_KEY = "sgbus_a2hs_seen";
let _installPrompt = null;   // Android Chrome's deferred beforeinstallprompt

function _isStandalone() {
  return window.navigator.standalone === true ||
    window.matchMedia("(display-mode: standalone)").matches;
}
function _isIos() {
  const ua = navigator.userAgent;
  return /iphone|ipad|ipod/i.test(ua) ||
    (navigator.maxTouchPoints > 1 && /Macintosh/i.test(ua)); // iPadOS reports as Mac
}
function _isAndroid() { return /android/i.test(navigator.userAgent); }
// In-app browsers (Instagram, Facebook, LINE, Android WebViews…) can't add to
// the Home Screen at all, so the guide would only frustrate there.
function _isInAppBrowser() {
  return /FBAN|FBAV|Instagram|Line\/|GSA\/|; wv\)/i.test(navigator.userAgent);
}

addEventListener("beforeinstallprompt", (e) => {
  e.preventDefault();          // keep Chrome's mini-infobar quiet; we offer it in the guide
  _installPrompt = e;
  $("a2hs-install-now")?.classList.remove("hidden");
});
addEventListener("appinstalled", () => {
  _installPrompt = null;
  try { localStorage.setItem(A2HS_KEY, "1"); } catch {}
  dismissInstallGuide();
});

// Illustrated phone mock-ups. Four frames each cycle every 10 s (CSS
// animation): tap 1 → tap 2 → tap 3 → the icon on the Home Screen.
function _a2hsPhone(frames) {
  return `<svg class="a2hs-art" viewBox="0 0 120 220" role="img" aria-label="Animated walkthrough">
    <rect x="1" y="1" width="118" height="218" rx="18" class="m-body"/>
    <rect x="6" y="6" width="108" height="208" rx="14" class="m-screen"/>
    <clipPath id="a2hs-clip-${frames.id}"><rect x="6" y="6" width="108" height="208" rx="14"/></clipPath>
    <g clip-path="url(#a2hs-clip-${frames.id})">
      ${frames.list.map((f, i) => `<g class="f f${i + 1}">${f}</g>`).join("")}
    </g>
  </svg>`;
}
const _tap = (x, y) => `<circle cx="${x}" cy="${y}" r="7" class="m-tap"/><circle cx="${x}" cy="${y}" r="7" class="m-tap-ring"/>`;
const _page = `
  <rect x="6" y="6" width="108" height="208" class="m-page"/>
  <rect x="14" y="40" width="92" height="56" rx="6" class="m-blk"/>
  <rect x="14" y="104" width="70" height="7" rx="3.5" class="m-blk"/>
  <rect x="14" y="117" width="88" height="7" rx="3.5" class="m-blk"/>
  <rect x="14" y="130" width="58" height="7" rx="3.5" class="m-blk"/>`;
const _home = `
  <rect x="6" y="6" width="108" height="208" class="m-wall"/>
  ${[0, 1, 2, 3].flatMap((r) => [0, 1, 2, 3].map((c) => (r === 2 && c === 1) ? "" :
    `<rect x="${17 + c * 24}" y="${30 + r * 34}" width="16" height="16" rx="4.5" class="m-app"/>`)).join("")}
  <circle cx="49" cy="106" r="15" class="m-glow"/>
  <image href="icons/icon-192.png" x="41" y="98" width="16" height="16" style="clip-path: inset(0 round 4.5px)"/>
  <text x="49" y="124" class="m-lbl" text-anchor="middle">SG Bus</text>`;
// A menu row; `wide` rows span the share sheet, others sit in a small popover.
const _row = (y, label, hl = false, wide = false) => `
  <rect x="${wide ? 12 : 48}" y="${y}" width="${wide ? 96 : 62}" height="16" rx="4" class="${hl ? "m-hl" : "m-row"}"/>
  <text x="${wide ? 17 : 52}" y="${y + 10.5}" class="m-txt${hl ? " on" : ""}">${label}</text>`;

const A2HS_ART = {
  ios: { id: "ios", list: [
    // 1. Safari's bottom bar → ••• (or Share on older iOS)
    `${_page}<rect x="6" y="186" width="108" height="28" class="m-bar"/>
     <text x="15" y="203" class="m-ico">‹</text>
     <rect x="27" y="191" width="60" height="15" rx="7.5" class="m-pill"/>
     <text x="57" y="201.5" class="m-txt" text-anchor="middle">alstonshi.com</text>
     <text x="99" y="202" class="m-ico" text-anchor="middle">•••</text>${_tap(99, 199)}`,
    // 2. Menu → Share
    `${_page}<rect x="6" y="186" width="108" height="28" class="m-bar"/>
     <rect x="44" y="118" width="70" height="64" rx="8" class="m-sheet"/>
     ${_row(122, "Share", true)}${_row(141, "Add Bookmark")}${_row(160, "Find on Page")}${_tap(98, 130)}`,
    // 3. Share sheet → Add to Home Screen
    `${_page}<rect x="6" y="104" width="108" height="110" rx="10" class="m-sheet"/>
     <rect x="50" y="109" width="20" height="3" rx="1.5" class="m-blk"/>
     ${_row(120, "Copy", false, true)}
     ${_row(140, "Add to Favourites", false, true)}
     ${_row(160, "Add to Home Screen ⊞", true, true)}${_tap(90, 168)}`,
    _home,
  ] },
  android: { id: "android", list: [
    // 1. Chrome's top bar → ⋮
    `${_page}<rect x="6" y="6" width="108" height="26" class="m-bar"/>
     <rect x="12" y="11" width="78" height="15" rx="7.5" class="m-pill"/>
     <text x="51" y="21.5" class="m-txt" text-anchor="middle">alstonshi.com/bus</text>
     <text x="103" y="23" class="m-ico" text-anchor="middle">⋮</text>${_tap(103, 19)}`,
    // 2. Menu → Add to home screen
    `${_page}<rect x="6" y="6" width="108" height="26" class="m-bar"/>
     <rect x="44" y="20" width="70" height="88" rx="6" class="m-sheet"/>
     ${_row(24, "New tab")}${_row(44, "Bookmarks")}${_row(64, "Add to home…", true)}${_row(84, "Share…")}${_tap(98, 72)}`,
    // 3. Confirm → Install
    `${_page}<rect x="6" y="6" width="108" height="208" class="m-dim"/>
     <rect x="14" y="78" width="92" height="62" rx="8" class="m-sheet"/>
     <text x="21" y="92" class="m-txt on">Add to home screen</text>
     <image href="icons/icon-192.png" x="21" y="99" width="13" height="13"/>
     <text x="39" y="108.5" class="m-txt">SG Bus</text>
     <text x="56" y="131" class="m-txt">Cancel</text>
     <rect x="78" y="122" width="24" height="13" rx="6.5" class="m-btn"/>
     <text x="90" y="131" class="m-txt m-btn-t" text-anchor="middle">Install</text>${_tap(90, 128)}`,
    _home,
  ] },
};

const A2HS_STEPS = {
  ios: [
    `Tap <b>•••</b> in Safari's bottom bar <span class="a2hs-dim">(older iPhones: the <b>Share</b> button)</span>`,
    `Tap <b>Share</b>`,
    `Tap <b>Add to Home Screen</b>, then <b>Add</b>`,
  ],
  android: [
    `Tap <b>⋮</b> at the top right of Chrome`,
    `Tap <b>Add to home screen</b> <span class="a2hs-dim">(or <b>Install app</b>)</span>`,
    `Tap <b>Install</b> or <b>Add</b>`,
  ],
};
const A2HS_HINT = {
  ios: `Don't see it? Scroll down the share sheet, or tap <b>Edit Actions…</b>. In Chrome on iPhone, use the Share button in the address bar.`,
  android: `Samsung Internet: tap <b>≡</b> › <b>Add page to</b> › <b>Home screen</b>.`,
};

function _renderInstallGuide(platform) {
  $("a2hs-body").innerHTML = `
    <div class="a2hs-plat" role="tablist" aria-label="Phone type">
      ${[["ios", "iPhone"], ["android", "Android"]].map(([k, l]) =>
        `<button type="button" role="tab" class="a2hs-plat-btn${k === platform ? " active" : ""}" data-plat="${k}" aria-selected="${k === platform}">${l}</button>`).join("")}
    </div>
    ${platform === "android" ? `<button id="a2hs-install-now" class="a2hs-install-now${_installPrompt ? "" : " hidden"}" type="button">Install now</button>` : ""}
    <div class="a2hs-demo">
      ${_a2hsPhone(A2HS_ART[platform])}
      <ol class="a2hs-steps">
        ${A2HS_STEPS[platform].map((t, i) => `<li class="s${i + 1}"><span class="a2hs-step-n">${i + 1}</span><span>${t}</span></li>`).join("")}
        <li class="s4 a2hs-done"><span class="a2hs-step-n">✓</span><span>SG Bus is on your Home Screen</span></li>
      </ol>
    </div>
    <p class="a2hs-hint">${A2HS_HINT[platform]}</p>`;
}
$("a2hs-body")?.addEventListener("click", async (e) => {
  const tab = e.target.closest(".a2hs-plat-btn");
  if (tab) { _renderInstallGuide(tab.dataset.plat); return; }
  if (e.target.closest("#a2hs-install-now") && _installPrompt) {
    const p = _installPrompt; _installPrompt = null;
    p.prompt();
    try { const { outcome } = await p.userChoice; if (outcome === "accepted") dismissInstallGuide(); } catch {}
    $("a2hs-install-now")?.classList.add("hidden");
  }
});

function dismissInstallGuide() {
  const el = $("a2hs-guide");
  if (!el || el.classList.contains("hidden")) return;
  el.classList.remove("show");
  setTimeout(() => el.classList.add("hidden"), 320);
}

function openInstallGuide(platform) {
  const el = $("a2hs-guide");
  if (!el) return;
  _renderInstallGuide(platform || (_isAndroid() ? "android" : "ios"));
  el.classList.remove("hidden");
  requestAnimationFrame(() => el.classList.add("show"));
}

function maybeShowInstallGuide() {
  const force = new URLSearchParams(location.search).get("a2hs");   // preview: ?a2hs=ios|android
  if (!$("a2hs-guide")) return;
  if (!force) {
    if (localStorage.getItem(A2HS_KEY)) return;
    if (_isStandalone()) { localStorage.setItem(A2HS_KEY, "1"); return; }
    if (!(_isIos() || _isAndroid()) || _isInAppBrowser()) return;   // phones only
  }
  setTimeout(() => {
    // One thing at a time: if a notification popup is up, don't stack the guide.
    // Leave the flag unset so it gets its turn on a future visit.
    if (_isOpen("notif-popup") || _isOpen("fb-popup")) return;
    openInstallGuide(force === "android" || force === "ios" ? force : null);
    localStorage.setItem(A2HS_KEY, "1");
  }, 1600);
}

$("a2hs-close")?.addEventListener("click", dismissInstallGuide);
$("a2hs-got")?.addEventListener("click", dismissInstallGuide);
$("a2hs-guide")?.querySelector(".a2hs-backdrop")?.addEventListener("click", dismissInstallGuide);
$("stg-install-btn")?.addEventListener("click", () => {
  if (_isStandalone()) { toast("SG Bus is already on your Home Screen"); return; }
  openInstallGuide();
});
maybeShowInstallGuide();

// Warm the offline stop directory once the app is idle, so search/nearby keep
// working without a connection. Cheap no-op when the cache is already fresh.
(window.requestIdleCallback || ((fn) => setTimeout(fn, 2500)))(() => ensureStopsCache());

// Boot: shared journey URL takes priority; ?stop=/?loadStop= deep links next; stop hash last
const bootStop = location.hash.replace("#", "").trim();
const _bootParams = new URLSearchParams(location.search);
const hasShareParams = _bootParams.get("fName");
// ?stop= (shared stop link) and ?loadStop= (legacy alias) both work.
const stopParam = _bootParams.get("stop") || _bootParams.get("loadStop");
if (hasShareParams) {
  bootFromUrl();
} else if (stopParam && /^\d{5}$/.test(stopParam)) {
  loadStop(stopParam);
  history.replaceState(null, "", location.pathname);
} else if (/^\d{5}$/.test(bootStop)) {
  loadStop(bootStop);
}

// ── Feedback ──────────────────────────────────────────────────────────────────
(() => {
  const overlay  = $("feedback-overlay");
  const closeBtn = $("feedback-close");
  const laterBtn = $("feedback-later");
  const submitBtn = $("feedback-submit");
  const starsEl  = $("feedback-stars");
  const textEl   = $("feedback-text");
  const openBtn  = $("feedback-open-btn");
  if (!overlay) return;

  let _rating = 0;

  function _openFeedback(ctx = "") {
    overlay._ctx = ctx;
    overlay.classList.remove("hidden");
  }
  function _closeFeedback() {
    overlay.classList.add("hidden");
  }

  // Star rating
  starsEl?.addEventListener("click", (e) => {
    const btn = e.target.closest(".fb-star");
    if (!btn) return;
    _rating = parseInt(btn.dataset.v, 10);
    starsEl.querySelectorAll(".fb-star").forEach((b) =>
      b.classList.toggle("selected", parseInt(b.dataset.v, 10) <= _rating));
    submitBtn.disabled = false;
  });

  // Enable submit when text is typed (even without rating)
  textEl?.addEventListener("input", () => {
    submitBtn.disabled = !_rating && !textEl.value.trim();
  });

  const errEl = $("feedback-error");
  submitBtn?.addEventListener("click", async () => {
    submitBtn.disabled = true;
    submitBtn.textContent = "Sending…";
    hide(errEl);
    const msg = textEl?.value.trim() || null;
    const params = new URLSearchParams();
    if (_rating) params.set("rating", _rating);
    if (msg)     params.set("message", msg);
    if (overlay._ctx) params.set("context", overlay._ctx);
    try {
      await api(`/api/feedback?${params}`, { method: "POST" });
      _closeFeedback();
      toast("Thanks for your feedback!");
    } catch (e) {
      errEl.textContent = "Couldn't send — check your connection and try again.";
      show(errEl);
      submitBtn.disabled = false;
      submitBtn.textContent = "Send";
      return;
    }
    // Reset
    _rating = 0;
    submitBtn.textContent = "Send";
    submitBtn.disabled = true;
    hide(errEl);
    starsEl?.querySelectorAll(".fb-star").forEach((b) => b.classList.remove("selected"));
    if (textEl) textEl.value = "";
  });

  closeBtn?.addEventListener("click", _closeFeedback);
  laterBtn?.addEventListener("click", _closeFeedback);
  overlay.addEventListener("click", (e) => { if (e.target === overlay) _closeFeedback(); });

  openBtn?.addEventListener("click", () => _openFeedback("settings"));

  // Auto-prompt: every 10th app open, after 90 seconds of use
  const COUNT_KEY  = "fbOpenCount";
  const count = parseInt(localStorage.getItem(COUNT_KEY) || "0", 10) + 1;
  localStorage.setItem(COUNT_KEY, count);
  if (count % 10 === 0 && !sessionStorage.getItem("fbShownThisSession")) {
    sessionStorage.setItem("fbShownThisSession", "1");
    setTimeout(() => {
      if (!overlay.classList.contains("hidden")) return; // already open
      _openFeedback("auto");
    }, 90_000); // 90 seconds into the session
  }
})();
