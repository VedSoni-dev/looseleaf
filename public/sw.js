// Looseleaf service worker: keeps the app shell available offline. Notes themselves live in IndexedDB.
const CACHE = "looseleaf-shell-v2";
const SHELL_TIMEOUT = 4000;

self.addEventListener("install", (event) => {
  event.waitUntil(caches.open(CACHE).then((cache) => cache.add("/")).then(() => self.skipWaiting()));
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((names) => Promise.all(names.filter((n) => n !== CACHE).map((n) => caches.delete(n))))
      .then(() => self.clients.claim()),
  );
});

// The page tells us which files it loaded before we took control, so the first visit is enough to go offline.
self.addEventListener("message", (event) => {
  if (event.data?.type !== "precache" || !Array.isArray(event.data.urls)) return;
  event.waitUntil(
    caches.open(CACHE).then((cache) =>
      Promise.all(
        event.data.urls.map((url) =>
          cache.match(url).then((hit) => hit || fetch(url).then((res) => (res.ok ? cache.put(url, res) : undefined)).catch(() => undefined)),
        ),
      ),
    ),
  );
});

self.addEventListener("fetch", (event) => {
  const request = event.request;
  if (request.method !== "GET") return;
  const url = new URL(request.url);
  if (url.origin !== self.location.origin || url.pathname.startsWith("/api/")) return;

  if (request.mode === "navigate") {
    // Fresh shell when online, cached shell when not.
    // Only the app itself is the shell; opening /icon.svg in a tab must not replace it.
    const isShell = url.pathname === "/";
    const network = fetch(request).then((res) => {
      if (isShell && res.ok) {
        const copy = res.clone();
        event.waitUntil(caches.open(CACHE).then((cache) => cache.put("/", copy)));
      }
      return res;
    });
    const cached = () => caches.match("/").then((hit) => hit || Response.error());
    // On a connection that never answers, fall back to the saved shell instead of hanging.
    const slow = new Promise((resolve) => setTimeout(resolve, SHELL_TIMEOUT)).then(() => caches.match("/"));
    event.respondWith(
      isShell
        ? Promise.race([network.catch(() => undefined), slow]).then((res) => res || network.catch(cached))
        : network.catch(cached),
    );
    return;
  }

  if (url.pathname.startsWith("/_next/static/")) {
    // Hashed, immutable build files.
    event.respondWith(
      caches.match(request).then(
        (hit) =>
          hit ||
          fetch(request).then((res) => {
            if (res.ok) {
              const copy = res.clone();
              caches.open(CACHE).then((cache) => cache.put(request, copy));
            }
            return res;
          }),
      ),
    );
    return;
  }

  event.respondWith(
    fetch(request)
      .then((res) => {
        if (res.ok && !url.search) {
          const copy = res.clone();
          caches.open(CACHE).then((cache) => cache.put(request, copy));
        }
        return res;
      })
      .catch(() => caches.match(request).then((hit) => hit || Response.error())),
  );
});
