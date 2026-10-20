/* Binder Scan service worker: keeps the app working offline and caches official card images.
   Bump VERSION whenever you upload changed app files, so phones pick up the new version. */
const VERSION = "bs-2.0.0";
const SHELL = ["./", "index.html", "styles.css", "app.js", "conditions.js", "manifest.webmanifest", "icon-192.png", "icon-512.png"];
const IMG_CACHE = "bs-card-images";

self.addEventListener("install", (e) => {
  e.waitUntil(caches.open(VERSION).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting()));
});
self.addEventListener("activate", (e) => {
  e.waitUntil(caches.keys().then((keys) => Promise.all(keys.filter((k) => k !== VERSION && k !== IMG_CACHE).map((k) => caches.delete(k)))).then(() => self.clients.claim()));
});
self.addEventListener("fetch", (e) => {
  const url = new URL(e.request.url);
  if (e.request.method !== "GET") return;
  // Card art: cache first, it never changes.
  if (url.hostname === "images.pokemontcg.io") {
    e.respondWith(caches.open(IMG_CACHE).then(async (c) => {
      const hit = await c.match(e.request);
      if (hit) return hit;
      const res = await fetch(e.request);
      if (res.ok || res.type === "opaque") c.put(e.request, res.clone());
      return res;
    }));
    return;
  }
  // App files: network first so updates arrive, cache when offline.
  if (url.origin === self.location.origin) {
    e.respondWith(fetch(e.request).then((res) => {
      if (res.ok) caches.open(VERSION).then((c) => c.put(e.request, res.clone()));
      return res;
    }).catch(() => caches.match(e.request).then((r) => r || caches.match("index.html"))));
  }
  // Everything else (card data API, eBay helper, fonts, OCR) goes straight to the network.
});
