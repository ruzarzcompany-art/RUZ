/**
 * طبقة مشتركة بين شاشات التطبيق: التوكن، نداء الـAPI، وأدوات عرض صغيرة.
 */

/** إصدار الواجهة المنشور — يُطابق `VERSION` في `sw.js` ويظهر في صفحة الطباعة. */
export const APP_VERSION = "v11";

export const TOKEN_KEY = "restaurant-hr.token";

export function getToken() {
  return localStorage.getItem(TOKEN_KEY);
}

export function setToken(token) {
  if (token) localStorage.setItem(TOKEN_KEY, token);
  else localStorage.removeItem(TOKEN_KEY);
}

export const el = (id) => document.getElementById(id);

/* ── انتهاء الجلسة ─────────────────────────────────────────── */

/** آخر لحظة تفاعل حقيقي من المستخدم — أساس مؤقّت الخمول. */
export const ACTIVITY_KEY = "restaurant-hr.last-activity";

/** مدة الخمول الافتراضية إن لم يُحدّدها الخادم (تُطابق `SESSION_IDLE_SECONDS`). */
export const DEFAULT_IDLE_SECONDS = 15 * 60;

export const IDLE_MESSAGE =
  "تم إنهاء الجلسة تلقائياً بعد فترة خمول أو مغادرة الصفحة، يرجى تسجيل الدخول مرة أخرى";

let sessionExpiredHandler = null;
let expiring = false;

/** يُسجّل ما تفعله الشاشة عند انتهاء الجلسة (خمول محلي أو رفض من الخادم). */
export function onSessionExpired(handler) {
  sessionExpiredHandler = handler;
}

/**
 * يُطلق إجراء انتهاء الجلسة مرة واحدة فقط — كل نداءات API المتوازية تصل
 * بـ401 في نفس اللحظة، فلا نريد إعادة التوجيه أو الرسالة أكثر من مرة.
 */
export function endSession(message = IDLE_MESSAGE) {
  if (expiring) return;
  expiring = true;
  stopIdleWatch();
  clearActivity();
  setToken(null);
  try {
    sessionExpiredHandler?.(message);
  } finally {
    // نسمح بإطلاقه مرة أخرى بعد تسجيل دخول جديد
    setTimeout(() => {
      expiring = false;
    }, 1500);
  }
}

export function markActivity() {
  try {
    localStorage.setItem(ACTIVITY_KEY, String(Date.now()));
  } catch {
    /* التخزين المحلي ممنوع (وضع خاص) — يبقى المؤقّت داخل الصفحة فقط */
  }
}

export function clearActivity() {
  localStorage.removeItem(ACTIVITY_KEY);
}

function readActivity() {
  const value = Number(localStorage.getItem(ACTIVITY_KEY));
  return Number.isFinite(value) && value > 0 ? value : 0;
}

/**
 * هل تجاوزت فترة الغياب حدّ الخمول؟ تُستخدم عند إقلاع الصفحة: من أغلق
 * الصفحة أو تركها مفتوحة دون تفاعل يجد نفسه خارج النظام عند العودة.
 */
export function idleExceeded(idleSeconds = DEFAULT_IDLE_SECONDS) {
  const last = readActivity();
  return last > 0 && Date.now() - last > idleSeconds * 1000;
}

let idleWatch = null;

/**
 * مؤقّت الخروج التلقائي. يعتمد على تفاعل المستخدم فقط (لا على نداءات
 * الخلفية) فلا تبقى الجلسة مفتوحة بسبب تحديث تلقائي، ويفحص الحالة عند
 * العودة إلى التبويب لأن المؤقّتات تُخفَّض في التبويبات المخفية.
 *
 * الخادم يفرض نفس المدة على `sessions.last_seen_at`، وهذا المؤقّت هو
 * الطبقة الظاهرة للمستخدم فقط.
 */
export function startIdleWatch({
  idleSeconds = DEFAULT_IDLE_SECONDS,
  warnSeconds = 60,
  onWarn,
  onExpire,
} = {}) {
  stopIdleWatch();

  const idleMs = Math.max(60, Number(idleSeconds) || DEFAULT_IDLE_SECONDS) * 1000;
  const events = ["pointerdown", "keydown", "wheel", "touchstart"];
  let warned = false;

  const touch = () => {
    markActivity();
    if (warned) {
      warned = false;
      onWarn?.(null);
    }
  };

  const check = () => {
    const last = readActivity() || Date.now();
    const idleFor = Date.now() - last;

    if (idleFor >= idleMs) {
      onExpire?.();
      return;
    }

    const remaining = Math.ceil((idleMs - idleFor) / 1000);
    if (remaining <= warnSeconds) {
      warned = true;
      onWarn?.(remaining);
    }
  };

  const onVisible = () => {
    if (document.visibilityState === "visible") check();
  };

  markActivity();
  for (const name of events) window.addEventListener(name, touch, { passive: true });
  document.addEventListener("visibilitychange", onVisible);
  const interval = setInterval(check, 10_000);

  idleWatch = () => {
    clearInterval(interval);
    for (const name of events) window.removeEventListener(name, touch);
    document.removeEventListener("visibilitychange", onVisible);
  };
}

