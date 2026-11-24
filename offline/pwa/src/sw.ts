// Service worker: precaches the app shell, and serves the downloaded index, model and
// runtime from the data cache so everything works with no network.
const sw = self as unknown as ServiceWorkerGlobalScope;
declare const SHELL_VERSION: string; // injected at build time

const SHELL_CACHE = `aa-shell-${SHELL_VERSION}`;
const DATA_CACHE = "aa-data-v1";
const SHELL = ["./", "index.html", "app.js", "styles.css", "manifest.webmanifest", "icon.svg", "icon-192.png", "icon-512.png"];

sw.addEventListener("install", (e: ExtendableEvent) => {
  e.waitUntil(caches.open(SHELL_CACHE).then((c) => c.addAll(SHELL)).then(() => sw.skipWaiting()));
});

sw.addEventListener("activate", (e: ExtendableEvent) => {
  e.waitUntil(
    (async () => {
      for (const k of await caches.keys()) if (k.startsWith("aa-shell-") && k !== SHELL_CACHE) await caches.delete(k);
      await sw.clients.claim();
    })(),
  );
});

sw.addEventListener("fetch", (e: FetchEvent) => {
  const req = e.request;
  if (req.method !== "GET" || new URL(req.url).origin !== location.origin) return;
  const url = new URL(req.url);
  // The manifest and asset list are fetched with cache: "no-store" to check for updates: always go to the network.
  if (url.pathname.endsWith("/index/manifest.json") || url.pathname.endsWith("/assets.json")) return;
  e.respondWith(
    (async () => {
      const data = await (await caches.open(DATA_CACHE)).match(req, { ignoreSearch: true });
      if (data) return data;
      const shell = await (await caches.open(SHELL_CACHE)).match(req, { ignoreSearch: true });
      if (shell) {
        // Refresh the shell in the background so the next visit gets new app code.
        if (req.mode === "navigate") e.waitUntil(fetch(req).then(async (r) => { if (r.ok) await (await caches.open(SHELL_CACHE)).put(req, r); }).catch(() => {}));
        return shell;
      }
      try {
        return await fetch(req);
      } catch {
        if (req.mode === "navigate") return (await (await caches.open(SHELL_CACHE)).match("index.html"))!;
        return new Response("Offline", { status: 503 });
      }
    })(),
  );
});
