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
const THEME_KEY  = "sgbus_theme";
const TOKEN_KEY  = "sgbus_token";
const USER_KEY   = "sgbus_user";
// Version scheme — MAJOR.MINOR.PATCH (semver-style):
//   MAJOR  → big monthly overhauls / redesigns
//   MINOR  → new features
//   PATCH  → bug fixes & small tweaks (bumped on most pushes)
// Bump this on every push and keep the <span id="stg-version-val"> in
// index.html in sync.
const APP_VERSION = "1.1.30";

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
  toastTmr = setTimeout(() => hide(t), 2200);
}

function showConfirm(msg, okLabel, onConfirm) {
  const el = document.createElement("div");
  el.className = "confirm-overlay";
  el.innerHTML = `<div class="confirm-card">
    <p class="confirm-msg">${msg}</p>
    <div class="confirm-btns">
      <button class="confirm-cancel">Cancel</button>
      <button class="confirm-ok">${okLabel}</button>
    </div>
  </div>`;
  document.body.appendChild(el);
  el.querySelector(".confirm-cancel").addEventListener("click", () => el.remove());
  el.querySelector(".confirm-ok").addEventListener("click", () => { el.remove(); onConfirm(); });
  el.addEventListener("click", (e) => { if (e.target === el) el.remove(); });
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
  const meta = document.getElementById("theme-color-meta");
  if (meta) meta.content = t === "light" ? "#f2f3f5" : "#0d0e10";
}
function initTheme() {
  const saved = localStorage.getItem(THEME_KEY);
  const system = matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
  applyTheme(saved || system);
}
// theme-btn is now the "Light" seg button in Settings; toggling handled there

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
  $("account-dot")?.classList.toggle("hidden", !loggedIn);
  $("auth-forms").classList.toggle("hidden", loggedIn);
  $("auth-profile").classList.toggle("hidden", !loggedIn);
  if (loggedIn) {
    $("profile-name").textContent = S.username;
    $("profile-avatar").textContent = (S.username || "?")[0];
  }
  $("saved-sync-note").textContent = loggedIn
    ? `Synced to ${S.username}'s account · monitored 24/7 for sharper predictions`
    : "";
  $("nav-data-btn")?.classList.toggle("hidden", !admin);
  if (S.view === "data" && !admin) switchView("arrivals");
  _updateSettingsUI();
}

function _updateSettingsUI() {
  const loggedIn = !!S.token;
  const lbl = $("stg-account-label");
  if (lbl) lbl.textContent = loggedIn ? S.username : "Sign in";
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
        api(`/api/stops/search?q=${encodeURIComponent(v)}&limit=4`).catch(() => ({ results: [] })),
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
function closeSheet() { hide($("sheet-backdrop")); hide($("account-sheet")); }

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
  setAuth(res.token, res.username);
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
    await completeLogin(res, S.authMode === "login" ? `Welcome back, ${res.username}` : "Account created");
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
    await completeLogin(res, `Welcome, ${res.username}`);
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
  hide($("notif-section"));
  toast("Logged out");
});

// ── Notifications ──────────────────────────────────────────────────────────────

async function loadNotifications() {
  if (!S.token) return;
  try {
    const data = await api("/api/notifications");
    const items = data.items || [];
    const unread = data.unread || 0;

    const dot = $("stg-notif-dot");
    const badge = $("notif-unread-badge");
    const markBtn = $("notif-mark-read");

    if (dot) dot.classList.toggle("hidden", unread === 0);
    if (badge) { badge.textContent = unread; badge.classList.toggle("hidden", unread === 0); }
    if (markBtn) markBtn.classList.toggle("hidden", unread === 0);

    const list = $("notif-list");
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
            ${n.body ? `<div class="notif-body">${esc(n.body)}</div>` : ""}
            <div class="notif-time">${esc(fmtDate(n.created_at))}</div>
          </div>`).join("")
      : `<p class="notif-empty">No notifications yet.</p>`;

    show($("notif-section"));
  } catch { /* not logged in or API unavailable */ }
}

$("notif-mark-read")?.addEventListener("click", async () => {
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
      <div class="chips-label">${label}</div>
      <div class="chips-row">${items.map((f) => `
        <div class="chip-wrap">
          <button class="chip" data-code="${esc(f.code)}">
            <span class="chip-code">${esc(f.code)}</span>
            ${f.description ? `<span class="chip-name">${esc(f.description)}</span>` : ""}
          </button>
          ${deletable ? `<button class="chip-del" data-del="${esc(f.code)}" aria-label="Remove">×</button>` : ""}
        </div>`).join("")}
      </div>`).join("");
}
$("chips-area").addEventListener("click", (e) => {
  const del = e.target.closest(".chip-del");
  if (del) { removeRecent(del.dataset.del); return; }
  const chip = e.target.closest(".chip");
  if (chip) loadStop(chip.dataset.code);
});

