/* GTSofia PWA cache. Realtime API responses are deliberately never cached. */
const SHELL_CACHE = "gtsofia-shell-v1";
const DATA_CACHE = "gtsofia-data-v1";

const SHELL_PATHS = [
  "",
  "index.html",
  "schedules.html",
  "virtual-boards.html",
  "about.html",
  "rolling-stock.html",
  "style.css",
  "navbar.js",
  "transport-data.js",
  "virtual-board-utils.js",
  "schedules.js",
  "virtual-boards.js",
  "rolling-stock.js",
  "manifest.webmanifest",
  "Icons/gts-app-icon.svg",
  "Icons/location.svg",
  "Icons/destinationarrow.svg",
  "Icons/Active icons/bus.svg",
  "Icons/Active icons/torist-bus.svg",
  "Icons/Active icons/trolley.svg",
  "Icons/Active icons/night-bus.svg",
  "Icons/Active icons/metro.svg",
  "Icons/Active icons/tram.svg"
];

const scopeUrl = () => new URL(self.registration.scope);
const shellUrl = (path) => new URL(path, scopeUrl()).toString();
const canonicalUrl = (url) => `${url.origin}${url.pathname}`;

self.addEventListener("install", event => {
  event.waitUntil((async () => {
    const cache = await caches.open(SHELL_CACHE);
    await cache.addAll(SHELL_PATHS.map(shellUrl));
    await self.skipWaiting();
  })());
});

self.addEventListener("activate", event => {
  event.waitUntil((async () => {
    const keep = new Set([SHELL_CACHE, DATA_CACHE]);
    const names = await caches.keys();
    await Promise.all(names.filter(name => name.startsWith("gtsofia-") && !keep.has(name))
      .map(name => caches.delete(name)));
    await self.clients.claim();
  })());
});

self.addEventListener("fetch", event => {
  const request = event.request;
  if (request.method !== "GET") return;

  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return;

  // Realtime/API data must reflect a live request and must never be served from cache.
  if (url.pathname.includes("/api/")) return;

  const isData = /\/data\/[^/]+\.json$/.test(url.pathname);
  const isShellAsset = SHELL_PATHS.some(path =>
    path && shellUrl(path).split("?")[0] === canonicalUrl(url)
  );

  if (isData) {
    event.respondWith((async () => {
      const cache = await caches.open(DATA_CACHE);
      const key = canonicalUrl(url);
      const cached = await cache.match(key);
      const refresh = fetch(request).then(async response => {
        if (response && response.ok) await cache.put(key, response.clone());
        return response;
      }).catch(() => null);

      if (cached) {
        event.waitUntil(refresh.then(() => undefined));
        return cached;
      }
      return await refresh || Response.error();
    })());
    return;
  }

  if (isShellAsset || request.mode === "navigate") {
    event.respondWith((async () => {
      const cache = await caches.open(SHELL_CACHE);
      const key = request.mode === "navigate"
        ? canonicalUrl(new URL(url.pathname, scopeUrl()))
        : canonicalUrl(url);
      try {
        const response = await fetch(request);
        if (response && response.ok) await cache.put(key, response.clone());
        return response;
      } catch (error) {
        const cached = await cache.match(key, { ignoreSearch: true });
        if (cached) return cached;
        if (request.mode === "navigate") {
          const fallback = await cache.match(shellUrl("index.html"));
          if (fallback) return fallback;
        }
        throw error;
      }
    })());
  }
});
