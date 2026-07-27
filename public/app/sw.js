/**
 * خدمة العمل دون اتصال: تخزين قشرة التطبيق فقط.
 * طلبات /api لا تُخزَّن أبداً — تسجيل الحضور يجب أن يصل الخادم فعلياً.
 */

const CACHE = "restaurant-hr-shell-v3";
const SHELL = [
  "/app/",
  "/app/index.html",
  "/app/styles.css",
  "/app/api.js",
  "/app/app.js",
  "/app/face.js",
  "/app/forms-ui.js",
  "/app/icon.svg",
  "/app/manifest.webmanifest",
  "/app/admin/",
  "/app/admin/index.html",
  "/app/admin/admin.js",
  "/app/admin/people.js",
  "/app/admin/reports.js",
  "/app/print/",
  "/app/print/index.html",
  "/app/print/print.js",
];

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches.open(CACHE).then((cache) => cache.addAll(SHELL)).then(() => self.skipWaiting()),
  );
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
  const { request } = event;
  const url = new URL(request.url);

  if (request.method !== "GET" || url.origin !== self.location.origin) return;
  if (url.pathname.startsWith("/api")) return;

  event.respondWith(
    caches.match(request).then(
      (cached) =>
        cached ??
        fetch(request).catch(() => caches.match("/app/index.html")),
    ),
  );
});
