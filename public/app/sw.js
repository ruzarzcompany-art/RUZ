/**
 * خدمة العمل دون اتصال: تخزين قشرة التطبيق فقط.
 * طلبات /api لا تُخزَّن أبداً — تسجيل الحضور يجب أن يصل الخادم فعلياً.
 *
 * الاستراتيجية «الشبكة أولاً» مقصودة: النسخة المخزَّنة تُستخدم عند انقطاع
 * الشبكة فقط. الاستراتيجية السابقة (المخزَّن أولاً بلا أي تحديث) كانت تُثبّت
 * المتصفح على نسخة قديمة من كود الواجهة بعد كل نشر — فتبقى الأخطاء
 * المُصلَحة ظاهرة للمستخدم كما هي، وأبرزها صفحة الطباعة التي كانت تُحمَّل
 * من الذاكرة بنسخة ما قبل الإصلاح.
 */

/** رقم نسخة القشرة — يُرفع مع كل تحديث للواجهة (يُطابق APP_VERSION في api.js). */
const VERSION = "v10";
const CACHE = `restaurant-hr-shell-${VERSION}`;
const OFFLINE_FALLBACK = "/app/index.html";

const SHELL = [
  "/app/",
  "/app/index.html",
  "/app/styles.css",
  "/app/api.js",
  "/app/app.js",
  "/app/face.js",
  "/app/forms-ui.js",
  "/app/map-picker.js",
  "/app/pagination.js",
  "/app/icon.svg",
  "/app/manifest.webmanifest",
  "/app/admin/",
  "/app/admin/index.html",
  "/app/admin/admin.js",
  "/app/admin/people.js",
  "/app/admin/reports.js",
  "/app/admin/settings.js",
  "/app/admin/cashier.js",
  "/app/admin/inventory.js",
  "/app/admin/documents.js",
  "/app/admin/access.js",
  "/app/print/",
  "/app/print/index.html",
  "/app/print/print.js",
  "/app/print/identity.js",
  "/app/print/templates.js",
  // صفحة الطباعة تطلب وحداتها بلاحقة الإصدار (انظر التعليق في print/index.html)،
  // والمتصفح يعتبر الرابط الموسوم عنواناً مختلفاً، فيُخزَّن هو أيضاً ليعمل
  // المستند دون اتصال من أول لحظة بعد التثبيت.
  `/app/print/print.js?v=${VERSION}`,
  `/app/print/identity.js?v=${VERSION}`,
  `/app/print/templates.js?v=${VERSION}`,
  `/app/api.js?v=${VERSION}`,
];

/**
 * التخزين المبدئي ملفاً ملفاً: `cache.addAll` يفشل كاملاً إذا تعذّر تحميل
 * ملف واحد، فيبقى العامل القديم مسيطراً ولا يصل التحديث إلى المستخدم أبداً.
 */
async function precache() {
  const cache = await caches.open(CACHE);
  await Promise.allSettled(
    SHELL.map(async (path) => {
      const response = await fetch(new Request(path, { cache: "reload" }));
      if (response.ok) await cache.put(path, response);
    }),
  );
}

self.addEventListener("install", (event) => {
  event.waitUntil(precache().then(() => self.skipWaiting()));
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((key) => key !== CACHE).map((key) => caches.delete(key))))
      .then(() => self.clients.claim()),
  );
});

/** الشبكة أولاً: أحدث نسخة دائماً، والمخزَّن احتياطٌ عند انقطاع الاتصال. */
async function networkFirst(event) {
  const { request } = event;
  const cache = await caches.open(CACHE);

  try {
    const response = await fetch(request);
    // النسخ الناجحة من نفس الأصل فقط تُخزَّن (الردود المعتمة لا تُخزَّن)
    if (response.ok && response.type === "basic") {
      const copy = response.clone();
      event.waitUntil(cache.put(request, copy).catch(() => {}));
    }
    return response;
  } catch {
    const cached = await cache.match(request);
    if (cached) return cached;

    // تصفّح دون اتصال لصفحة غير مخزَّنة: نُعيد قشرة التطبيق
    if (request.mode === "navigate") {
      const fallback = await cache.match(OFFLINE_FALLBACK);
      if (fallback) return fallback;
    }

    return new Response("لا يوجد اتصال بالشبكة، وهذه الصفحة غير محفوظة للعمل دون اتصال.", {
      status: 503,
      headers: { "content-type": "text/plain; charset=utf-8" },
    });
  }
}

self.addEventListener("fetch", (event) => {
  const { request } = event;
  const url = new URL(request.url);

  if (request.method !== "GET" || url.origin !== self.location.origin) return;
  if (url.pathname.startsWith("/api")) return;

  event.respondWith(networkFirst(event));
});
