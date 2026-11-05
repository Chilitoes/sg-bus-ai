/* SG Bus — live 3D buses on the Bus map.

   When a stop is open, every bus coming to it within ~30 min is drawn on the
   map: a 3D Singapore bus (single-decker, double-decker or bendy, as LTA
   reports the bus type) driving along its route towards the stop, with a
   chip showing the service and ETA. A timeline strip in the stop sheet lays
   the same buses out by arrival time; tap one to fly to it.

   Where a bus is
   --------------
   Each service's route is reduced to a path of its stops leading up to this
   one (straight lines stop to stop). A bus's place on that path, in metres
   before the stop, comes from its live LTA GPS position (projected onto the
   path) or, when LTA has none, from its ETA × a typical bus speed. Between
   the 30 s refreshes the bus keeps moving at the speed that gets it to the
   stop on time (dead reckoning), and fresh positions are blended in over a
   couple of seconds instead of jumping.

   Drawing
   -------
   The models are built in code with three.js (no external model file), one
   merged, vertex-coloured mesh per bus type plus an LED destination sign, and
   drawn in a MapLibre custom layer so they sit in the same 3D scene as the
   buildings. They're shown larger than life, scaled with zoom, or they'd be a
   few pixels long. If the map fell back to flat Leaflet (no WebGL), buses are
   flat HTML markers instead. Depends on app.js globals (S, SGL, GLMap,
   _arrMap, _arrMapP, _routeData, _routeDirFor, _loadStopsCache, esc, …). */

