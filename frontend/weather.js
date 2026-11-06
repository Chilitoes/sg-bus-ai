/* SG Bus — rain on the map when it's actually raining.

   Every 5 min (while a map is on screen) the app reads NEA's live rain
   gauges (data.gov.sg rainfall, mm in the last 5 min per station) and takes
   the nearest station to the centre of the map you're looking at, within
   8 km. If it's recording rain, a rain overlay falls over the map — more
   and faster streaks the harder it rains — with a small "Raining here"
   badge. ?rain=1 / ?rain=heavy previews it. Reduced-motion: badge only. */

(() => {
  // v2 has every gauge (~90); the older v1 feed sometimes returns only a
  // handful, so it's just the fallback.
  const URL_V2 = "https://api-open.data.gov.sg/v2/real-time/api/rainfall";
  const URL_V1 = "https://api.data.gov.sg/v1/environment/rainfall";
  const MAX_KM = 8;
  const W = { mm: 0, at: 0, station: null, timer: null, raf: 0, drops: [], canvas: null, badge: null };
  const force = new URLSearchParams(location.search).get("rain");
  const reduced = matchMedia("(prefers-reduced-motion: reduce)").matches;

  function mapForView() {
    const v = typeof S !== "undefined" ? S.view : null;
    return v === "arrivals" ? _arrMap : v === "mrt" ? _mrtMap : v === "carpark" ? _cpMap : null;
  }
  const km = (a, b) => {
    const r = Math.PI / 180, dp = (b.lat - a.lat) * r, dl = (b.lng - a.lng) * r;
    const h = Math.sin(dp / 2) ** 2 + Math.cos(a.lat * r) * Math.cos(b.lat * r) * Math.sin(dl / 2) ** 2;
    return 6371 * 2 * Math.asin(Math.min(1, Math.sqrt(h)));
  };

  let data = null, dataAt = 0;
  async function check() {
    const m = mapForView();
    if (!m || document.hidden) return;
    if (force) { set(force === "heavy" ? 2.4 : 0.6, "preview"); return; }
    try {
      if (!data || Date.now() - dataAt > 4.5 * 60e3) {
        data = await loadGauges();
        if (!data) return;
        dataAt = Date.now();
      }
      const c = m.getCenter();
      const st = data.map((g) => ({ ...g, d: km(c, g) })).sort((a, b) => a.d - b.d)[0];
      set(st && st.d <= MAX_KM ? st.mm : 0, st?.name);
    } catch { /* keep the last state */ }
  }

  // → [{ name, lat, lng, mm }] from whichever feed answers with more gauges.
  async function loadGauges() {
    const get = (u) => fetch(u, { cache: "no-store" }).then((r) => (r.ok ? r.json() : null)).catch(() => null);
    const v2 = await get(URL_V2);
    if (v2?.data?.stations?.length > 10) {
      const by = new Map((v2.data.readings?.[0]?.data || []).map((x) => [x.stationId, Number(x.value) || 0]));
      return v2.data.stations.map((s) => ({ name: s.name, lat: s.location.latitude, lng: s.location.longitude, mm: by.get(s.id) ?? 0 }));
    }
    const v1 = await get(URL_V1);
    if (!v1) return null;
    const by = new Map((v1.items?.[0]?.readings || []).map((x) => [x.station_id, Number(x.value) || 0]));
    return (v1.metadata?.stations || []).map((s) => ({ name: s.name, lat: s.location.latitude, lng: s.location.longitude, mm: by.get(s.id) ?? 0 }));
  }

  function set(mm, station) {
    W.mm = mm; W.station = station;
    const on = mm > 0;
    ensureEls();
    W.badge.classList.toggle("hidden", !on);
    if (on) W.badge.textContent = `🌧 ${mm >= 2 ? "Heavy rain" : mm >= 0.5 ? "Raining" : "Light rain"} here`;
    if (on && !reduced) start(); else stop();
  }

  function ensureEls() {
    if (W.canvas) return;
    W.canvas = document.createElement("canvas");
    W.canvas.className = "rain-layer";
    W.canvas.setAttribute("aria-hidden", "true");
    document.body.appendChild(W.canvas);
    W.badge = document.createElement("div");
    W.badge.className = "rain-badge hidden";
    document.body.appendChild(W.badge);
  }

  function start() {
    const cv = W.canvas, dpr = Math.min(2, devicePixelRatio || 1);
    const size = () => { cv.width = innerWidth * dpr; cv.height = innerHeight * dpr; };
    size(); addEventListener("resize", size);
    const n = Math.round(Math.min(1, 0.25 + W.mm / 2.5) * 260);
    while (W.drops.length < n) W.drops.push(newDrop(true));
    W.drops.length = n;
    cv.classList.add("on");
    if (W.raf) return;
    let last = performance.now();
    const frame = (t) => {
      W.raf = requestAnimationFrame(frame);
      const dt = Math.min(0.05, (t - last) / 1000); last = t;
      if (document.hidden || !mapForView()) { cv.classList.remove("on"); return; }
      cv.classList.add("on");
      const x = cv.getContext("2d");
      x.clearRect(0, 0, cv.width, cv.height);
      const dark = document.documentElement.dataset.theme === "dark" || (!document.documentElement.dataset.theme && matchMedia("(prefers-color-scheme: dark)").matches);
      x.strokeStyle = dark ? "rgba(190,210,235,.42)" : "rgba(90,115,145,.38)";
      x.lineWidth = 1.1 * dpr; x.lineCap = "round";
      x.beginPath();
      for (const d of W.drops) {
        d.y += d.v * dt; d.x += d.v * 0.18 * dt;
        if (d.y > 1.05) Object.assign(d, newDrop(false));
        const X = d.x * cv.width, Y = d.y * cv.height, L = d.len * dpr;
        x.moveTo(X, Y); x.lineTo(X - L * 0.18, Y - L);
      }
      x.stroke();
    };
    W.raf = requestAnimationFrame(frame);
  }
  function newDrop(anywhere) {
    const heavy = Math.min(1, W.mm / 2.5);
    return { x: Math.random() * 1.1 - 0.1, y: anywhere ? Math.random() : -0.05 - Math.random() * 0.1,
             v: 0.9 + Math.random() * 0.5 + heavy * 0.6, len: 10 + Math.random() * 10 + heavy * 8 };
  }
  function stop() {
    if (W.raf) cancelAnimationFrame(W.raf);
    W.raf = 0;
    W.canvas?.classList.remove("on");
  }

  // Check now, every 5 min, and when you move the map a long way / switch tab.
  let lastC = null;
  setInterval(() => {
    const m = mapForView(); if (!m) { stop(); W.badge?.classList.add("hidden"); return; }
    const c = m.getCenter();
    if (!lastC || km(c, lastC) > 3 || Date.now() - (W.at || 0) > 5 * 60e3) { lastC = c; W.at = Date.now(); check(); }
    else if (W.mm > 0) { W.badge?.classList.remove("hidden"); if (!reduced && !W.raf) start(); }
  }, 4000);
  window.SGWeather = { check, set, _state: W };
})();
