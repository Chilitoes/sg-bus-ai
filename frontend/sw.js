/* SG Bus AI — service worker.
   Strategy: never touch API calls (live data must stay live); network-first
   for everything same-origin (HTML, JS, CSS) so deploys ALWAYS take effect the
   moment you're online. Versioned files (?v=) are cache-first since a new
   version always has a new URL; the page itself falls back to cache after
   3 s on a slow connection. (An old cache-first strategy for unversioned
   files served stale app.js after a version bump — don't do that.) */

const CACHE = "sgbus-shell-v1.2.35";

self.addEventListener("install", () => {
  self.skipWaiting();
});

self.addEventListener("activate", (e) => {
  e.waitUntil(
    caches.keys()
      .then((keys) =>
        Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k)))
      )
      .then(() => self.clients.claim())
  );
});

self.addEventListener("fetch", (e) => {
  const url = new URL(e.request.url);

  // Live data and anything cross-origin: straight to the network.
  if (e.request.method !== "GET") return;
  if (url.origin !== self.location.origin) return;
  if (url.pathname.includes("/api/")) return;

  // Versioned assets (app.js?v=1.2.x, styles.css?v=…) never change for a
  // given URL, so serve them straight from cache: a version bump changes the
  // URL in index.html, which still comes from the network. This saves a
  // network round-trip per file on every open.
  if (url.searchParams.has("v")) {
    e.respondWith(
      caches.match(e.request).then((hit) => hit || fetch(e.request).then((r) => {
        if (r.ok && r.type === "basic") { const copy = r.clone(); caches.open(CACHE).then((c) => c.put(e.request, copy)); }
        return r;
      }))
    );
    return;
  }

  // Everything else (the page itself, icons, images): network-first so
  // deploys take effect immediately. On a slow or flaky connection, a page
  // load falls back to the cached copy after 3 s instead of hanging; the
  // network fetch still finishes in the background and refreshes the cache.
  const network = fetch(e.request).then((r) => {
    // Only cache real, successful same-origin responses. Caching a 404/500
    // page or an opaque redirect would later be served as the offline
    // fallback, masking the real asset.
    if (r.ok && r.type === "basic") {
      const copy = r.clone();
      caches.open(CACHE).then((c) => c.put(e.request, copy));
    }
    return r;
  });
  // Offline fallback. Navigations must ignore the query string — deep links
  // like /bus/?stop=83139 are cached under the bare URL, so an exact match
  // would fail precisely when a shared link opens offline.
  const cached = () => e.request.mode === "navigate"
    ? caches.match(e.request, { ignoreSearch: true })
        .then((r) => r || caches.match("./index.html", { ignoreSearch: true }))
    : caches.match(e.request);

  if (e.request.mode === "navigate") {
    e.waitUntil(network.catch(() => {}));
    const slow = new Promise((res) => setTimeout(res, 3000)).then(cached);
    e.respondWith(
      Promise.race([network.catch(() => null), slow.then((r) => r || network)])
        .then((r) => r || cached())
        .then((r) => r || network)
    );
    return;
  }
  e.respondWith(network.catch(cached));
});
