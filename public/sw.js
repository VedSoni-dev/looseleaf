// Looseleaf service worker: keeps the app shell available offline. Notes themselves live in IndexedDB.
// v3: the app moved from / to /app (/ is now the public landing page). The new cache name drops v2's copy of /.
const CACHE = "looseleaf-shell-v3";
const SHELL = "/app";
const PAGES = ["/", SHELL]; // the landing page and the app keep their own cached copies
const SHELL_TIMEOUT = 4000;

self.addEventListener("install", (event) => {
  event.waitUntil(caches.open(CACHE).then((cache) => cache.add(SHELL)).then(() => self.skipWaiting()));
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
    // Fresh page when online, cached page when not.
    // Only / and /app are kept; opening /icon.svg in a tab must not replace either. Anything else falls back to the app.
    const page = PAGES.includes(url.pathname) ? url.pathname : null;
    const isShell = page === SHELL;
    const network = fetch(request).then((res) => {
      if (page && res.ok && !res.redirected) {
        const copy = res.clone();
        event.waitUntil(caches.open(CACHE).then((cache) => cache.put(page, copy)));
      }
      return res;
    });
    const cached = () =>
      caches
        .match(page || SHELL)
        .then((hit) => hit || caches.match(SHELL))
        .then((hit) => hit || Response.error());
    // On a connection that never answers, fall back to the saved app instead of hanging.
    const slow = new Promise((resolve) => setTimeout(resolve, SHELL_TIMEOUT)).then(() => caches.match(SHELL));
    event.respondWith(
      isShell
        ? Promise.race([network.catch(() => undefined), slow]).then((res) => res || network.catch(cached))
        : network.catch(cached),
    );
    return;
  }

  if (url.pathname.startsWith("/_next/static/") || url.pathname.startsWith("/pdfjs/")) {
    // Hashed, immutable build files, and the PDF reader's fonts and decoders (versioned paths).
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