// ── Views / bottom nav ────────────────────────────────────
function switchView(name) {
  if (name === "data" && !isAdmin()) name = "arrivals";
  if (name === "map") name = "arrivals"; // map is now embedded in arrivals
  S.view = name;
  document.querySelectorAll(".nav-item").forEach((b) =>
    b.classList.toggle("active", b.dataset.view === name));
  document.querySelectorAll(".view").forEach((v) =>
    v.classList.toggle("active", v.id === `view-${name}`));
  if (name === "saved") renderSaved();
  if (name === "data") loadData();
  if (name === "arrivals") setTimeout(() => _arrMap?.invalidateSize(), 60);
  if (name === "settings") _updateSettingsUI();
  if (name === "checkpoint") loadCheckpoint();
}
document.querySelectorAll(".nav-item").forEach((b) =>
  b.addEventListener("click", () => switchView(b.dataset.view)));

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
      _cpRefreshTmr = setTimeout(() => {
        _cpData = null;
        if (S.view === "checkpoint") loadCheckpoint();
      }, 120_000);
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
    $("cp-updated").textContent = `Updated ${fmtClock(t)} · data.gov.sg`;
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
        <button class="cp-cp-refresh iconbtn" aria-label="Refresh carpark">
          <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><polyline points="23 4 23 10 17 10"/><path d="M20.49 15a9 9 0 1 1-2.12-9.36L23 10"/></svg>
        </button>
      </div>
    </div>
    <div class="cp-cp-bar-track">
      <div class="cp-cp-bar-fill ${status}" style="width:${pct}%"></div>
    </div>`;
  el.querySelector(".cp-cp-refresh").addEventListener("click", () => {
    _cpData = null; loadCheckpoint(true);
  });
  show(el);
}

function _renderCamGrid(camEl, cameras, bust) {
  if (!cameras.length) {
    camEl.innerHTML = `<p class="empty" style="font-size:.82rem;padding:.5rem 0">No camera feeds found.</p>`;
    return;
  }
  camEl.innerHTML = cameras.map((c) => `
    <div class="cp-camera-card">
      <img class="cp-camera-img" src="${esc(c.url + bust)}" alt="Traffic camera" loading="lazy" />
      <div class="cp-camera-label">${esc(CP_CAM_LABELS[c.id] || `Camera ${c.id}`)}</div>
    </div>`).join("");
}

function _renderCpPanel(key, cp) {
  if (!cp) return;
  const bust  = `?t=${Date.now()}`;
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
      _renderCamGrid(body, cams, bust);
    }
    camEl.addEventListener("click", (e) => {
      const btn = e.target.closest(".cp-cam-dir-tab");
      if (btn) showDir(parseInt(btn.dataset.dir));
    });
    showDir(0);
  } else if (cp.cameras && cp.cameras.length) {
    _renderCamGrid(camEl, cp.cameras, bust);
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

$("cp-refresh-btn").addEventListener("click", () => { _cpData = null; loadCheckpoint(true); loadCpBus(); });

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
      api(`/api/stops/search?q=${encodeURIComponent(q)}&limit=6`).catch(() => ({ results: [] })),
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
      const near = await api(`/api/stops/nearby?lat=${item.dataset.lat}&lng=${item.dataset.lng}&limit=1`);
      const s = (near.results || [])[0];
      if (s) loadStop(s.bus_stop_code); else toast("No nearby bus stops");
    } catch { toast("Couldn't find nearby stops"); }
    return;
  }
  if (item.dataset.code) loadStop(item.dataset.code);
});
document.addEventListener("click", (e) => {
  if (!$("autocomplete").contains(e.target) && e.target !== input
      && !e.target.closest("#near-btn")) hideAc();
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
  const TYPE_LABEL = { SD: "Single deck", DD: "Double deck", BD: "Bendy" };
  const tags = [
    next.type && next.type !== "SD" ? `<span class="tag" title="${TYPE_LABEL[next.type] || next.type}">${esc(next.type)}</span>` : "",
    next.feature === "WAB" ? `<span class="tag wab" title="Wheelchair accessible">♿</span>` : "",
  ].join("");
  return `
    <div class="svc" data-svc="${esc(svc.service_no)}">
      <button class="svc-head">
        <span class="route-badge">${esc(svc.service_no)}</span>
        <span class="svc-mid">
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
}

