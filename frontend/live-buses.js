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
  const TWEEN_MS = 2500;
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
      let lls = null;
      const sh = shape?.directions?.find((x) => x.direction === d.direction);
      if (sh && sh.stop_index.length === d.stops.length && sh.stop_index[i] > 0) {
        lls = sh.coords.slice(0, sh.stop_index[i] + 1).reverse().map(([lat, lng]) => ({ lat, lng }));
      }
      const road = !!lls;
      if (!lls) lls = d.stops.slice(0, i + 1).reverse().map((x) => stopLL(x.code)).filter(Boolean);
      if (lls.length < 2) return null;
      const pts = lls.map((ll) => toXY(ll.lat, ll.lng, ref));
      const cum = [0];
      for (let k = 1; k < pts.length; k++) cum.push(cum[k - 1] + Math.hypot(pts[k][0] - pts[k - 1][0], pts[k][1] - pts[k - 1][1]));
      pathCache.set(key, { p: Promise.resolve({ pts, cum, len: cum[cum.length - 1], road }), road, at: Date.now() });
      return { pts, cum, len: cum[cum.length - 1], road };
    }).catch(() => null);
    pathCache.set(key, { p, road: null, at: Date.now() });
    return p;
  }

  // Position and heading (bearing, radians clockwise from north, direction of
  // travel = towards the stop) at `s` metres before the stop.
  function pointAt(p, s) {
    s = Math.max(0, Math.min(p.len, s));
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
  const LB = { stop: null, ref: null, buses: [], layer: null, three: null, timer: null, sel: null, gen: 0 };
  let _uid = 0;

  function sNow(b, now) {
    const dr = Math.max(0, b.s0 - b.v * (now - b.t0) / 1000);
    if (b.tw0 == null) return dr;
    const f = Math.min(1, (now - b.tw0) / TWEEN_MS);
    if (f >= 1) { b.tw0 = null; return dr; }
    const e = f * f * (3 - 2 * f);
    return b.twFrom + (dr - b.twFrom) * e;
  }

  async function update(stop, data) {
    if (!stop || !data) return;
    const gen = ++LB.gen;
    if (stop !== LB.stop) clear(true);
    LB.stop = stop;
    LB.ref = (data.latitude != null && data.longitude != null) ? { lat: data.latitude, lng: data.longitude } : stopLL(stop);
    renderStrip(data);
    if (!LB.ref) return;
    const ref = LB.ref, now = Date.now();
    const wanted = [];
    for (const svc of data.services || []) {
      (svc.buses || []).slice(0, PER_SVC).forEach((bus) => {
        const at = parseUTC(bus.ai_arrival || bus.api_arrival);
        const eta = at ? (at - now) / 1000 : null;
        if (eta == null || eta > MAX_ETA || eta < -60) return;
        wanted.push({ svc: svc.service_no, bus, eta });
      });
    }
    const paths = await Promise.all(wanted.map((w) => pathFor(w.svc, stop, ref)));
    if (gen !== LB.gen || LB.stop !== stop) return;
    const keep = new Set();
    wanted.forEach((w, n) => {
      const p = paths[n];
      if (!p) return;
      let s0 = Math.min(p.len, Math.max(0, w.eta) * EST_SPEED), gps = false;
      if (w.bus.lat != null && w.bus.lng != null) {
        const [x, y] = toXY(w.bus.lat, w.bus.lng, ref);
        const pr = project(p, x, y);
        if (pr.dist < 350) { s0 = pr.s; gps = true; }
      }
      // Same physical bus as last refresh: same service, ETA within 2.5 min.
      let b = LB.buses.find((o) => o.svc === w.svc && !keep.has(o) && Math.abs(o.eta - w.eta) < 150);
      if (b) { b.twFrom = sNow(b, now); b.tw0 = now; }
      else { b = { id: ++_uid, svc: w.svc, born: now }; LB.buses.push(b); }
      Object.assign(b, {
        path: p, s0, t0: now, eta: w.eta, gps,
        v: Math.min(15, Math.max(1.5, s0 / Math.max(w.eta, 20))),
        type: w.bus.type === "DD" ? "DD" : w.bus.type === "BD" ? "BD" : "SD",
      });
      keep.add(b);
    });
    LB.buses.filter((b) => !keep.has(b)).forEach(dropBus);
    LB.buses = LB.buses.filter((b) => keep.has(b));
    await ensureDrawing();
    renderStrip(data);
  }

  function dropBus(b) { b.chip?.remove(); b.chip = null; if (b.obj) { LB.three?.scene.remove(b.obj); b.obj = null; } }

  function clear(keepStrip = false) {
    LB.buses.forEach(dropBus);
    LB.buses = []; LB.stop = null; LB.sel = null;
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
    const when = eta < 60 ? "Arr" : `${Math.round(eta / 60)} min`;
    const flat = !(_arrMap instanceof GLMap) || !LB.three;
    return SGL.divIcon({
      className: "lb-chip-wrap",
      html: `<div class="lb-chip${eta < 60 ? " arr" : ""}${LB.sel === b.id ? " sel" : ""}${flat ? " flat" : ""}">${flat ? '<span class="lb-ico">🚌</span>' : ""}<b>${esc(b.svc)}</b><span>${when}</span></div>`,
      iconSize: [0, 0], iconAnchor: [0, 0],
    });
  }

  function tick() {
    if (!_arrMap || !LB.buses.length || document.hidden || S.view !== "arrivals") return;
    const now = Date.now();
    LB.buses.forEach((b) => {
      const pt = pointAt(b.path, sNow(b, now));
      b.pos = pt;
      const ll = fromXY(pt.x, pt.y, LB.ref);
      b.chip?.setLatLng([ll.lat, ll.lng]);
      // ETA counts down between refreshes
      const eta = b.eta - (now - b.t0) / 1000;
      const label = eta < 60 ? "Arr" : `${Math.round(eta / 60)} min`;
      if (b._label !== label) { b._label = label; b.chip?.setIcon(chipIcon(b, eta)); }
    });
    if (LB.layer && _arrMap._gl) _arrMap._gl.triggerRepaint();
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
          if (!b.pos) continue;
          if (!b.obj || b.obj.userData.type !== b.type) { if (b.obj) T.scene.remove(b.obj); b.obj = busObject(b); }
          b.obj.position.set(b.pos.x, b.pos.y, 0);
          b.obj.rotation.z = Math.PI / 2 - b.pos.heading;
          b.obj.scale.setScalar(LB.sel === b.id ? k * 1.25 : k);
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
    const now = Date.now();
    const items = [];
    for (const svc of data?.services || []) {
      (svc.buses || []).slice(0, PER_SVC).forEach((bus, n) => {
        const at = parseUTC(bus.ai_arrival || bus.api_arrival);
        const eta = at ? (at - now) / 1000 : null;
        if (eta == null || eta > SPAN || eta < -60) return;
        const live = LB.buses.find((b) => b.svc === svc.service_no && Math.abs(b.eta - eta) < 150);
        items.push({ svc: svc.service_no, eta, id: live?.id, gps: live?.gps, type: bus.type });
      });
    }
    if (!items.length) { el.classList.add("hidden"); el.innerHTML = ""; return; }
    items.sort((a, b) => a.eta - b.eta);
    // Plate widths in track fractions, from the label length (≈ what CSS draws).
    const trackPx = Math.max(200, (el.clientWidth || 330) - 70);
    const rowsEnd = [];   // fraction where each row's last plate ends
    const plates = items.map((it) => {
      const x = xAt(it.eta), w = (20 + 9.5 * it.svc.length + (it.type === "DD" ? 16 : 0) + 6) / trackPx;
      let row = rowsEnd.findIndex((end) => end <= x - w * 0.12);
      if (row < 0) { row = rowsEnd.length; rowsEnd.push(0); }
      if (row > 2) return "";
      rowsEnd[row] = x + w * 0.88;
      return `<button type="button" class="lb-plate${it.eta < 60 ? " arr" : ""}${it.id && it.id === LB.sel ? " sel" : ""}" style="--x:${x};--row:${row}"
        data-lb-id="${it.id ?? ""}" data-lb-svc="${esc(it.svc)}" title="${esc(it.svc)}: ${it.eta < 60 ? "arriving" : Math.round(it.eta / 60) + " min"}${it.gps ? " (live position)" : ""}">${esc(it.svc)}${it.type === "DD" ? '<i aria-hidden="true">DD</i>' : ""}</button>`;
    }).join("");
    const rows = Math.min(3, rowsEnd.length);
    el.innerHTML = `
      <div class="lb-head"><span>Coming up</span><span class="lb-hint">Tap a bus to see it on the map</span></div>
      <div class="lb-track" style="--rows:${rows}"><span class="lb-now"></span>${plates}</div>
      <div class="lb-ticks"><span style="--x:0">Now</span><span style="--x:${xAt(300)}">5</span><span style="--x:${xAt(600)}">10</span><span style="--x:1">20 min</span></div>`;
    el.classList.remove("hidden");
  }

  function focusBus(id, fromStrip) {
    const b = LB.buses.find((x) => x.id === id);
    if (!b || !b.pos || !_arrMap) return;
    LB.sel = id;
    const now = Date.now();
    LB.buses.forEach((x) => x.chip?.setIcon(chipIcon(x, x.eta - (now - x.t0) / 1000)));
    const ll = fromXY(b.pos.x, b.pos.y, LB.ref);
    if (fromStrip) _snapSheet("min");
    setTimeout(() => {
      if (_arrMap.getZoom() < 16.8) _arrMap.setView([ll.lat, ll.lng], 17.2);
      _mapFocus(_arrMap, "view-arrivals", SGL.latLng(ll.lat, ll.lng));
    }, fromStrip ? 300 : 0);
    document.querySelectorAll(".lb-plate").forEach((p) => p.classList.toggle("sel", +p.dataset.lbId === id));
  }

  document.addEventListener("click", (e) => {
    const p = e.target.closest(".lb-plate");
    if (!p) return;
    if (p.dataset.lbId) focusBus(+p.dataset.lbId, true);
    else toast(`Bus ${p.dataset.lbSvc} isn't on the map yet`);
  });

  window.LiveBuses = { update, clear, focusBus, _state: LB, _buildBus: buildBus, _signTexture: signTexture };
})();
