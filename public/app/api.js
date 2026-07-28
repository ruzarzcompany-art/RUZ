/**
 * طبقة مشتركة بين شاشات التطبيق: التوكن، نداء الـAPI، وأدوات عرض صغيرة.
 */

export const TOKEN_KEY = "restaurant-hr.token";

export function getToken() {
  return localStorage.getItem(TOKEN_KEY);
}

export function setToken(token) {
  if (token) localStorage.setItem(TOKEN_KEY, token);
  else localStorage.removeItem(TOKEN_KEY);
}

export const el = (id) => document.getElementById(id);

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

  return { status: response.status, ...payload };
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

/** يفتح صفحة الطباعة لمستند محدّد. */
export function openPrint(kind, id) {
  window.open(`/app/print/?doc=${encodeURIComponent(kind)}&id=${encodeURIComponent(id)}`, "_blank");
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
  window.open(`/app/print/?${query.toString()}`, "_blank");
}

export function requireLogin() {
  window.location.href = "/app/";
}