$("rows").addEventListener("click", (e) => {
  // Clicking the route badge opens the route viewer instead of toggling expand
  const badge = e.target.closest(".route-badge");
  if (badge) {
    const svc = badge.closest(".svc");
    if (svc) loadBusRoute(svc.dataset.svc);
    return;
  }
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
    S.stopInfo = info;
    S.stats = stats;
    $("stop-name").textContent = info?.description || "Bus stop";
    $("stop-road").textContent = info?.road_name || "";
    renderArrivals(arrivals);
    show($("stats-details"));
    show($("about-details"));
    show($("legend-details"));
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
  try {
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

    // Feedback (admin only)
    try {
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
    } catch { /* not admin or endpoint unavailable */ }

    // Notifications admin block
    try {
      await _loadAdminNotifications();
      show($("notif-admin-block"));
    } catch { /* not admin */ }
  } catch (err) {
    $("data-grid").innerHTML = "";
    const el = $("data-error");
    el.textContent = `Couldn't load data: ${err.message}`;
    show(el);
  }
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
            <button class="fb-admin-del" data-del-notif="${n.id}" aria-label="Delete">
              <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M3 6h18M19 6l-1 14H6L5 6M10 11v6M14 11v6M9 6V4h6v2"/></svg>
            </button>
          </div>
          ${n.body ? `<div class="notif-admin-body">${esc(n.body)}</div>` : ""}
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
    if (field === "from") _updatePlanHomeChip();
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

// ── Arrivals map ──────────────────────────────────────────
let _arrMap       = null;
let _arrTileLayer = null;
let _arrLocMarker = null;
let _arrPinStore  = new Map(); // code → { marker, label }

function _syncTopbarH() { /* topbar removed */ }

// ── Draggable bottom sheet ────────────────────────────────
function _setSheetH(px) {
  document.documentElement.style.setProperty("--sheet-h", Math.round(px) + "px");
}
// Compute the three snap heights in px. The max is capped so the sheet's top
// always stays just below the floating search bar — otherwise it swallows the
// search bar and the drag handle becomes unreachable.
function _sheetSnaps() {
  const sheet  = document.querySelector(".arr-sheet");
  const search = document.querySelector(".arr-search-wrap");
  const bottomY = sheet ? sheet.getBoundingClientRect().bottom : innerHeight;
  const searchBottom = search ? search.getBoundingClientRect().bottom : 80;
  const min = Math.round(innerHeight * 0.22);
  const mid = Math.round(innerHeight * 0.46);
  const max = Math.max(mid + 1, Math.round(bottomY - searchBottom - 12));
  return { min, mid, max };
}
function _snapSheet(name) {
  const s = _sheetSnaps();
  _setSheetH(s[name] ?? s.mid);
  setTimeout(() => _arrMap?.invalidateSize(), 280);
}
function _initSheetDrag() {
  const sheet  = document.querySelector(".arr-sheet");
  const handle = document.querySelector(".arr-sheet-handle");
  if (!sheet || !handle) return;
  _snapSheet("mid");

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
    const snaps = Object.values(_sheetSnaps());
    _setSheetH(snaps.reduce((a, b) => (Math.abs(b - h) < Math.abs(a - h) ? b : a)));
    setTimeout(() => _arrMap?.invalidateSize(), 280);
  };
  handle.addEventListener("pointerup", end);
  handle.addEventListener("pointercancel", end);
}

function initArrMap() {
  if (!_leafletReady()) { _whenLeaflet(initArrMap); return; }
  _syncTopbarH();
  if (_arrMap) { setTimeout(() => _arrMap.invalidateSize(), 60); return; }
  _arrMap = L.map($("arr-map"), { zoomControl: false, attributionControl: false })
             .setView([1.3521, 103.8198], 15);
  // Colourful voyager tiles; dark mode applies a CSS invert filter that
  // darkens the map while keeping hues (water, parks, roads) — see styles.css.
  _arrTileLayer = _sgTiles().addTo(_arrMap);
  $("arr-locate-btn").addEventListener("click", _arrGeolocate);
  _arrGeolocate();
}

// Theme toggle hook — the dark map look is a pure-CSS filter keyed on the
// theme attribute, so the tiles themselves never need swapping.
function _swapArrTiles() {}

function _arrGeolocate() {
  _loadArrStops(1.3521, 103.8198);
  navigator.geolocation?.getCurrentPosition(
    ({ coords: { latitude: lat, longitude: lng } }) => {
      if (!_arrMap) return;
      _arrMap.setView([lat, lng], 16);
      if (_arrLocMarker) _arrLocMarker.remove();
      _arrLocMarker = L.circleMarker([lat, lng], {
        radius: 8, color: "#fff", fillColor: "#3b82f6", fillOpacity: 1, weight: 2.5,
      }).addTo(_arrMap);
      _loadArrStops(lat, lng);
    },
    () => {},
    { enableHighAccuracy: false, timeout: 8000, maximumAge: 300000 }
  );
}

async function _loadArrStops(lat, lng) {
  if (!_arrMap) return;
  try {
    const d = await api(`/api/stops/nearby?lat=${lat}&lng=${lng}&limit=20`);
    const stops = d.results || [];
    // Add pins (skip duplicates)
    stops.forEach((s) => {
      if (!s.latitude || _arrPinStore.has(s.bus_stop_code)) return;
      const label = s.description || s.bus_stop_code;
      const marker = L.marker([s.latitude, s.longitude], {
        icon: _stopPinIcon(label, true), title: label,
      }).addTo(_arrMap);
      marker._icon?.querySelector(".stop-pin-btn")?.addEventListener("click", (e) => {
        e.stopPropagation();
        loadStop(s.bus_stop_code);
      });
      _arrPinStore.set(s.bus_stop_code, { marker, label, stop: s });
    });
    _arrMap.invalidateSize();
    _renderArrNearbyList(stops);
  } catch {}
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
      <span class="arr-stop-dist">${Math.round(s.distance_m)} m</span>
      <svg class="arr-stop-chev" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round"><path d="m9 18 6-6-6-6"/></svg>
    </button>`).join("");
  show(section);
}

$("arr-stops-list").addEventListener("click", (e) => {
  const btn = e.target.closest(".arr-stop-item");
  if (btn) loadStop(btn.dataset.code);
});

// Tap the stop-card header to collapse back to nearby list.
$("stop-card").addEventListener("click", () => {
  if ($("arr-detail").classList.contains("hidden")) return;
  $("arr-back-btn").click();
});

$("arr-back-btn").addEventListener("click", () => {
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
  marker.setIcon(L.divIcon({
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

// Retry a map call once Leaflet has loaded (for hash/URL auto-loads that run before defer scripts)
function _whenLeaflet(fn) {
  if (_leafletReady()) { fn(); return; }
  window.addEventListener("load", fn, { once: true });
}

function _isDark() {
  const t = document.documentElement.dataset.theme;
  return t === "dark" || (!t && window.matchMedia("(prefers-color-scheme: dark)").matches);
}

function _sgTiles() {
  return L.tileLayer(
    "https://{s}.basemaps.cartocdn.com/rastertiles/voyager/{z}/{x}/{y}{r}.png",
    { maxZoom: 19, subdomains: "abcd", detectRetina: true, keepBuffer: 3,
      attribution: '© <a href="https://openstreetmap.org">OSM</a> © <a href="https://carto.com">CARTO</a>' }
  );
}

function _darkTiles() {
  return L.tileLayer(
    "https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png",
    { maxZoom: 19, subdomains: "abcd", detectRetina: true, keepBuffer: 3,
      attribution: '© <a href="https://openstreetmap.org">OSM</a> © <a href="https://carto.com">CARTO</a>' }
  );
}

// HTML divIcon marker — taps fire reliably on iOS, unlike SVG circleMarkers
// (Leaflet 1.7+ dropped its tap handler, so vector layers miss touch clicks).
// noLabel: omit the text label (used on the arrivals map where many pins
// would otherwise overlap into an unreadable mess).
function _stopPinIcon(label, noLabel = false) {
  const lbl = noLabel ? "" : `<span class="stop-pin-label">${esc(label || "")}</span>`;
  return L.divIcon({
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
    _sgTiles().addTo(card._jmap);
    // Add fit-to-route button
    const wrap = card.querySelector(".jcard-map-wrap");
    if (wrap) {
      const btn = document.createElement("button");
      btn.className = "jcard-map-fit";
      btn.title = "Fit route";
      btn.innerHTML = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" width="16" height="16"><path d="M12 22s-8-4.5-8-11.8A8 8 0 0 1 12 2a8 8 0 0 1 8 8.2c0 7.3-8 11.8-8 11.8z"/><circle cx="12" cy="10" r="3"/></svg>`;
      btn.addEventListener("click", () => {
        if (card._jmapBounds?.length) card._jmap.fitBounds(card._jmapBounds, { padding: [24, 24] });
      });
      wrap.appendChild(btn);
    }
  }
  card._jmapBounds = _drawOnMap(card._jmap, data, coords, optIdx);
  // Wait for the card expand animation (0.3s) before invalidating size
  setTimeout(() => card._jmap?.invalidateSize(), 350);
}

