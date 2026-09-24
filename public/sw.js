// Network first, so the remote is never stale; the cached shell only shows
// when the laptop is unreachable, which beats a browser error page.
const CACHE = "hypr-remote-v1";
const SHELL = ["/", "/app.js", "/manifest.webmanifest", "/icons/icon-192.png"];

self.addEventListener("install", (event) => {
  event.waitUntil(caches.open(CACHE).then((cache) => cache.addAll(SHELL)));
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((key) => key !== CACHE).map((key) => caches.delete(key))))
      .then(() => self.clients.claim()),
  );
});

self.addEventListener("fetch", (event) => {
  const url = new URL(event.request.url);
  // Only the shell. Screenshots, uploads and the socket always go live.
  if (event.request.method !== "GET" || !SHELL.includes(url.pathname)) return;
  event.respondWith(
    fetch(event.request)
      .then((response) => {
        const copy = response.clone();
        caches.open(CACHE).then((cache) => cache.put(url.pathname, copy));
        return response;
      })
      .catch(() => caches.match(url.pathname)),
  );
});
