/* SG Bus AI — service worker.
   Strategy: never touch API calls (live data must stay live); network-first
   for everything same-origin (HTML, JS, CSS) so deploys ALWAYS take effect the
   moment you're online. The cache is only an offline fallback. (A previous
   cache-first strategy could serve stale app.js even after a version bump.) */

const CACHE = "sgbus-shell-v1.2.11";

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

  // Network-first for the app shell and static assets. Fresh code every load
  // when online; fall back to the last cached copy only when the network fails.
  e.respondWith(
    fetch(e.request)
      .then((r) => {
        // Only cache real, successful same-origin responses. Caching a 404/500
        // page or an opaque redirect would later be served as the offline
        // fallback, masking the real asset.
        if (r.ok && r.type === "basic") {
          const copy = r.clone();
          caches.open(CACHE).then((c) => c.put(e.request, copy));
        }
        return r;
      })
      .catch(() => {
        // Offline fallback. Navigations must ignore the query string — deep
        // links like /bus/?stop=83139 are cached under the bare URL, so an
        // exact match would fail precisely when a shared link opens offline.
        if (e.request.mode === "navigate") {
          return caches.match(e.request, { ignoreSearch: true })
            .then((r) => r || caches.match("./index.html", { ignoreSearch: true }));
        }
        return caches.match(e.request);
      })
  );
});