function _drawOnMap(map, data, coords, optIdx = 0) {
  map.eachLayer((l) => { if (!(l instanceof L.TileLayer)) l.remove(); });

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
      _sgTiles().addTo(_pickerMap);
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
  api(`/api/stops/nearby?lat=${lat}&lng=${lng}&limit=40`).then((d) => {
    if (!_pickerMap) return;
    _pickerLayers.forEach((m) => m.remove());
    _pickerLayers = [];

    const stopIcon = L.divIcon({
      className: "",
      html: `<div style="width:12px;height:12px;border-radius:50%;background:var(--accent);border:2.5px solid #fff;box-shadow:0 1px 4px rgba(0,0,0,.35)"></div>`,
      iconSize: [12, 12], iconAnchor: [6, 6],
    });
    const stopIconSel = L.divIcon({
      className: "",
      html: `<div style="width:16px;height:16px;border-radius:50%;background:var(--accent);border:3px solid #fff;box-shadow:0 2px 6px rgba(0,0,0,.5)"></div>`,
      iconSize: [16, 16], iconAnchor: [8, 8],
    });

    d.results?.forEach((s) => {
      if (!s.latitude) return;
      const isSelected = _pickerStop?.bus_stop_code === s.bus_stop_code;
      const m = L.marker([s.latitude, s.longitude], { icon: isSelected ? stopIconSel : stopIcon })
        .on("click", () => _selectPickerStop(s))
        .addTo(_pickerMap);
      // Simple tooltip on hover for desktop
      m.bindTooltip(`<b>${esc(s.description)}</b><br><span style="font-size:.8em;color:#888">${s.bus_stop_code} · ${s.road_name || ""}</span>`,
        { direction: "top", offset: [0, -8], opacity: 1 });
      _pickerLayers.push(m);
    });
  }).catch(() => {});
}

function _selectPickerStop(stop) {
  _pickerStop = stop;
  $("stop-picker-sel-name").textContent = stop.description || stop.bus_stop_code;
  $("stop-picker-sel-meta").textContent =
    [stop.road_name, stop.bus_stop_code, stop.distance_m ? `${stop.distance_m} m away` : ""]
    .filter(Boolean).join(" · ");
  show($("stop-picker-selected"));
  // Re-render markers so selected one uses bigger icon
  if (_pickerMap) {
    const c = _pickerMap.getCenter();
    _loadPickerStops(c.lat, c.lng);
  }
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

// Boot: shared journey URL takes priority; map.html posts ?loadStop=CODE; stop hash last
const bootStop = location.hash.replace("#", "").trim();
const _bootParams = new URLSearchParams(location.search);
const hasShareParams = _bootParams.get("fName");
const hasLoadStop   = _bootParams.get("loadStop");
if (hasShareParams) {
  bootFromUrl();
} else if (hasLoadStop && /^\d{5}$/.test(hasLoadStop)) {
  loadStop(hasLoadStop);
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
