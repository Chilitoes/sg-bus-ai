/* SG Bus — 3D trees on the live maps.

   OpenMapTiles has woods, parks and grass areas but no individual trees, so
   trees are scattered inside those polygons: a jittered grid, dense in woods
   and sparser in parks and grass, seeded by position so the same trees come
   back every time (they don't reshuffle as you pan). Drawn with three.js
   (loaded on demand, shared with live-buses.js) as instanced low-poly rain
   trees — a trunk and a round canopy — in a MapLibre custom layer under the
   buses, depth-tested so buildings hide them. Only from zoom 15, capped in
   number, and rebuilt when the map stops moving. Attaches to every MapLibre
   map in the app (app.js's _sgGLMaps). */

(() => {
  const MIN_ZOOM = 14.6;          // MapLibre zoom (Leaflet 15.6)
  const MAX_TREES = 2500;
  const ORIGIN = { lat: 1.3521, lng: 103.8198 };
  const R = 6371000, RAD = Math.PI / 180, COS = Math.cos(ORIGIN.lat * RAD);
  const toXY = (lng, lat) => [(lng - ORIGIN.lng) * RAD * R * COS, (lat - ORIGIN.lat) * RAD * R];
  // spacing (m) by landcover class/subclass
  const SPACING = (p) => p.class === "wood" ? 11 : ({ park: 20, garden: 18, recreation_ground: 26, golf_course: 34, grass: 30, meadow: 34 })[p.subclass] || 0;

  const hash = (x, y) => { let h = (x * 374761393 + y * 668265263) | 0; h = (h ^ (h >>> 13)) * 1274126177; return ((h ^ (h >>> 16)) >>> 0) / 4294967296; };

  function inRing(x, y, ring) {
    let inside = false;
    for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
      const [xi, yi] = ring[i], [xj, yj] = ring[j];
      if ((yi > y) !== (yj > y) && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
    }
    return inside;
  }

  function scatter(map) {
    if (map.getZoom() < MIN_ZOOM) return [];
    const feats = map.querySourceFeatures("openmaptiles", { sourceLayer: "landcover" });
    const b = map.getBounds();
    const [x0, y0] = toXY(b.getWest(), b.getSouth()), [x1, y1] = toXY(b.getEast(), b.getNorth());
    const out = [], seen = new Set();
    // Parks often include their ponds: no trees in water.
    const water = [];
    for (const w of map.querySourceFeatures("openmaptiles", { sourceLayer: "water" })) {
      const ps = w.geometry.type === "Polygon" ? [w.geometry.coordinates] : w.geometry.type === "MultiPolygon" ? w.geometry.coordinates : [];
      for (const poly of ps) {
        const ring = poly[0].map(([lng, lat]) => toXY(lng, lat));
        let a = Infinity, bb = Infinity, c = -Infinity, d = -Infinity;
        for (const [x, y] of ring) { a = Math.min(a, x); c = Math.max(c, x); bb = Math.min(bb, y); d = Math.max(d, y); }
        if (c < x0 - 50 || a > x1 + 50 || d < y0 - 50 || bb > y1 + 50) continue;
        water.push({ ring, a, bb, c, d });
      }
    }
    const wet = (x, y) => water.some((w) => x >= w.a && x <= w.c && y >= w.bb && y <= w.d && inRing(x, y, w.ring));
    for (const f of feats) {
      const sp = SPACING(f.properties);
      if (!sp) continue;
      const polys = f.geometry.type === "Polygon" ? [f.geometry.coordinates] : f.geometry.type === "MultiPolygon" ? f.geometry.coordinates : [];
      for (const poly of polys) {
        const rings = poly.map((r) => r.map(([lng, lat]) => toXY(lng, lat)));
        let bx0 = Infinity, by0 = Infinity, bx1 = -Infinity, by1 = -Infinity;
        for (const [x, y] of rings[0]) { bx0 = Math.min(bx0, x); bx1 = Math.max(bx1, x); by0 = Math.min(by0, y); by1 = Math.max(by1, y); }
        bx0 = Math.max(bx0, x0 - 50); bx1 = Math.min(bx1, x1 + 50); by0 = Math.max(by0, y0 - 50); by1 = Math.min(by1, y1 + 50);
        for (let gx = Math.floor(bx0 / sp); gx * sp <= bx1; gx++) {
          for (let gy = Math.floor(by0 / sp); gy * sp <= by1; gy++) {
            const key = `${sp}:${gx}:${gy}`;
            if (seen.has(key)) continue;   // polygons are split across tiles
            const r1 = hash(gx, gy), r2 = hash(gy * 7 + 3, gx * 13 + 1);
            if (sp > 15 && r1 < 0.25) continue;            // gaps in parks
            const x = (gx + 0.15 + 0.7 * r1) * sp, y = (gy + 0.15 + 0.7 * r2) * sp;
            if (!inRing(x, y, rings[0]) || rings.slice(1).some((h) => inRing(x, y, h)) || wet(x, y)) continue;
            seen.add(key);
            out.push({ x, y, s: 0.75 + 0.55 * hash(gx + 11, gy - 5), r: r1 * Math.PI * 2, c: r2 });
            if (out.length >= MAX_TREES) return out;
          }
        }
      }
    }
    return out;
  }

  function treeGeometry(THREE) {
    // Singapore rain tree, low-poly: slim trunk, wide flattened canopy.
    const parts = [];
    const trunk = new THREE.CylinderGeometry(0.35, 0.5, 4, 6); trunk.rotateX(Math.PI / 2); trunk.translate(0, 0, 2);
    const crown = new THREE.IcosahedronGeometry(3.6, 0); crown.scale(1.25, 1.25, 0.8); crown.translate(0, 0, 6.2);
    const top = new THREE.IcosahedronGeometry(2.4, 0); top.scale(1.1, 1.1, 0.85); top.translate(0.8, -0.5, 8);
    parts.push([trunk, 0x6b4a2e], [crown, 0xffffff], [top, 0xffffff]);
    const pos = [], nrm = [], col = [], c = new THREE.Color();
    for (const [g0, hex] of parts) {
      const g = g0.index ? g0.toNonIndexed() : g0;
      g.computeVertexNormals();
      c.setHex(hex);
      const a = g.attributes.position.array, n = g.attributes.normal.array;
      for (let k = 0; k < a.length; k++) { pos.push(a[k]); nrm.push(n[k]); }
      for (let k = 0; k < a.length / 3; k++) col.push(c.r, c.g, c.b);
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute("position", new THREE.Float32BufferAttribute(pos, 3));
    geo.setAttribute("normal", new THREE.Float32BufferAttribute(nrm, 3));
    geo.setAttribute("color", new THREE.Float32BufferAttribute(col, 3));
    return geo;
  }

  function attach(glm) {
    const map = glm._gl;
    const T = { THREE: null, scene: null, camera: null, renderer: null, mesh: null, geo: null, mat: null, dark: null };
    let pending = null;

    async function rebuild() {
      if (map.getZoom() < MIN_ZOOM) { if (T.mesh) T.mesh.visible = false; map.triggerRepaint(); return; }
      if (!T.THREE) {
        try { T.THREE = await window.SGLoadThree(); } catch { return; }
        const THREE = T.THREE;
        T.scene = new THREE.Scene();
        T.scene.add(new THREE.AmbientLight(0xffffff, 0.6));
        const sun = new THREE.DirectionalLight(0xffffff, 0.75); sun.position.set(-0.6, -0.8, 1.4); T.scene.add(sun);
        T.camera = new THREE.Camera();
        T.geo = treeGeometry(THREE);
        T.mat = new THREE.MeshLambertMaterial({ vertexColors: true, transparent: true, opacity: 0.92 });
        addLayer();
      }
      const THREE = T.THREE, trees = scatter(map);
      const dark = glm._dark;
      if (T.mesh) { T.scene.remove(T.mesh); T.mesh.dispose?.(); }
      T.mesh = new THREE.InstancedMesh(T.geo, T.mat, Math.max(1, trees.length));
      T.mesh.count = trees.length;
      const m = new THREE.Matrix4(), q = new THREE.Quaternion(), z = new THREE.Vector3(0, 0, 1), col = new THREE.Color();
      trees.forEach((t, i) => {
        q.setFromAxisAngle(z, t.r);
        m.compose(new THREE.Vector3(t.x, t.y, 0), q, new THREE.Vector3(t.s, t.s, t.s));
        T.mesh.setMatrixAt(i, m);
        // canopy greens vary a little; the brown trunk is tinted the same way (barely visible)
        col.setHSL(0.27 + 0.06 * t.c, dark ? 0.32 : 0.45, (dark ? 0.24 : 0.36) + 0.08 * t.c);
        T.mesh.setColorAt(i, col);
      });
      T.mesh.instanceMatrix.needsUpdate = true;
      if (T.mesh.instanceColor) T.mesh.instanceColor.needsUpdate = true;
      T.scene.add(T.mesh);
      map.triggerRepaint();
    }

    function addLayer() {
      if (!T.THREE || map.getLayer("sg-trees")) return;
      const layer = {
        id: "sg-trees", type: "custom", renderingMode: "3d",
        onAdd(_, gl) {
          if (!T.renderer) { T.renderer = new T.THREE.WebGLRenderer({ canvas: map.getCanvas(), context: gl, antialias: true }); T.renderer.autoClear = false; }
        },
        render(gl, args) {
          if (!T.mesh || !T.mesh.visible || !T.mesh.count) return;
          const THREE = T.THREE;
          const mc = maplibregl.MercatorCoordinate.fromLngLat([ORIGIN.lng, ORIGIN.lat], 0);
          const u = mc.meterInMercatorCoordinateUnits();
          const matrix = args?.defaultProjectionData?.mainMatrix || args;
          T.camera.projectionMatrix = new THREE.Matrix4().fromArray(matrix)
            .multiply(new THREE.Matrix4().makeTranslation(mc.x, mc.y, mc.z))
            .multiply(new THREE.Matrix4().makeScale(u, -u, u));
          T.renderer.resetState();
          T.renderer.render(T.scene, T.camera);
        },
      };
      // Under the buses (added later), over the ground and buildings' bases.
      map.addLayer(layer, map.getLayer("sg-live-buses") ? "sg-live-buses" : undefined);
    }

    const schedule = () => { clearTimeout(pending); pending = setTimeout(rebuild, 350); };
    map.on("moveend", schedule);
    map.on("sourcedata", (e) => { if (e.sourceId === "openmaptiles" && e.isSourceLoaded) schedule(); });
    map.on("style.load", () => { addLayer(); schedule(); });   // theme swap replaces the style
    if (map.isStyleLoaded()) schedule(); else map.once("idle", schedule);
  }

  const done = new WeakSet();
  setInterval(() => {
    if (typeof _sgGLMaps === "undefined") return;
    _sgGLMaps.forEach((m) => { if (!done.has(m)) { done.add(m); attach(m); } });
  }, 1000);
})();