export function stopIdleWatch() {
  idleWatch?.();
  idleWatch = null;
}

/* ── نداء الـAPI ───────────────────────────────────────────── */

export async function api(path, { method = "GET", body } = {}) {
  const headers = {};
  if (body !== undefined) headers["Content-Type"] = "application/json";
  const token = getToken();
  if (token) headers.Authorization = `Bearer ${token}`;

  let response;
  try {
    response = await fetch(`/api${path}`, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  } catch {
    return { ok: false, status: 0, error: "تعذّر الاتصال بالخادم. تحقّق من الشبكة." };
  }

  let payload = {};
  try {
    payload = await response.json();
  } catch {
    payload = { ok: false, error: `تعذّر قراءة رد الخادم (${response.status})` };
  }

  // الخادم أنهى الجلسة لخمولها: نُخرج المستخدم فوراً بدل تركه أمام أخطاء متتالية
  if (response.status === 401 && payload?.reason === "idle_timeout") {
    endSession(payload.error ?? IDLE_MESSAGE);
  }

  return { status: response.status, ...payload };
}

let configPromise = null;

/** إعدادات التشغيل من الخادم (`GET /api/config`) — تُقرأ مرة واحدة. */
export function loadRuntimeConfig() {
  if (!configPromise) {
    configPromise = api("/config").then((result) => (result.ok ? result : {}));
  }
  return configPromise;
}

export function setAlert(node, message, kind) {
  if (!node) return;
  node.textContent = message ?? "";
  node.hidden = !message;
  node.classList.toggle("alert--error", kind === "error");
  node.classList.toggle("alert--ok", kind === "ok");
  node.classList.toggle("alert--warn", kind === "warn");
}

export function setBusy(button, busy) {
  if (!button) return;
  button.disabled = busy;
  button.classList.toggle("is-busy", busy);
}

const dateTimeFormatter = new Intl.DateTimeFormat("ar", {
  dateStyle: "medium",
  timeStyle: "short",
});

export function formatDateTime(value) {
  if (!value) return "—";
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? "—" : dateTimeFormatter.format(date);
}

const dateFormatter = new Intl.DateTimeFormat("ar", { dateStyle: "medium" });

/** تاريخ بلا وقت (لأعمدة `date` مثل تاريخ الانضمام). */
export function formatDate(value) {
  if (!value) return "—";
  const date = new Date(String(value).length === 10 ? `${value}T00:00:00` : value);
  return Number.isNaN(date.getTime()) ? "—" : dateFormatter.format(date);
}

export function formatMoney(value, currency = "SAR") {
  const num = Number(value ?? 0);
  return `${(Number.isFinite(num) ? num : 0).toFixed(2)} ${currency}`;
}

/**
 * تنزيل ملف من الـAPI: التصدير يحتاج رأس المصادقة فلا يكفي رابط عادي،
 * فنجلب الملف كـBlob ثم نُنزّله عبر رابط مؤقّت.
 */
export async function downloadFile(path, filename) {
  const token = getToken();
  let response;
  try {
    response = await fetch(`/api${path}`, {
      headers: token ? { Authorization: `Bearer ${token}` } : {},
    });
  } catch {
    return { ok: false, error: "تعذّر الاتصال بالخادم أثناء التصدير." };
  }

  if (!response.ok) {
    let error = `تعذّر التصدير (${response.status})`;
    try {
      const payload = await response.json();
      if (payload?.error) error = payload.error;
    } catch {
      /* الرد ليس JSON — نُبقي الرسالة العامة */
    }
    return { ok: false, error };
  }

  const blob = await response.blob();
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = filename;
  document.body.append(anchor);
  anchor.click();
  anchor.remove();
  URL.revokeObjectURL(url);
  return { ok: true };
}

export function todayIso() {
  const now = new Date();
  const pad = (n) => String(n).padStart(2, "0");
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
}

export function currentMonthKey() {
  return todayIso().slice(0, 7);
}

/** `datetime-local` يحتاج قيمة بلا منطقة زمنية — نُنشئها من وقت محلي. */
export function toLocalInputValue(date = new Date()) {
  const pad = (n) => String(n).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

export const STATUS_LABELS = {
  pending: "معلّق",
  approved: "معتمد",
  rejected: "مرفوض",
  flagged: "بحاجة مراجعة",
  draft: "مسودّة",
  active: "ساري",
  ended: "منتهي",
  issued: "بعهدته",
  returned: "مُستلمة",
  lost: "مفقودة",
};

export const TYPE_LABELS = {
  check_in: "حضور",
  check_out: "انصراف",
  device: "من الجهاز",
  manual: "إدخال يدوي",
  auto_close: "إقفال تلقائي",
  receipt: "سند قبض",
  payment: "سند صرف",
  annual: "سنوية",
  sick: "مرضية",
  unpaid: "بدون راتب",
  emergency: "طارئة",
  other: "أخرى",
  uniform: "زي",
  key: "مفتاح",
  cash: "نقداً",
  bank: "بنك",
  transfer: "حوالة",
};

export function label(value) {
  if (value === null || value === undefined || value === "") return "—";
  return STATUS_LABELS[value] ?? TYPE_LABELS[value] ?? String(value);
}

/** يبني صفاً في جدول من قيم نصية. */
export function row(values, options = {}) {
  const tr = document.createElement("tr");
  if (options.className) tr.className = options.className;

  for (const value of values) {
    const td = document.createElement("td");
    if (value instanceof Node) td.append(value);
    else td.textContent = value === null || value === undefined ? "—" : String(value);
    tr.append(td);
  }

  return tr;
}

export function button(text, { className = "btn btn--ghost btn--xs", onClick } = {}) {
  const node = document.createElement("button");
  node.type = "button";
  node.className = className;
  node.textContent = text;
  if (onClick) node.addEventListener("click", () => onClick(node));
  return node;
}

/** هل يعمل التطبيق كتطبيق مُثبَّت (من الشاشة الرئيسية) لا كتبويب متصفح؟ */
export function isInstalledApp() {
  // iOS يعرّف `navigator.standalone` فقط داخل التطبيق المُثبَّت
  if (window.navigator.standalone === true) return true;
  try {
    return (
      window.matchMedia("(display-mode: standalone)").matches ||
      window.matchMedia("(display-mode: fullscreen)").matches ||
      window.matchMedia("(display-mode: minimal-ui)").matches
    );
  } catch {
    return false;
  }
}

/**
 * يفتح صفحة داخلية (صفحة الطباعة عملياً).
 *
 * التبويب الجديد ليس متاحاً دائماً: في التطبيق المُثبَّت على iOS يفتح
 * `window.open` متصفح النظام بمخزَّن محلي منفصل — فلا يجد التوكن ويُعيد
 * المستخدم إلى شاشة الدخول بدل المستند، وهو ما يظهر للمستخدم كأن «الطباعة
 * لا تعمل». وبعض المتصفحات تحجب النوافذ المنبثقة أصلاً. لذلك نفتح في نفس
 * التبويب في هذه الحالات — الجلسة محفوظة وزر «رجوع» يعيد الشاشة السابقة.
 */
export function openAppPage(url) {
  if (!isInstalledApp()) {
    try {
      const tab = window.open(url, "_blank");
      if (tab) {
        tab.focus?.();
        return "tab";
      }
    } catch {
      /* النوافذ المنبثقة محجوبة — نُكمل في نفس التبويب */
    }
  }

  window.location.assign(url);
  return "same-tab";
}

/** يفتح صفحة الطباعة لمستند محدّد. */
export function openPrint(kind, id) {
  return openAppPage(
    `/app/print/?doc=${encodeURIComponent(kind)}&id=${encodeURIComponent(id)}`,
  );
}

/**
 * يفتح نموذجاً من حزمة النماذج المطبوعة، مُملّأً تلقائياً من ملف الموظف.
 * مثال: `openDocument("contract", { employeeId: 5, refId: 2 })`.
 */
export function openDocument(docKey, options = {}) {
  const query = new URLSearchParams({ doc: docKey });
  for (const [key, value] of Object.entries(options)) {
    if (value === null || value === undefined || value === "") continue;
    query.set(key, String(value));
  }
  return openAppPage(`/app/print/?${query.toString()}`);
}

/**
 * يعود بالمستخدم إلى شاشة الدخول. `reason` يمرّ في الرابط (`?session=idle`)
 * لتعرض شاشة الدخول سبب الخروج بدل إرجاعه بلا تفسير.
 */
export function requireLogin(reason) {
  window.location.href = reason ? `/app/?session=${encodeURIComponent(reason)}` : "/app/";
}