(() => {
  const THREE_URL = "https://unpkg.com/three@0.149.0/build/three.min.js";
  const THREE_SRI = "sha384-RRHfJ6w1mTlKUBMYT/hvnRiOzEB/vyRV3DrQOseb6oYfvaZSfdd0byS4bHps0k2R";
  const MAX_ETA = 30 * 60;      // show buses due within 30 min
  const PER_SVC = 2;            // at most this many buses per service
  const EST_SPEED = 6;          // m/s, for buses with no GPS (≈ 22 km/h incl. stops)
  const FPS = 30;

  let threeP = null;
  function loadThree() {
    if (window.THREE) return Promise.resolve(window.THREE);
    threeP ||= new Promise((res, rej) => {
      const s = document.createElement("script");
      s.src = THREE_URL; s.integrity = THREE_SRI; s.crossOrigin = "anonymous";
      s.onload = () => res(window.THREE);
      s.onerror = () => { threeP = null; rej(new Error("three.js failed to load")); };
      document.head.appendChild(s);
    });
    return threeP;
  }

  // ── Local flat coordinates (metres east / north of the stop) ──
  const R = 6371000, RAD = Math.PI / 180;
  const toXY = (lat, lng, ref) => [(lng - ref.lng) * RAD * R * Math.cos(ref.lat * RAD), (lat - ref.lat) * RAD * R];
  const fromXY = (x, y, ref) => ({ lat: ref.lat + y / (RAD * R), lng: ref.lng + x / (RAD * R * Math.cos(ref.lat * RAD)) });

  let _llMap = null, _llSrc = null;
  function stopLL(code) {
    const arr = _loadStopsCache();
    if (arr !== _llSrc) { _llSrc = arr; _llMap = new Map(arr.map((s) => [s.bus_stop_code, s])); }
    const s = _llMap.get(code);
    return s && s.latitude != null ? { lat: s.latitude, lng: s.longitude } : null;
  }

  // Road shape of a service (server-side, from OSRM; see route_shapes.py).
  // null while the server is still preparing it — asked again after 25 s.
  const shapeCache = new Map();   // svc → { data, at }
  async function shapeFor(svc) {
    const c = shapeCache.get(svc);
    if (c && (c.data || Date.now() - c.at < 25000)) return c.data;
    let data = null;
    try { const r = await api(`/api/routes/${encodeURIComponent(svc)}/shape`); data = r.pending ? null : r; } catch { /* older backend */ }
    shapeCache.set(svc, { data, at: Date.now() });
    return data;
  }

  // Path leading to `stop` on service `svc`, from the stop backwards:
  // pts[0] = the stop, cum[k] = metres along the road to pts[k]. Follows the
  // roads when the server has the route's shape; until then, straight lines
  // between stops (`road: false`, rebuilt on a later refresh).
  const pathCache = new Map();
  function pathFor(svc, stop, ref) {
    const key = `${svc}|${stop}`;
    const hit = pathCache.get(key);
    if (hit && !(hit.road === false && Date.now() - hit.at > 25000)) return hit.p;
    const p = Promise.all([_routeData(svc), shapeFor(svc)]).then(([data, shape]) => {
      const { d, i } = _routeDirFor(data, stop);
      if (i < 1) return null;
      let lls = null, stopPts = null;   // stopPts: index in pts of each earlier stop
      const sh = shape?.directions?.find((x) => x.direction === d.direction);
      if (sh && sh.stop_index.length === d.stops.length && sh.stop_index[i] > 0) {
        lls = sh.coords.slice(0, sh.stop_index[i] + 1).reverse().map(([lat, lng]) => ({ lat, lng }));
        stopPts = sh.stop_index.slice(0, i).map((k) => sh.stop_index[i] - k);
      }
      const road = !!lls;
      if (!lls) {
        lls = d.stops.slice(0, i + 1).reverse().map((x) => stopLL(x.code)).filter(Boolean);
        stopPts = lls.map((_, k) => k).slice(1);
      }
      if (lls.length < 2) return null;
      const pts = lls.map((ll) => toXY(ll.lat, ll.lng, ref));
      const cum = [0];
      for (let k = 1; k < pts.length; k++) cum.push(cum[k - 1] + Math.hypot(pts[k][0] - pts[k - 1][0], pts[k][1] - pts[k - 1][1]));
      // Distances (m before our stop) of the stops the bus pauses at on the way.
      const stopsS = stopPts.filter((k) => k > 0 && k < cum.length).map((k) => cum[k]).sort((a, b) => a - b);
      const path = { pts, cum, len: cum[cum.length - 1], road, stopsS, startName: d.stops[0]?.name || "the interchange" };
      pathCache.set(key, { p: Promise.resolve(path), road, at: Date.now() });
      return path;
    }).catch(() => {
      // A failed download (network blip) mustn't hide this bus for good:
      // forget it so the next refresh tries again.
      pathCache.delete(key);
      return null;
    });
    pathCache.set(key, { p, road: null, at: Date.now() });
    return p;
  }

  // Position and heading (bearing, radians clockwise from north, direction of
  // travel = towards the stop) at `s` metres before the stop.
  function pointAt(p, s) {
    if (s < 0) {
      // Past our stop (a departing bus): carry on in the direction it was
      // travelling when it reached the stop.
      const a = p.pts[0], b = p.pts[1], d = Math.hypot(a[0] - b[0], a[1] - b[1]) || 1;
      const ux = (a[0] - b[0]) / d, uy = (a[1] - b[1]) / d;
      return { x: a[0] - ux * s, y: a[1] - uy * s, heading: Math.atan2(ux, uy) };
    }
    s = Math.min(p.len, s);
    let k = 1;
    while (k < p.cum.length - 1 && p.cum[k] < s) k++;
    const a = p.pts[k - 1], b = p.pts[k], seg = p.cum[k] - p.cum[k - 1] || 1;
    const t = (s - p.cum[k - 1]) / seg;
    return { x: a[0] + (b[0] - a[0]) * t, y: a[1] + (b[1] - a[1]) * t, heading: Math.atan2(a[0] - b[0], a[1] - b[1]) };
  }
  // Nearest point on the path to (x, y): returns { s, dist }.
  function project(p, x, y) {
    let best = { s: 0, dist: Infinity };
    for (let k = 1; k < p.pts.length; k++) {
      const a = p.pts[k - 1], b = p.pts[k];
      const dx = b[0] - a[0], dy = b[1] - a[1], L2 = dx * dx + dy * dy || 1;
      const t = Math.max(0, Math.min(1, ((x - a[0]) * dx + (y - a[1]) * dy) / L2));
      const px = a[0] + dx * t, py = a[1] + dy * t, dist = Math.hypot(x - px, y - py);
      if (dist < best.dist) best = { s: p.cum[k - 1] + (p.cum[k] - p.cum[k - 1]) * t, dist };
    }
    return best;
  }

  // ── State ──
  // One fixed origin for the whole app (central Singapore), so buses heading
  // to different stops share one coordinate frame and cached paths stay valid.
  const LB = { mode: null, stop: null, ref: { lat: 1.3521, lng: 103.8198 }, buses: [], layer: null, three: null,
               timer: null, sel: null, gen: 0, nearStops: [], nearTimer: null };
  let _uid = 0;

  // ── Motion ──
  // Each bus follows a little timetable: drive, stop DWELL s at every bus stop
  // between it and ours, drive on, arriving at our stop when LTA says. Its
  // driving speed is what fits the ETA once those stops are taken out.
  // What's drawn (b.sDisp) only ever moves forward: when a refresh puts the
  // bus behind where it's drawn, it waits at the next stop if one is close,
  // otherwise slows to a crawl (as if in traffic) until the timetable catches
  // up; when it puts it ahead, the bus speeds up a little to close the gap.
  // Buses without GPS are only placed once; later refreshes just re-time them.
  const DWELL = 5;              // seconds at each bus stop
  const PASSED_S = 20;          // arrival this long ago = it has left (LTA lists buses ~1 min after)
  const LEAVE_MS = 4000;        // drive-off animation
  const START_M = 40;           // within this of the route's first stop = still at the interchange
  function plan(b) {
    const stops = (b.path.stopsS || []).filter((x) => x < b.s0 - 15).sort((x, y) => y - x);   // in the order it meets them
    // Still part-way through a stop when re-timed: finish that pause first.
    b.wait0 = b.dwellUntil > b.t0 ? (b.dwellUntil - b.t0) / 1000 : 0;
    // At the start of its route (still in the interchange / terminal, which
    // is where a bus that's many minutes away often is): it waits there and
    // leaves when a normal run gets it here on time, rather than crawling
    // out early to stretch the trip over the whole ETA.
    if (b.s0 >= b.path.len - START_M) {
      const run = b.s0 / EST_SPEED + DWELL * stops.length;
      b.wait0 = Math.max(b.wait0, b.eta - run);
    }
    const drive = Math.max(b.eta - b.wait0 - DWELL * stops.length, Math.min(b.eta * 0.5, b.eta - b.wait0), 10);
    b.v = Math.min(16, Math.max(1.5, b.s0 / drive));
    b.stopsAhead = stops;
  }
  // First guess for a bus with no GPS: how far out a bus driving at
  // EST_SPEED, stopping DWELL s at each stop, would be with `eta` s to go.
  function estimateS(p, eta) {
    let s = Math.min(p.len, Math.max(0, eta) * EST_SPEED);
    for (let k = 0; k < 3; k++) {
      const n = (p.stopsS || []).filter((x) => x < s).length;
      s = Math.min(p.len, Math.max(0, eta - DWELL * n) * EST_SPEED);
    }
    return s;
  }
  // Where the timetable has the bus `now` (metres before our stop).
  function sModel(b, now) {
    let t = (now - b.t0) / 1000 - (b.wait0 || 0), s = b.s0;
    if (t < 0) return s;
    for (const st of b.stopsAhead) {
      const dt = (s - st) / b.v;
      if (t <= dt) return s - b.v * t;
      t -= dt; s = st;
      if (t <= DWELL) return s;
      t -= DWELL;
    }
    return Math.max(0, s - b.v * t);
  }
  function step(b, now) {
    if (b.leaving) {
      // From wherever it is, on through the stop at ~9 m/s.
      b.leaveFrom ??= b.sDisp ?? 0;
      b.sDisp = Math.min(b.leaveFrom, 0) - 9 * (now - b.leaving) / 1000 + Math.max(b.leaveFrom, 0) * Math.max(0, 1 - (now - b.leaving) / 1500);
      return;
    }
    const target = sModel(b, now);
    const dt = Math.min(0.25, (now - (b.lastStep || now)) / 1000);
    b.lastStep = now;
    if (b.sDisp == null) { b.sDisp = target; return; }
    const before = b.sDisp;
    if (target < b.sDisp) {
      // Ahead of what's drawn: drive towards it, a bit faster than cruise.
      b.sDisp = Math.max(target, b.sDisp - Math.max(1.6 * b.v, 8) * dt);
    } else if (target > b.sDisp + 0.5) {
      // Behind what's drawn: never reverse. Roll up to a stop just ahead and
      // wait there; otherwise creep on at a quarter speed (like traffic) so
      // the gap closes gently instead of the bus freezing mid-road.
      const next = (b.path.stopsS || []).filter((x) => x < b.sDisp - 0.5).pop();
      if (next != null && b.sDisp - next < 40) b.sDisp = Math.max(next, b.sDisp - Math.max(0.6 * b.v, 3) * dt);
      else if (next == null || b.sDisp - next >= 40) b.sDisp = Math.max(next ?? 0, b.sDisp - 0.25 * b.v * dt);
    }
    // Just reached a stop: it's there for DWELL s (survives a re-time).
    if ((b.path.stopsS || []).some((x) => x <= before + 0.01 && x >= b.sDisp - 0.01 && x < before - 0.01 || (x === b.sDisp && before > x)))
      b.dwellUntil = now + DWELL * 1000;
  }

  // Buses due at `stop` (from its /api/arrivals response) as entries.
  function entriesFor(stop, data, now) {
    const out = [];
    for (const svc of data?.services || []) {
      (svc.buses || []).slice(0, PER_SVC).forEach((bus) => {
        const at = parseUTC(bus.ai_arrival || bus.api_arrival);
        const eta = at ? (at - now) / 1000 : null;
        if (eta == null || eta > MAX_ETA || eta < -90) return;
        out.push({ stop, svc: svc.service_no, bus, eta });
      });
    }
    return out;
  }

  // Stop mode: the buses coming to the open stop (+ the timeline strip).
  async function update(stop, data) {
    if (!stop || !data) return;
    if (LB.mode !== "stop" || stop !== LB.stop) clear(true);
    LB.mode = "stop"; LB.stop = stop;
    stopNearby();
    renderStrip(data);
    await ingest(entriesFor(stop, data, Date.now()), () => LB.mode === "stop" && LB.stop === stop);
    renderStrip(data);
  }

  // Nearby mode (no stop open): every bus heading to the stops nearest you,
  // refreshed every 30 s. A bus on its way to two of them is drawn once.
  const NEAR_N = 4, MAX_BUSES = 40;
  function nearby(codes) {
    if (S.stop) return;
    const list = (codes || []).filter(Boolean).slice(0, NEAR_N);
    if (!list.length) return;
    if (LB.mode !== "nearby") clear();
    LB.mode = "nearby"; LB.stop = null;
    LB.nearStops = list;
    clearInterval(LB.nearTimer);
    LB.nearTimer = setInterval(() => { if (!document.hidden && S.view === "arrivals" && !S.stop) refreshNearby(); }, 30000);
    refreshNearby();
  }
  async function refreshNearby() {
    if (LB.mode !== "nearby") return;
    const codes = LB.nearStops, now = Date.now();
    const res = await Promise.all(codes.map((c) => api(`/api/arrivals/${c}`).catch(() => null)));
    if (LB.mode !== "nearby" || S.stop) return;
    const entries = res.flatMap((d, i) => d ? entriesFor(codes[i], d, now) : []);
    await ingest(entries, () => LB.mode === "nearby" && !S.stop, { dedupe: true });
  }
  function stopNearby() { clearInterval(LB.nearTimer); LB.nearTimer = null; }

  // Place entries on their paths and match them to the buses already drawn.
  async function ingest(entries, stillWanted, { dedupe = false } = {}) {
    const gen = ++LB.gen, ref = LB.ref, now = Date.now();
    const paths = await Promise.all(entries.map((w) => pathFor(w.svc, w.stop, ref)));
    if (gen !== LB.gen || !stillWanted()) return;
    let cands = entries.map((w, n) => {
      const p = paths[n];
      if (!p) return null;
      let s0 = estimateS(p, w.eta), gps = false, passed = w.eta < -PASSED_S;
      if (w.bus.lat != null && w.bus.lng != null) {
        const [x, y] = toXY(w.bus.lat, w.bus.lng, ref);
        const pr = project(p, x, y);
        if (pr.dist < 350) { s0 = pr.s; gps = true; }
        // GPS beyond the end of the path (= past our stop): it's left.
        if (pr.s < 8 && pr.dist > 40 && pr.dist < 600) passed = true;
      }
      return { ...w, p, s0, gps, passed, pt: pointAt(p, s0) };
    }).filter(Boolean);
    // Buses LTA still lists although they've passed the stop: let the one
    // we're drawing drive off; never start drawing a new one.
    const passedC = cands.filter((c) => c.passed);
    cands = cands.filter((c) => !c.passed);
    if (dedupe) {
      // The same bus shows up in the lists of every nearby stop it'll pass:
      // same service and (nearly) the same place = one bus, kept for the
      // stop it reaches first.
      cands.sort((a, b) => a.eta - b.eta);
      const kept = [];
      for (const c of cands) {
        if (!kept.some((k) => k.svc === c.svc && Math.hypot(k.pt.x - c.pt.x, k.pt.y - c.pt.y) < (c.gps && k.gps ? 120 : 300))) kept.push(c);
      }
      cands = kept.slice(0, MAX_BUSES);
    }
    const keep = new Set();
    for (const w of cands) {
      const p = w.p;
      let s0 = w.s0;
      // Same physical bus as last refresh: same service heading to the same
      // stop with a similar ETA, or (its target stop changed) same service
      // drawn close to where this one is.
      let b = LB.buses.find((o) => !keep.has(o) && o.svc === w.svc && o.stop === w.stop && Math.abs(o.eta - w.eta) < 150)
           || LB.buses.find((o) => !keep.has(o) && o.svc === w.svc && o.pos && Math.hypot(o.pos.x - w.pt.x, o.pos.y - w.pt.y) < 250);
      if (!b) { b = { id: ++_uid, svc: w.svc, born: now }; LB.buses.push(b); }
      // Without GPS there's nothing new to learn about *where* a bus we're
      // already showing is — only when it'll arrive — so keep it where it's
      // drawn and re-time the rest of its trip (no correction, no jump).
      if (!w.gps && b.sDisp != null && b.path === p) s0 = b.sDisp;
      // A path change (other stop / road shape arrived) or a big correction
      // (LTA GPS was way off): jump instead of chasing it across the map.
      if (b.path !== p || (b.sDisp != null && Math.abs(b.sDisp - s0) > 800)) b.sDisp = null;
      Object.assign(b, {
        stop: w.stop, path: p, s0, t0: now, eta: w.eta, gps: w.gps,
        type: w.bus.type === "DD" ? "DD" : w.bus.type === "BD" ? "BD" : "SD",
      });
      plan(b);
      keep.add(b);
    }
    // Drawn buses that are gone from the feed (or listed as passed): if one
    // was at or near the stop, it drives off past it and fades instead of
    // vanishing — or being left stuck at the stop saying "Arr".
    for (const b of LB.buses) {
      if (keep.has(b)) continue;
      const wasPassed = passedC.some((c) => c.svc === b.svc && c.stop === b.stop);
      if (b.leaving || (!b.hidden && b.sDisp != null && b.sDisp < 60 && (wasPassed || b.eta - (now - b.t0) / 1000 < 30))) {
        b.leaving ||= now;
        keep.add(b);
      }
    }
    LB.buses.filter((b) => !keep.has(b)).forEach(dropBus);
    LB.buses = LB.buses.filter((b) => keep.has(b));
    await ensureDrawing();
  }

  function dropBus(b) { b.chip?.remove(); b.chip = null; if (b.obj) { LB.three?.scene.remove(b.obj); b.obj = null; } }

  function clear(keepStrip = false) {
    stopNearby();
    stopFollow();
    LB.buses.forEach(dropBus);
    LB.buses = []; LB.stop = null; LB.mode = null; LB.sel = null; LB.expanded = false;
    clearInterval(LB.timer); LB.timer = null;
    if (!keepStrip) { const el = $("live-strip"); if (el) { el.innerHTML = ""; el.classList.add("hidden"); } }
  }

  // ── Drawing ──
  async function ensureDrawing() {
    if (!_arrMap) { await _arrMapP; }
    if (!_arrMap || !LB.buses.length) return;
    if (_arrMap instanceof GLMap) {
      try { await ensureLayer(); } catch { /* three.js unavailable: chips only */ }
    }
    LB.buses.forEach((b) => {
      if (!b.chip) {
        b.chip = SGL.marker([LB.ref.lat, LB.ref.lng], { icon: chipIcon(b), zIndexOffset: 1 }).addTo(_arrMap);
        b.chip.on("click", () => focusBus(b.id, false));
      }
    });
    if (!LB.timer) LB.timer = setInterval(tick, 1000 / FPS);
    tick();
  }

  function chipIcon(b, eta = b.eta) {
    const when = eta === -999 ? "Left" : eta < 60 ? "Arr" : `${Math.round(eta / 60)} min`;
    const flat = !(_arrMap instanceof GLMap) || !LB.three;
    return SGL.divIcon({
      className: "lb-chip-wrap",
      html: `<div class="lb-chip${eta < 60 ? " arr" : ""}${LB.sel === b.id ? " sel" : ""}${flat ? " flat" : ""}">${flat ? '<span class="lb-ico">🚌</span>' : ""}<b>${esc(b.svc)}</b><span>${when}</span></div>`,
      iconSize: [0, 0], iconAnchor: [0, 0],
    });
  }

  function tick() {
    if (!_arrMap || !LB.buses.length || document.hidden || S.view !== "arrivals") return;
    if (LB.mode === "nearby" && S.stop) return;
    const now = Date.now();
    for (const b of LB.buses.filter((x) => x.leaving && now - x.leaving > LEAVE_MS)) dropBus(b);
    LB.buses = LB.buses.filter((x) => !(x.leaving && now - x.leaving > LEAVE_MS));
    LB.buses.forEach((b) => {
      // Overdue at the stop between refreshes: it's left.
      if (!b.leaving && !b.hidden && b.sDisp != null && b.sDisp < 60 && b.eta - (now - b.t0) / 1000 < -PASSED_S) b.leaving = now;
      step(b, now);
      // Not left the interchange yet: don't draw it (it'd only pile up with
      // the other waiting buses). It appears the moment it sets off.
      b.hidden = b.sDisp >= b.path.len - START_M && sModel(b, now) >= b.path.len - START_M;
      setChipVisible(b, !b.hidden);
    });
    queue(now);
    LB.buses.forEach((b) => {
      if (b.hidden) return;
      const pt = b.pos;
      const ll = fromXY(pt.x, pt.y, LB.ref);
      b.chip?.setLatLng([ll.lat, ll.lng]);
      // ETA counts down between refreshes
      const eta = b.eta - (now - b.t0) / 1000;
      const label = b.leaving ? "Left" : eta < 60 ? "Arr" : `${Math.round(eta / 60)} min`;
      if (b._label !== label) { b._label = label; b.chip?.setIcon(chipIcon(b, b.leaving ? -999 : eta)); }
      if (b.leaving) { const el = b.chip?._el; if (el) el.style.opacity = String(Math.max(0, 1 - (now - b.leaving) / LEAVE_MS)); }
    });
    followFrame(now);
    if (LB.layer && _arrMap._gl) _arrMap._gl.triggerRepaint();
  }

  // ── Keep buses from driving into each other ──
  // Buses are drawn larger than life, so two at (or queuing for) the same
  // stop would overlap. Place them closest-first; one that would overlap a
  // bus already placed is drawn just behind it, as if queuing for the bay
  // (or giving way where two routes cross). Only the drawing moves — not the
  // bus's timetable — and the offset eases in so nothing snaps.
  const LEN = { SD: 12, DD: 11.3, BD: 18.3 };
  const QUEUE_M = 250;          // only queue up near our stop
  const QUEUE_K = 2.4;          // spacing in bus lengths × this (= the up-close drawing scale)
  function queue(now) {
    // Spacing is a fixed distance on the ground (not tied to zoom), so zooming
    // never shuffles buses along the road.
    const k = QUEUE_K;
    const placed = [];
    LB.buses.filter((b) => b.leaving).forEach((b) => { b.pos = pointAt(b.path, b.sDisp); });
    [...LB.buses].filter((b) => !b.hidden && !b.leaving).sort((a, b) => a.sDisp - b.sDisp).forEach((b) => {
      let sq = b.sDisp, pt = pointAt(b.path, sq);
      for (let n = 0; n < 40 && b.sDisp < QUEUE_M; n++) {
        const hit = placed.find((q) => Math.hypot(pt.x - q.pt.x, pt.y - q.pt.y) < ((LEN[b.type] + LEN[q.type]) / 2 + 3) * k);
        if (!hit || sq >= b.path.len) break;
        sq = Math.min(b.path.len, sq + ((LEN[b.type] + LEN[hit.type]) / 6 + 1) * k);
        pt = pointAt(b.path, sq);
      }
      b.qOff = b.qOff == null ? sq - b.sDisp : b.qOff + (sq - b.sDisp - b.qOff) * 0.18;
      b.pos = pointAt(b.path, b.sDisp + b.qOff);
      placed.push({ pt: b.pos, type: b.type });
    });
  }

  // ── three.js layer + procedural Singapore buses ──
  const C = {
    green: 0x5aae2e, greenDark: 0x3f8a22, white: 0xeef1ee, roof: 0xd9dedb, glass: 0x1b2730,
    door: 0x22313a, black: 0x141516, tyre: 0x1d1d1f, head: 0xfff6cf, tail: 0xd2262c, bellows: 0x3a3d42,
    pillar: 0x3b444b, hub: 0x9aa1a6,
  };

  // One merged, vertex-coloured geometry per bus type. Units: metres, x =
  // forward, y = left, z = up; origin at the middle of the bus on the ground.
  function buildBus(THREE, type) {
    const parts = [];
    const box = (L, W, H, x, y, z, color) => parts.push({ g: new THREE.BoxGeometry(L, W, H), x, y, z, color });
    const wheel = (x, y) => {
      parts.push({ g: new THREE.CylinderGeometry(0.5, 0.5, 0.32, 14), x, y, z: 0.5, color: C.tyre });
      parts.push({ g: new THREE.CylinderGeometry(0.22, 0.22, 0.34, 10), x, y, z: 0.5, color: C.hub });   // hub
    };
    // Window pillars, so the glass reads as separate panes.
    const pillars = (L, x0, zMid, h, doors) => {
      const hx = L / 2;
      for (let x = -hx + 0.9; x < hx - 1.1; x += 1.45) {
        if (doors.some((dx) => Math.abs(x - dx) < 0.8)) continue;
        box(0.09, 2.5 + 0.06, h, x0 + x, 0, zMid, C.pillar);
      }
    };
    const section = (L, x0, { dd = false, front = true, rear = true, doors = [] } = {}) => {
      const W = 2.5, hx = L / 2;
      box(L, W, 0.45, x0, 0, 0.3 + 0.225, C.greenDark);                 // skirt
      box(L, W, dd ? 0.75 : 0.9, x0, 0, dd ? 1.125 : 1.2, C.green);      // lower body
      if (dd) {
        pillars(L, x0, 1.975, 0.95, doors);
        pillars(L, x0, 3.35, 1.0, []);
        box(L, W + 0.02, 0.95, x0, 0, 1.975, C.glass);                   // lower deck windows
        box(L, W, 0.4, x0, 0, 2.65, C.green);                            // between decks
        box(L, W + 0.02, 1.0, x0, 0, 3.35, C.glass);                     // upper deck windows
        box(L, W, 0.3, x0, 0, 4.0, C.white);                             // roof band
        box(L - 0.3, W - 0.2, 0.14, x0, 0, 4.22, C.roof);                // roof
      } else {
        pillars(L, x0, 2.175, 1.05, doors);
        box(L, W + 0.02, 1.05, x0, 0, 2.175, C.glass);                   // window band
        box(L, W, 0.32, x0, 0, 2.86, C.white);                           // roof band
        box(L - 0.3, W - 0.2, 0.14, x0, 0, 3.09, C.roof);                // roof
        if (front) box(3.2, 1.8, 0.28, x0 + hx - 4.2, 0, 3.3, C.roof);   // aircon pod
      }
      if (front) {
        const top = dd ? 2.45 : 2.66;
        box(0.06, W - 0.16, top - 1.15, x0 + hx + 0.02, 0, (top + 1.15) / 2, C.glass);   // windscreen
        box(0.06, 0.34, 0.16, x0 + hx + 0.02, W / 2 - 0.36, 0.78, C.head);                // headlights
        box(0.06, 0.34, 0.16, x0 + hx + 0.02, -W / 2 + 0.36, 0.78, C.head);
        box(0.12, 0.08, 0.3, x0 + hx - 0.2, W / 2 + 0.12, 2.3, C.black);                  // mirrors
        box(0.12, 0.08, 0.3, x0 + hx - 0.2, -W / 2 - 0.12, 2.3, C.black);
      }
      if (rear) {
        if (!dd) box(0.06, W - 0.5, 0.75, x0 - hx - 0.02, 0, 2.15, C.glass);             // rear window
        else box(0.06, W - 0.4, 0.8, x0 - hx - 0.02, 0, 3.35, C.glass);                  // upper-deck rear window
        box(0.06, 0.22, 0.42, x0 - hx - 0.02, W / 2 - 0.3, 1.0, C.tail);                 // tail lights
        box(0.06, 0.22, 0.42, x0 - hx - 0.02, -W / 2 + 0.3, 1.0, C.tail);
        box(0.06, W - 0.6, 0.5, x0 - hx - 0.02, 0, 0.62, C.black);                       // bumper
      }
      // Doors on the left (kerb) side — Singapore drives on the left.
      doors.forEach((dx) => box(1.15, 0.05, 2.25, x0 + dx, W / 2 + 0.03, 1.5, C.door));
    };
    let len;
    if (type === "BD") {
      // Articulated: 12 m front section + bellows + 6 m trailer.
      section(11.6, 3.1, { front: true, rear: false, doors: [5.0, 0.6] });
      box(0.9, 2.3, 2.5, -3.2, 0, 1.6, C.bellows);
      section(5.8, -6.55, { front: false, rear: true, doors: [0.4] });
      wheel(3.1 + 5.8 - 2.5, 1.12); wheel(3.1 + 5.8 - 2.5, -1.12);
      wheel(3.1 - 5.8 + 2.6, 1.12); wheel(3.1 - 5.8 + 2.6, -1.12);
      wheel(-6.55 - 1.4, 1.12); wheel(-6.55 - 1.4, -1.12);
      len = 18.3;
    } else {
      const L = type === "DD" ? 11.3 : 12.0;
      section(L, 0, { dd: type === "DD", doors: [L / 2 - 1.5, -0.4] });
      wheel(L / 2 - 2.5, 1.12); wheel(L / 2 - 2.5, -1.12);
      wheel(-L / 2 + 3.0, 1.12); wheel(-L / 2 + 3.0, -1.12);
      len = L;
    }
    // Merge into one non-indexed geometry with per-vertex colour.
    const pos = [], nrm = [], col = [], c = new THREE.Color();
    for (const p of parts) {
      // (Cylinders' axis is already y, i.e. across the bus, like an axle.)
      const g = p.g.index ? p.g.toNonIndexed() : p.g;
      g.translate(p.x, p.y, p.z);
      c.setHex(p.color);
      const a = g.attributes.position.array, n = g.attributes.normal.array;
      for (let k = 0; k < a.length; k++) { pos.push(a[k]); nrm.push(n[k]); }
      for (let k = 0; k < a.length / 3; k++) col.push(c.r, c.g, c.b);
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute("position", new THREE.Float32BufferAttribute(pos, 3));
    geo.setAttribute("normal", new THREE.Float32BufferAttribute(nrm, 3));
    geo.setAttribute("color", new THREE.Float32BufferAttribute(col, 3));
    return { geo, len, signZ: type === "DD" ? 2.6 : 2.81, front: type === "BD" ? 3.1 + 5.8 : (type === "DD" ? 11.3 : 12) / 2 };
  }

  // Amber LED destination sign showing the service number.
  const signTex = new Map();
  function signTexture(THREE, svc) {
    if (signTex.has(svc)) return signTex.get(svc);
    const cv = document.createElement("canvas"); cv.width = 256; cv.height = 64;
    const x = cv.getContext("2d");
    x.fillStyle = "#0b0c0d"; x.fillRect(0, 0, 256, 64);
    x.fillStyle = "#ffb11a"; x.font = "bold 48px system-ui, sans-serif"; x.textAlign = "center"; x.textBaseline = "middle";
    x.fillText(svc, 128, 35);
    const t = new THREE.CanvasTexture(cv);
    signTex.set(svc, t);
    return t;
  }

  async function ensureLayer() {
    const map = _arrMap._gl;
    const THREE = LB.three?.THREE || await loadThree();
    if (!LB.three) {
      const scene = new THREE.Scene();
      scene.add(new THREE.AmbientLight(0xffffff, 0.62));
      const sun = new THREE.DirectionalLight(0xffffff, 0.75); sun.position.set(-0.6, -0.8, 1.4); scene.add(sun);
      const mat = new THREE.MeshLambertMaterial({ vertexColors: true, side: THREE.DoubleSide });
      const models = { SD: buildBus(THREE, "SD"), DD: buildBus(THREE, "DD"), BD: buildBus(THREE, "BD") };
      LB.three = { THREE, scene, camera: new THREE.Camera(), mat, models, renderer: null };
    }
    if (!map.getLayer("sg-live-buses")) {
      LB.layer = makeLayer();
      map.addLayer(LB.layer);
      if (!LB._styleHook) {   // a theme swap replaces the style; put the layer back
        LB._styleHook = true;
        map.on("style.load", () => { if (LB.three && !map.getLayer("sg-live-buses")) map.addLayer(LB.layer = makeLayer()); });
      }
    }
  }

  // Soft shadow under each bus so it sits on the road.
  let _shadowTex = null;
  function shadowTexture(THREE) {
    if (_shadowTex) return _shadowTex;
    const cv = document.createElement("canvas"); cv.width = cv.height = 64;
    const x = cv.getContext("2d"), gr = x.createRadialGradient(32, 32, 4, 32, 32, 32);
    gr.addColorStop(0, "rgba(0,0,0,.42)"); gr.addColorStop(1, "rgba(0,0,0,0)");
    x.fillStyle = gr; x.fillRect(0, 0, 64, 64);
    return (_shadowTex = new THREE.CanvasTexture(cv));
  }

  function busObject(b) {
    const { THREE, scene, mat, models } = LB.three;
    const m = models[b.type];
    const g = new THREE.Group();
    const shadow = new THREE.Mesh(new THREE.PlaneGeometry(m.len + 2.2, 4.4),
      new THREE.MeshBasicMaterial({ map: shadowTexture(THREE), transparent: true, depthWrite: false }));
    shadow.position.set(b.type === "BD" ? -0.3 : 0, 0, 0.04);
    g.add(shadow);
    g.add(new THREE.Mesh(m.geo, mat));
    const sign = new THREE.Mesh(new THREE.PlaneGeometry(1.7, 0.3), new THREE.MeshBasicMaterial({ map: signTexture(THREE, b.svc) }));
    sign.geometry.rotateZ(Math.PI / 2); sign.geometry.rotateY(Math.PI / 2);
    sign.position.set(m.front + 0.06, 0, m.signZ);
    g.add(sign);
    g.userData.type = b.type;
    scene.add(g);
    return g;
  }

  function makeLayer() {
    return {
      id: "sg-live-buses", type: "custom", renderingMode: "3d",
      onAdd(map, gl) {
        const { THREE } = LB.three;
        if (!LB.three.renderer) {
          LB.three.renderer = new THREE.WebGLRenderer({ canvas: map.getCanvas(), context: gl, antialias: true });
          LB.three.renderer.autoClear = false;
        }
      },
      render(gl, args) {
        const T = LB.three; if (!T || !LB.ref) return;
        const { THREE } = T, map = _arrMap._gl;
        const mc = maplibregl.MercatorCoordinate.fromLngLat([LB.ref.lng, LB.ref.lat], 0);
        const u = mc.meterInMercatorCoordinateUnits();
        const matrix = args?.defaultProjectionData?.mainMatrix || args;
        T.camera.projectionMatrix = new THREE.Matrix4().fromArray(matrix)
          .multiply(new THREE.Matrix4().makeTranslation(mc.x, mc.y, mc.z))
          .multiply(new THREE.Matrix4().makeScale(u, -u, u));
        // Larger than life so a 12 m bus stays readable: ×2.4 at street level,
        // growing as you zoom out (about ×6 at the usual stop view, up to ×12).
        const k = Math.min(12, Math.max(2.4, Math.pow(2, 17.6 - map.getZoom())));
        for (const b of LB.buses) {
          if (!b.pos || b.hidden) { if (b.obj) b.obj.visible = false; continue; }
          if (!b.obj || b.obj.userData.type !== b.type) { if (b.obj) T.scene.remove(b.obj); b.obj = busObject(b); }
          b.obj.visible = true;
          b.obj.position.set(b.pos.x, b.pos.y, 0);
          b.obj.rotation.z = Math.PI / 2 - b.pos.heading;
          const fade = b.leaving ? Math.max(0.05, 1 - (Date.now() - b.leaving) / LEAVE_MS) : 1;
          b.obj.scale.setScalar((LB.sel === b.id ? k * 1.25 : k) * fade);
        }
        T.renderer.resetState();
        // Buses are drawn over the buildings (depth cleared first) so a bus
        // behind an HDB block is still findable; they still sort correctly
        // among themselves.
        T.renderer.clearDepth();
        T.renderer.render(T.scene, T.camera);
      },
    };
  }

  // ── Timeline strip in the stop sheet ──
  // Buses laid out by arrival time on a square-root scale (so the next few
  // minutes get the most room); rows stop plates from overlapping.
  const SPAN = 20 * 60;
  const xAt = (eta) => Math.sqrt(Math.max(0, Math.min(eta, SPAN)) / SPAN);
  function renderStrip(data) {
    const el = $("live-strip");
    if (!el) return;
    if (data) LB.lastData = data; else data = LB.lastData;
    const now = Date.now();
    const items = [];
    for (const svc of data?.services || []) {
      // One plate per service (its next bus): the list below has the rest.
      // Its next bus that hasn't gone past yet.
      const nextBus = (svc.buses || []).find((x) => { const t = parseUTC(x.api_arrival); return !t || (t - now) / 1000 >= -PASSED_S; });
      [nextBus].filter(Boolean).forEach((bus, n) => {
        const at = parseUTC(bus.ai_arrival || bus.api_arrival);
        const eta = at ? (at - now) / 1000 : null;
        if (eta == null || eta > SPAN || eta < -PASSED_S) return;   // gone past: not "coming up"
        const live = LB.buses.find((b) => b.svc === svc.service_no && Math.abs(b.eta - eta) < 150);
        items.push({ svc: svc.service_no, eta, id: live?.id, gps: live?.gps, type: bus.type });
      });
    }
    if (!items.length) { el.classList.add("hidden"); el.innerHTML = ""; return; }
    items.sort((a, b) => a.eta - b.eta);
    // One row, buses travelling right towards "Now" (at the right end): the
    // soonest sits nearest Now; later ones line up to its left. A plate that
    // would overlap its neighbour slides left; whatever doesn't fit becomes
    // "+N" at the far (left) end. Positions are re-applied every couple of
    // seconds, so plates glide right as their buses get closer.
    const trackPx = Math.max(200, (el.clientWidth || 330) - 40);
    const gap = 4 / trackPx, plusW = 34 / trackPx;
    let leftEdge = 2, shown = 0;
    const placed = [];
    for (const it of items) {
      const w = (18 + 9 * it.svc.length) / trackPx;
      const right = Math.min(1 - xAt(it.eta), leftEdge - gap);
      const room = shown < items.length - 1 ? plusW + gap : 0;
      if (right - w < room) break;
      leftEdge = right - w; shown++;
      placed.push({ it, x: right - w });
    }
    const more = items.length - shown;
    // Same plates as last time: just move them (CSS glides them).
    const track = el.querySelector(".lb-track");
    const keys = placed.map((q) => q.it.svc).join(",");
    if (track && track.dataset.keys === keys && !!el.querySelector(".lb-all") === !!LB.expanded && (track.dataset.more || "") === String(more)) {
      placed.forEach((q) => {
        const b = track.querySelector(`.lb-plate[data-lb-svc="${CSS.escape(q.it.svc)}"]`);
        if (!b) return;
        b.style.setProperty("--x", q.x);
        b.classList.toggle("arr", q.it.eta < 60);
        b.dataset.lbId = q.it.id ?? "";
      });
      return;
    }
    let html = placed.map(({ it, x }) => `<button type="button" class="lb-plate${it.eta < 60 ? " arr" : ""}${it.id && it.id === LB.sel ? " sel" : ""}" style="--x:${x}"
        data-lb-id="${it.id ?? ""}" data-lb-svc="${esc(it.svc)}" aria-label="Bus ${esc(it.svc)}, ${it.eta < 60 ? "arriving" : Math.round(it.eta / 60) + " min"}${it.gps ? ", live position" : ""}. Show on map">${esc(it.svc)}</button>`).join("");
    if (more > 0 || LB.expanded) {
      html += `<button type="button" class="lb-more${LB.expanded ? " on" : ""}" style="--x:0" data-lb-more
        aria-expanded="${!!LB.expanded}" aria-label="${LB.expanded ? "Show fewer buses" : `Show all ${items.length} buses`}">${LB.expanded ? "×" : `+${more}`}</button>`;
    }
    // Expanded: every bus due in the next 20 min, soonest first, as tappable
    // chips — so the ones squeezed into "+N" can be found on the map too.
    const all = LB.expanded ? `<div class="lb-all">${items.map((it) => `<button type="button" class="lb-chip2${it.eta < 60 ? " arr" : ""}${it.id && it.id === LB.sel ? " sel" : ""}"
        data-lb-id="${it.id ?? ""}" data-lb-svc="${esc(it.svc)}"><b>${esc(it.svc)}</b><span>${it.eta < 60 ? "Arr" : Math.round(it.eta / 60) + " min"}</span></button>`).join("")}</div>` : "";
    el.innerHTML = `
      <div class="lb-track" data-keys="${esc(keys)}" data-more="${more}"><span class="lb-now"></span>${html}</div>
      <div class="lb-ticks"><span style="--x:0">20 min</span><span style="--x:${1 - xAt(600)}">10</span><span style="--x:${1 - xAt(300)}">5</span><span style="--x:1">Now</span></div>${all}`;
    el.classList.remove("hidden");
  }

  function setChipVisible(b, vis) {
    const el = b.chip?._el || b.chip?.getElement?.();
    if (el) el.style.display = vis ? "" : "none";
  }

  function focusBus(id, fromStrip) {
    const b = LB.buses.find((x) => x.id === id);
    if (b?.hidden) { toast(`Bus ${b.svc} hasn't left ${b.path.startName} yet`); return; }
    if (!b || !b.pos || !_arrMap) return;
    LB.sel = id; LB.focusAt = Date.now();
    const now = Date.now();
    LB.buses.forEach((x) => { x.chip?.setIcon(chipIcon(x, x.eta - (now - x.t0) / 1000)); x.chip?.setZIndexOffset(x.id === id ? 1000 : 1); });
    document.querySelectorAll(".lb-plate").forEach((p) => p.classList.toggle("sel", +p.dataset.lbId === id));
    _snapSheet("min");
    setTimeout(() => startFollow(b), 300);
  }

  // ── Follow cam ──
  // Third-person view behind the selected bus: tilted, turned to face where
  // it's heading, a little ahead of it, kept up every frame as it drives.
  // Any drag / pinch / rotate by the user, the chip's ×, Back, or the bus
  // leaving ends it. (Flat Leaflet fallback: just keeps it centred.)
  const FOLLOW_ZOOM = 18, FOLLOW_PITCH = 62, AHEAD_M = 30;
  function startFollow(b) {
    if (!_arrMap || !b?.pos) return;
    LB.follow = b.id; LB.followBear = null;
    const gl = _arrMap instanceof GLMap ? _arrMap._gl : null;
    if (gl) {
      if (!LB._gestureHook) {
        LB._gestureHook = true;
        // Any touch, click-drag or wheel on the map takes the camera back.
        // (Listened for on the canvas itself: the per-frame camera updates
        // can swallow the map's own dragstart.)
        const cv = gl.getCanvasContainer();
        const stopIfUser = () => { if (LB.follow && Date.now() > (LB.followAnimUntil || 0) - 600) stopFollow(); };
        ["pointerdown", "touchstart", "wheel"].forEach((ev) => cv.addEventListener(ev, stopIfUser, { passive: true }));
      }
      const c = followCentre(b);
      LB.followAnimUntil = Date.now() + 900;
      LB.followBear = b.pos.heading * 180 / Math.PI;
      gl.easeTo({ center: [c.lng, c.lat], zoom: Math.max(gl.getZoom(), FOLLOW_ZOOM), pitch: FOLLOW_PITCH, bearing: LB.followBear,
                  padding: followPadding(), duration: 850 });
    }
    renderFollowChip(b);
  }
  function followPadding() {
    // Bus in the part of the map that's visible above the bottom sheet.
    const sheetH = parseFloat(getComputedStyle(document.documentElement).getPropertyValue("--sheet-h")) || 0;
    const side = document.querySelector("#view-arrivals .arr-sheet")?.getBoundingClientRect();
    const sideBySide = side && side.right <= (_arrMap.getContainer().getBoundingClientRect().left + 4);
    return { top: 80, bottom: sideBySide ? 0 : Math.min(innerHeight * 0.5, sheetH), left: 0, right: 0 };
  }
  function followCentre(b) {
    const h = b.pos.heading;
    return fromXY(b.pos.x + Math.sin(h) * AHEAD_M, b.pos.y + Math.cos(h) * AHEAD_M, LB.ref);
  }
  function followFrame(now) {
    if (!LB.follow) return;
    const b = LB.buses.find((x) => x.id === LB.follow);
    if (!b || b.hidden || !b.pos) { stopFollow(); return; }
    if (b.leaving && now - b.leaving > LEAVE_MS - 400) { stopFollow(); toast(`Bus ${b.svc} has left the stop`); return; }
    if (now < (LB.followAnimUntil || 0)) return;
    const c = followCentre(b);
    if (!(_arrMap instanceof GLMap)) {
      if (!LB._flatAt || now - LB._flatAt > 1000) { LB._flatAt = now; _arrMap.panTo([c.lat, c.lng], { duration: 0.8 }); }
      return;
    }
    // Turn smoothly (shortest way round) rather than snapping at corners.
    const want = b.pos.heading * 180 / Math.PI;
    let cur = LB.followBear ?? want;
    let d = ((want - cur + 540) % 360) - 180;
    cur += d * 0.08;
    LB.followBear = cur;
    _arrMap._gl.jumpTo({ center: [c.lng, c.lat], bearing: cur });
  }
  function stopFollow() {
    if (!LB.follow) return;
    LB.follow = null;
    $("follow-chip")?.classList.add("hidden");
    if (_arrMap instanceof GLMap) _arrMap._gl.setPadding({ top: 0, bottom: 0, left: 0, right: 0 });
  }
  function renderFollowChip(b) {
    const wrap = $("view-arrivals").querySelector(".arr-search-wrap");
    let chip = $("follow-chip");
    if (!chip) {
      chip = document.createElement("div");
      chip.id = "follow-chip"; chip.className = "route-chip follow-chip";
      wrap.appendChild(chip);
      chip.addEventListener("click", (e) => { if (e.target.closest("[data-follow-stop]")) stopFollow(); });
    }
    chip.innerHTML = `<span class="route-chip-badge">${esc(b.svc)}</span><span class="route-chip-txt">Following this bus</span>
      <button type="button" class="route-chip-x" data-follow-stop aria-label="Stop following">
        <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round"><path d="M18 6 6 18M6 6l12 12"/></svg></button>`;
    chip.classList.remove("hidden");
  }

  // Show where a given bus is — from the "Can I make it?" sheet. Picks the
  // live bus of `svc` whose arrival is closest to `iso` (the one selected there).
  function focusSvc(svc, iso) {
    const at = parseUTC(iso)?.getTime();
    const now = Date.now();
    const cands = LB.buses.filter((b) => b.svc === svc && b.pos && !b.leaving);
    if (!cands.length) return false;
    const etaOf = (b) => b.eta - (now - b.t0) / 1000;
    const b = at ? cands.sort((x, y) => Math.abs(now + etaOf(x) * 1000 - at) - Math.abs(now + etaOf(y) * 1000 - at))[0] : cands[0];
    focusBus(b.id, true);
    return true;
  }

  document.addEventListener("click", (e) => {
    if (e.target.closest("[data-lb-more]")) { LB.expanded = !LB.expanded; renderStrip(); return; }
    const p = e.target.closest(".lb-plate, .lb-chip2");
    if (!p) return;
    if (p.dataset.lbId) focusBus(+p.dataset.lbId, true);
    else toast(`Bus ${p.dataset.lbSvc} isn't on the map yet`);
  });

  setInterval(() => {
    if (LB.mode === "stop" && LB.lastData && !document.hidden && S.view === "arrivals" && !$("live-strip")?.classList.contains("hidden")) renderStrip();
  }, 2000);

  window.SGLoadThree = loadThree;   // shared with trees.js
  window.LiveBuses = { update, nearby, clear, focusBus, focusSvc, stopFollow, _state: LB, _buildBus: buildBus, _signTexture: signTexture, _motion: { plan, sModel, step, estimateS } };
})();
