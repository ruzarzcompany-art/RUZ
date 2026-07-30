/**
 * سِجل — منطق تطبيق الموظف.
 *
 * - التوكن في localStorage، والوقت المعروض يُزامن مع توقيت الخادم
 *   (وقت الجهاز لا يُعتمد عليه في التسجيل إطلاقاً).
 * - بصمة الوجه تُستخرج داخل المتصفح (`face.js`) ويُرسل المتجّه فقط.
 * - الضغط المتكرر يُتجاهل محلياً أيضاً، بالإضافة إلى تهدئة الخادم.
 */

import {
  api,
  clearActivity,
  DEFAULT_IDLE_SECONDS,
  el,
  endSession,
  formatDate,
  formatDateTime,
  formatMoney,
  idleExceeded,
  IDLE_MESSAGE,
  label,
  loadRuntimeConfig,
  markActivity,
  onSessionExpired,
  row,
  setAlert,
  setBusy,
  setToken,
  getToken,
  startIdleWatch,
  stopIdleWatch,
  todayIso,
} from "./api.js";
import { captureFaceDescriptor, isFaceCaptureSupported, warmUpFaceEngine } from "./face.js";
import { collectFormValues, LIST_COLUMNS, loadFormsSchema, renderFormFields } from "./forms-ui.js";

const state = {
  serverOffsetMs: 0,
  branch: null,
  permissions: [],
  nextType: "check_in",
  busy: false,
  lastPunchAt: 0,
  cooldownSeconds: 8,
  face: {
    mode: "optional",
    systemMode: "optional",
    enabled: true,
    enrolled: false,
    slots: 3,
    enrolledSlots: [],
    threshold: 0.55,
    supported: isFaceCaptureSupported(),
  },
  myResource: "advances",
  /** القسم الإضافي المعروض من القائمة العلوية */
  panel: "requests",
  /** الأقسام الإضافية المسموحة لهذا الموظف */
  allowedPanels: new Set(["requests", "password"]),
  /** آخر اسم موظف مسجَّل — يُعرض مع لقطة المطابقة */
  fullName: "",
  schema: null,
  idleSeconds: DEFAULT_IDLE_SECONDS,
  /** هل يستطيع الموقع إرسال رمز الاستعادة بالبريد؟ */
  resetByEmail: false,
};

/* ── التنقّل بين الشاشات ───────────────────────────────────── */

function showLogin(message) {
  stopIdleWatch();
  el("idle-note").hidden = true;
  el("screen-punch").hidden = true;
  el("screen-login").hidden = false;
  el("reset-card").hidden = true;
  el("login-form").hidden = false;
  if (message) setAlert(el("login-error"), message, "error");
}

function showPunch() {
  el("screen-login").hidden = true;
  el("reset-card").hidden = true;
  el("screen-punch").hidden = false;
}

/* ── الخروج التلقائي ───────────────────────────────────────── */

/**
 * يبدأ مراقبة الخمول لهذه الجلسة: تنبيه قبل الخروج بدقيقة، ثم إنهاء
 * الجلسة على الخادم وإرجاع المستخدم لشاشة الدخول.
 */
function watchIdle() {
  el("idle-note").hidden = true;

  startIdleWatch({
    idleSeconds: state.idleSeconds,
    onWarn: (remaining) => {
      const note = el("idle-note");
      if (remaining === null) {
        note.hidden = true;
        return;
      }
      note.hidden = false;
      note.textContent = `خروج تلقائي بعد ${remaining} ثانية`;
    },
    onExpire: async () => {
      stopIdleWatch();
      await api("/auth/logout", { method: "POST" });
      endSession(IDLE_MESSAGE);
    },
  });
}

onSessionExpired((message) => {
  showLogin(message);
});

/* ── ساعة الخادم ───────────────────────────────────────────── */

const dateFormatter = new Intl.DateTimeFormat("ar", {
  weekday: "long",
  day: "numeric",
  month: "long",
  year: "numeric",
});

function tickClock() {
  const now = new Date(Date.now() + state.serverOffsetMs);
  const timeZone = state.branch?.timezone || undefined;
  el("clock-time").textContent = new Intl.DateTimeFormat("en-GB", {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
    timeZone,
  }).format(now);
  el("clock-date").textContent = dateFormatter.format(now);
}

/* ── الموقع الجغرافي ───────────────────────────────────────── */

const GEO_ERRORS = {
  1: "تم رفض إذن الوصول إلى الموقع. فعّل صلاحية الموقع لهذا الموقع من إعدادات المتصفح ثم أعد المحاولة.",
  2: "تعذّر تحديد موقعك الحالي. تأكد من تشغيل خدمة الموقع (GPS) وأعد المحاولة.",
  3: "استغرق تحديد الموقع وقتاً طويلاً. أعد المحاولة في مكان مكشوف.",
};

function requestPosition() {
  return new Promise((resolve, reject) => {
    if (!navigator.geolocation) {
      reject(new Error("هذا الجهاز لا يدعم تحديد الموقع الجغرافي."));
      return;
    }
    navigator.geolocation.getCurrentPosition(
      resolve,
      (error) => reject(new Error(GEO_ERRORS[error.code] ?? "تعذّر قراءة الموقع الجغرافي.")),
      { enableHighAccuracy: true, timeout: 20_000, maximumAge: 0 },
    );
  });
}

/* ── لوحة الحضور ───────────────────────────────────────────── */

function paintNextAction() {
  const isOut = state.nextType === "check_out";
  el("punch-label").textContent = isOut ? "تسجيل انصراف" : "تسجيل حضور";
  el("punch-btn").classList.toggle("is-out", isOut);
}

function paintDistance(distanceMeters, radiusMeters) {
  const node = el("geo-distance");
  node.classList.remove("is-far", "is-near");

  if (distanceMeters === null || distanceMeters === undefined) {
    node.textContent = "—";
    return;
  }

  node.textContent = `${Math.round(distanceMeters)} م`;
  node.classList.add(distanceMeters <= radiusMeters ? "is-near" : "is-far");
}

const timeFormatter = new Intl.DateTimeFormat("en-GB", {
  hour: "2-digit",
  minute: "2-digit",
  hour12: false,
});

const LOG_STATUS_NOTE = {
  rejected: "مرفوض — للمراجعة",
  flagged: "بحاجة مراجعة",
};

function paintTodayLog(logs) {
  const list = el("today-list");
  list.textContent = "";
  el("today-empty").hidden = logs.length > 0;

  for (const log of logs) {
    const item = document.createElement("li");
    item.className = "log__item";
    if (log.status === "rejected") item.classList.add("is-rejected");
    if (log.status === "flagged") item.classList.add("is-flagged");

    const time = document.createElement("span");
    time.className = "log__time";
    time.dir = "ltr";
    time.textContent = timeFormatter.format(new Date(log.serverTime));

    const kind = document.createElement("span");
    kind.textContent = log.type === "check_in" ? "حضور" : "انصراف";
    if (log.source && log.source !== "device") {
      kind.textContent += ` (${label(log.source)})`;
    }

    const meta = document.createElement("span");
    meta.className = "log__meta";
    meta.textContent =
      LOG_STATUS_NOTE[log.status] ??
      `${Math.round(log.distanceMeters ?? 0)} م${log.faceVerified ? " · وجه ✓" : ""}`;

    item.append(time, kind, meta);
    list.append(item);
  }
}

async function refreshToday() {
  const result = await api("/attendance/today");
  if (!result.ok) return;

  state.serverOffsetMs = new Date(result.serverTime).getTime() - Date.now();
  state.nextType = result.openShift ? "check_out" : "check_in";
  paintNextAction();
  paintTodayLog(result.logs ?? []);

  const openNote = el("open-shift");
  if (result.openShift && result.openShiftSince) {
    setAlert(
      openNote,
      `لديك وردية مفتوحة منذ ${formatDateTime(result.openShiftSince)} — سجّل الانصراف قبل أي حضور جديد.`,
      "warn",
    );
  } else {
    setAlert(openNote, "");
  }
}

/* ── مطابقة الوجه ──────────────────────────────────────────── */

const FACE_MODE_TEXT = {
  off: "مطابقة الوجه معطّلة على مستوى النظام.",
  optional: "مطابقة الوجه مُفعّلة (اختيارية): أول بصمة تُسجَّل تلقائياً ثم تُطابق في كل مرة.",
  enforce: "مطابقة الوجه إلزامية لكل عملية حضور أو انصراف.",
};

function paintFaceCard() {
  const card = el("face-card");
  // البصمة معطّلة لهذا الموظف بعلامة صح من شاشة الموظفين، والوضع العام مُفعّل
  const disabledForMe = state.face.enabled === false && state.face.systemMode !== "off";
  card.hidden = state.face.mode === "off" && !disabledForMe;
  if (card.hidden) return;

  const slotsTotal = state.face.slots ?? 3;
  const done = state.face.enrolledSlots.length;

  const badge = el("face-badge");
  badge.textContent = disabledForMe
    ? "معطّلة لحسابك"
    : done === 0
      ? "بلا بصمة"
      : `${done}/${slotsTotal} بصمات`;
  badge.classList.toggle("badge--ok", !disabledForMe && done >= slotsTotal);
  badge.classList.toggle("badge--warn", disabledForMe || done < slotsTotal);

  // خانات التسجيل: تظهر ما لم تكتمل الثلاث بصمات
  const slotsBlock = el("face-slots");
  slotsBlock.hidden = disabledForMe || !state.face.supported || done >= slotsTotal;
  for (const button of slotsBlock.querySelectorAll("[data-face-slot]")) {
    const slot = Number(button.dataset.faceSlot);
    const taken = state.face.enrolledSlots.includes(slot);
    button.disabled = taken;
    button.textContent = taken
      ? `البصمة ${slot} مسجَّلة ✓`
      : `التقاط البصمة ${slot === 1 ? "الأولى" : slot === 2 ? "الثانية" : "الثالثة"}`;
  }
  el("face-slots-state").textContent =
    done === 0
      ? `لم تُسجَّل أي بصمة بعد — المطلوب ${slotsTotal} بصمات بزر لكل واحدة.`
      : `المسجَّل ${done} من ${slotsTotal}؛ أكمل الباقي لترتفع دقة المطابقة.`;

  el("face-warm").hidden = disabledForMe;
  el("face-toggle").disabled =
    disabledForMe || !state.face.supported || state.face.mode === "enforce";
  if (disabledForMe || !state.face.supported) el("face-toggle").checked = false;
  // في الوضع الإلزامي لا خيار للموظف في تعطيل الوجه
  if (state.face.mode === "enforce" && !disabledForMe && state.face.supported) {
    el("face-toggle").checked = true;
  }

  const lines = disabledForMe
    ? ["أوقفت الإدارة مطابقة الوجه لحسابك — يُسجَّل حضورك بالموقع الجغرافي فقط."]
    : [FACE_MODE_TEXT[state.face.mode] ?? ""];

  if (!disabledForMe && !state.face.supported) {
    lines.push("هذا المتصفح لا يدعم الكاميرا عبر HTTPS، سيُسجَّل الحضور بالموقع الجغرافي فقط.");
  }
  el("face-status").textContent = lines.filter(Boolean).join(" ");
}

async function refreshFaceStatus() {
  const result = await api("/face/status");
  if (!result.ok) return;
  state.face = {
    ...state.face,
    mode: result.mode,
    systemMode: result.systemMode ?? result.mode,
    enabled: result.faceEnabled !== false,
    threshold: result.threshold,
    enrolled: Boolean(result.enrolled),
    slots: result.slots ?? state.face.slots,
    enrolledSlots: Array.isArray(result.enrolledSlots)
      ? result.enrolledSlots
      : result.enrolled
        ? [1]
        : [],
  };
  paintFaceCard();
}

function faceProgress(text) {
  el("face-hint").textContent = text;
}

/**
 * يلتقط بصمة من الكاميرا. اللقطة المُعادة للعرض على الجهاز فقط،
 * والمُرسل للخادم هو المتجّه الرقمي وحده.
 */
async function grabFaceCapture() {
  const video = el("face-video");
  video.classList.add("is-live");
  try {
    return await captureFaceDescriptor(video, faceProgress);
  } finally {
    video.classList.remove("is-live");
    faceProgress("تُستخرج بصمة الوجه على جهازك، ولا تُرسل أي صورة إلى الخادم.");
  }
}

/** يعرض لقطة التحقق مع اسم الموظف بعد مطابقة ناجحة (على الجهاز فقط). */
function paintMatchCard(snapshot, face) {
  const card = el("match-card");
  if (!snapshot) {
    card.hidden = true;
    return;
  }

  const verified = Boolean(face?.verified);
  el("match-photo").src = snapshot;
  el("match-name").textContent = state.fullName || "—";
  el("match-meta").textContent = verified
    ? face?.distance === null || face?.distance === undefined
      ? "تم تسجيل بصمة وجهك من هذه اللقطة."
      : `مطابقة صحيحة (فرق ${face.distance} من حد ${face.threshold}).`
    : "لم تُعتمد المطابقة — راجع المسؤول.";

  const badge = el("match-badge");
  badge.textContent = verified ? "الوجه مطابق" : "بحاجة لمراجعة";
  badge.classList.toggle("badge--ok", verified);
  badge.classList.toggle("badge--warn", !verified);

  card.hidden = false;
}

/* ── طلباتي ────────────────────────────────────────────────── */

function paintMyTable(items) {
  const table = el("my-table");
  const columns = LIST_COLUMNS[state.myResource] ?? [];
  const head = table.querySelector("thead");
  const body = table.querySelector("tbody");

  head.textContent = "";
  const headRow = document.createElement("tr");
  for (const column of columns) {
    const th = document.createElement("th");
    th.textContent = column.label;
    headRow.append(th);
  }
  head.append(headRow);

  body.textContent = "";
  el("my-empty").hidden = items.length > 0;

  for (const item of items) {
    const cells = columns.map((column) => {
      const value = item[column.key];
      if (column.money) return formatMoney(value);
      if (column.badge || column.translate) return label(value);
      return value ?? "—";
    });
    body.append(row(cells));
  }
}

async function refreshMyForms() {
  const result = await api(`/forms/${state.myResource}`);
  if (!result.ok) {
    setAlert(el("my-result"), result.error ?? "تعذّر قراءة الطلبات", "error");
    return;
  }
  paintMyTable(result.items ?? []);
}

async function renderMyForm() {
  if (!state.schema) state.schema = await loadFormsSchema();
  const resource = state.schema.get(state.myResource);
  if (!resource) return;

  const defaults =
    state.myResource === "advances"
      ? { requestDate: todayIso() }
      : state.myResource === "overtime"
        ? { workDate: todayIso() }
        : { startDate: todayIso(), endDate: todayIso() };

  renderFormFields(el("my-fields"), resource, { mode: "self", values: defaults });
  await refreshMyForms();
}

/* ── قائمة الإضافات العلوية ────────────────────────────────── */

/** أقسام القائمة العلوية: الطلبات، الملف الوظيفي، تغيير كلمة المرور. */
const EXTRA_PANELS = [
  { key: "requests", nodeId: "panel-requests" },
  { key: "file", nodeId: "file-card" },
  { key: "password", nodeId: "panel-password" },
];

/** يعرض القسم المختار من القائمة ويخفي البقية (والممنوع يُخفى زره أيضاً). */
function paintPanels() {
  for (const panel of EXTRA_PANELS) {
    const allowed = state.allowedPanels.has(panel.key);
    const node = el(panel.nodeId);
    if (node) node.hidden = !(allowed && state.panel === panel.key);

    const tab = el("extras-nav").querySelector(`[data-panel="${panel.key}"]`);
    if (!tab) continue;
    tab.hidden = !allowed;
    tab.classList.toggle("is-active", allowed && state.panel === panel.key);
  }
}

/** ينتقل إلى قسم إضافي ويحمّل بياناته عند الحاجة. */
async function showPanel(key) {
  if (!state.allowedPanels.has(key)) return;
  state.panel = key;
  paintPanels();

  if (key === "file") await refreshMyFile();
}

/* ── ملفي الوظيفي ─────────────────────────────────────────── */

/** يعرض بيانات ملف الموظف مع اسم مدير فرعه وجدول دوامه. */
async function refreshMyFile() {
  const card = el("file-card");
  if (!card || card.hidden) return;

  const result = await api("/employees/me/file");
  if (!result.ok) {
    // الملف غير متاح لهذا الحساب: يُسحب من قائمة الإضافات بدل عرض قسم فارغ
    state.allowedPanels.delete("file");
    if (state.panel === "file") state.panel = "requests";
    paintPanels();
    return;
  }

  const employee = result.employee;
  const schedule = result.schedule;
  const dash = (value) => (value ? String(value) : "—");

  el("file-name").textContent = `${employee.fullName} · ${employee.employeeCode}`;
  el("file-identity").textContent = `${dash(employee.nationality)} / ${dash(employee.nationalId)}`;
  el("file-contact").textContent = `${dash(employee.phone)} / ${dash(employee.email)}`;
  el("file-job").textContent = `${dash(employee.department)} · ${dash(employee.jobTitle)}`;
  el("file-join").textContent = formatDate(employee.joinDate);
  el("file-branch").textContent = `${dash(employee.branchName)} · ${
    employee.branchManagerName ? `المدير: ${employee.branchManagerName}` : "بلا مدير محدّد"
  }`;
  el("file-schedule").textContent = schedule
    ? `${schedule.shiftStart} — ${schedule.shiftEnd} (${schedule.dailyHours} ساعات يومياً)`
    : "لا يوجد جدول دوام مُعرَّف";
  el("file-off-days").textContent = schedule
    ? schedule.offMode === "dates"
      ? `${schedule.daysOffPerMonth} أيام شهرياً · إجازات هذا الشهر: ${schedule.offDaysLabel}`
      : `${schedule.daysOffPerMonth} أيام شهرياً · ${schedule.offDaysLabel}`
    : "—";
}

/* ── الملف الشخصي ──────────────────────────────────────────── */

const ADMIN_PERMISSIONS = [
  "attendance.manual_write",
  "attendance.correct_checkout",
  "attendance.read_all",
  "forms.approve",
  "payroll.manage",
  // الكاشير وأمين المخزن يدخلان اللوحة لشاشتهما فقط
  "cashier.submit",
  "cashier.review",
  "inventory.read",
  "inventory.write",
  "documents.print",
  "settings.manage",
];

async function loadProfile() {
  const result = await api("/auth/me");

  if (!result.ok) {
    setToken(null);
    showLogin(result.status === 401 ? "" : result.error);
    return;
  }

  state.branch = result.branch;
  state.permissions = result.permissions ?? [];
  state.fullName = result.employee.fullName;
  state.serverOffsetMs = new Date(result.serverTime).getTime() - Date.now();

  el("who-name").textContent = result.employee.fullName;
  el("who-meta").textContent = [result.employee.employeeCode, result.employee.jobTitle]
    .filter(Boolean)
    .join(" · ");
  el("geo-branch").textContent = state.branch ? state.branch.name : "غير مرتبط بفرع";
  el("geo-radius").textContent = state.branch ? `${state.branch.radiusMeters} م` : "—";
  el("set-branch").hidden = !(state.permissions.includes("branches.write") && state.branch);
  el("admin-link").hidden = !state.permissions.some((code) => ADMIN_PERMISSIONS.includes(code));

  // أقسام القائمة العلوية: الملف الوظيفي قابل للتعطيل لموظف بعينه
  state.allowedPanels = new Set(["requests", "password"]);
  if (state.permissions.includes("sections.employee_file")) state.allowedPanels.add("file");
  if (!state.allowedPanels.has(state.panel)) state.panel = "requests";
  paintPanels();

  el("punch-btn").disabled = false;
  el("punch-sub").textContent = "اضغط للسماح بالموقع وتسجيل الحركة";

  showPunch();
  tickClock();

  const config = await loadRuntimeConfig();
  if (config.ok) {
    state.cooldownSeconds = config.shifts?.punchCooldownSeconds ?? state.cooldownSeconds;
    state.idleSeconds = config.session?.idleSeconds ?? state.idleSeconds;
    state.resetByEmail = Boolean(config.passwordReset?.emailEnabled);
  }

  markActivity();
  watchIdle();

  await Promise.all([refreshToday(), refreshFaceStatus(), renderMyForm()]);
}

/* ── الأحداث ───────────────────────────────────────────────── */

el("login-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  const button = el("login-submit");
  setAlert(el("login-error"), "");
  setBusy(button, true);

  const result = await api("/auth/login", {
    method: "POST",
    body: {
      identifier: el("identifier").value.trim(),
      password: el("password").value,
    },
  });

  setBusy(button, false);

  if (!result.ok) {
    setAlert(el("login-error"), result.error ?? "فشل تسجيل الدخول", "error");
    return;
  }

  setToken(result.token);
  el("password").value = "";
  markActivity();
  await loadProfile();
});

/* ── نسيت الرقم السري ──────────────────────────────────────── */

function showResetCard(show) {
  el("reset-card").hidden = !show;
  el("login-form").hidden = show;

  if (!show) return;

  setAlert(el("reset-result"), "");
  el("reset-identifier").value = el("identifier").value.trim();
  el("reset-note").textContent = state.resetByEmail
    ? "أدخل رقمك الوظيفي أو بريدك المسجَّل، ويُرسل الموقع رمز الاستعادة إلى بريدك. إن لم يكن لحسابك بريد فسيصل الطلب إلى مسؤول البرنامج ليسلّمك الرمز."
    : "أدخل رقمك الوظيفي أو بريدك، ويصل الطلب إلى مسؤول البرنامج ليصدر لك رمز الاستعادة ويسلّمه لك (إرسال البريد غير مضبوط على هذا الموقع).";
  el("reset-identifier").focus();
}

el("forgot-open").addEventListener("click", () => {
  setAlert(el("login-error"), "");
  showResetCard(true);
});

el("reset-close").addEventListener("click", () => showResetCard(false));

el("reset-request").addEventListener("click", async () => {
  const button = el("reset-request");
  const identifier = el("reset-identifier").value.trim();

  if (!identifier) {
    setAlert(el("reset-result"), "أدخل رقم الموظف أو البريد الإلكتروني.", "error");
    return;
  }

  setBusy(button, true);
  const result = await api("/auth/forgot-password", {
    method: "POST",
    body: { identifier },
  });
  setBusy(button, false);

  setAlert(
    el("reset-result"),
    result.ok ? result.message : (result.error ?? "تعذّر إرسال الطلب"),
    result.ok ? "ok" : "error",
  );

  if (result.ok) el("reset-code").focus();
});

el("reset-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  const button = el("reset-submit");
  const password = el("reset-password").value;

  if (password !== el("reset-password2").value) {
    setAlert(el("reset-result"), "كلمتا المرور غير متطابقتين.", "error");
    return;
  }

  setBusy(button, true);
  const result = await api("/auth/reset-password", {
    method: "POST",
    body: {
      identifier: el("reset-identifier").value.trim(),
      code: el("reset-code").value.trim(),
      newPassword: password,
    },
  });
  setBusy(button, false);

  if (!result.ok) {
    setAlert(el("reset-result"), result.error ?? "تعذّر تعيين كلمة المرور", "error");
    return;
  }

  el("reset-code").value = "";
  el("reset-password").value = "";
  el("reset-password2").value = "";
  showResetCard(false);
  el("identifier").value = el("reset-identifier").value.trim();
  setAlert(el("reset-result"), "");
  setAlert(el("login-error"), result.message, "ok");
  el("password").focus();
});

el("password-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  const button = el("password-submit");
  const newPassword = el("password-new").value;

  if (newPassword !== el("password-new2").value) {
    setAlert(el("password-result"), "كلمتا المرور الجديدتان غير متطابقتين.", "error");
    return;
  }

  setBusy(button, true);
  const result = await api("/auth/change-password", {
    method: "POST",
    body: { currentPassword: el("password-current").value, newPassword },
  });
  setBusy(button, false);

  setAlert(
    el("password-result"),
    result.ok ? result.message : (result.error ?? "تعذّر تغيير كلمة المرور"),
    result.ok ? "ok" : "error",
  );

  if (result.ok) {
    // الخادم أبطل الجلسات وأصدر توكن جديداً لهذا الجهاز
    setToken(result.token);
    markActivity();
    el("password-current").value = "";
    el("password-new").value = "";
    el("password-new2").value = "";
  }
});

el("punch-btn").addEventListener("click", async () => {
  const button = el("punch-btn");
  const result = el("punch-result");

  // تجاهل الضغط المتكرر السريع محلياً قبل إزعاج الشبكة
  const sinceLast = Date.now() - state.lastPunchAt;
  if (state.busy || sinceLast < state.cooldownSeconds * 1000) {
    if (!state.busy) {
      const remaining = Math.ceil((state.cooldownSeconds * 1000 - sinceLast) / 1000);
      setAlert(result, `تمهّل قليلاً — أعد المحاولة بعد ${remaining} ثانية.`, "warn");
    }
    return;
  }

  state.busy = true;
  state.lastPunchAt = Date.now();
  button.disabled = true;
  setAlert(result, "");

  const useFace = state.face.mode !== "off" && state.face.supported && el("face-toggle").checked;
  let faceDescriptor;
  let faceSnapshot = null;

  try {
    if (useFace) {
      el("punch-sub").textContent = "جارٍ التحقق من الوجه…";
      try {
        const capture = await grabFaceCapture();
        faceDescriptor = capture.descriptor;
        faceSnapshot = capture.snapshot;
      } catch (error) {
        if (state.face.mode === "enforce") throw error;
        setAlert(result, `${error.message} سيُسجَّل الحضور بالموقع الجغرافي فقط.`, "warn");
      }
    }

    el("punch-sub").textContent = "جارٍ تحديد موقعك…";
    const position = await requestPosition();

    el("punch-sub").textContent = "جارٍ إرسال التسجيل…";
    const response = await api(
      `/attendance/${state.nextType === "check_out" ? "check-out" : "check-in"}`,
      {
        method: "POST",
        body: {
          latitude: position.coords.latitude,
          longitude: position.coords.longitude,
          accuracyMeters: position.coords.accuracy,
          clientTime: new Date().toISOString(),
          deviceInfo: navigator.userAgent,
          ...(faceDescriptor ? { faceDescriptor } : {}),
        },
      },
    );

    const attendance = response.attendance;
    if (attendance) paintDistance(attendance.distanceMeters, attendance.allowedRadiusMeters);
    // صورة التأكيد تُعرض على الجهاز فقط عند نجاح التسجيل بمطابقة الوجه
    paintMatchCard(response.ok ? faceSnapshot : null, attendance?.face);

    if (response.ok) {
      const extra = response.warning ? ` (${response.warning})` : "";
      setAlert(
        result,
        `${response.message} — ${attendance.localTime}${extra}`,
        response.warning ? "warn" : "ok",
      );
      if (navigator.vibrate) navigator.vibrate(28);
      await Promise.all([refreshToday(), refreshFaceStatus()]);
    } else if (response.status === 401) {
      setToken(null);
      showLogin("انتهت الجلسة، يرجى تسجيل الدخول مرة أخرى");
    } else {
      const note = response.note ? ` ${response.note}` : "";
      setAlert(result, `${response.error ?? "فشل تسجيل الحركة"}${note}`, "error");
      await refreshToday();
    }
  } catch (error) {
    setAlert(result, error.message, "error");
  } finally {
    el("punch-sub").textContent = "اضغط للسماح بالموقع وتسجيل الحركة";
    button.disabled = false;
    state.busy = false;
  }
});

/* تسجيل البصمات: زر لكل بصمة من الثلاث، ولكل زر التقاط مستقل */
el("face-slots").addEventListener("click", async (event) => {
  const button = event.target.closest("[data-face-slot]");
  if (!button || button.disabled) return;

  const slot = Number(button.dataset.faceSlot);
  setBusy(button, true);

  try {
    const capture = await grabFaceCapture();
    const response = await api("/face/enroll", {
      method: "POST",
      body: { descriptor: capture.descriptor, slot },
    });

    setAlert(
      el("punch-result"),
      response.ok ? response.message : (response.error ?? "تعذّر تسجيل البصمة"),
      response.ok ? "ok" : "error",
    );

    if (response.ok) {
      // لقطة البصمة المُسجَّلة تُعرض للتأكيد على الجهاز فقط
      paintMatchCard(capture.snapshot, { verified: true, distance: null });
      await refreshFaceStatus();
    }
  } catch (error) {
    setAlert(el("punch-result"), error.message, "error");
  } finally {
    setBusy(button, false);
    paintFaceCard();
  }
});

el("face-warm").addEventListener("click", async (event) => {
  const button = event.currentTarget;
  setBusy(button, true);
  faceProgress("جارٍ تحميل محرّك التعرف على الوجه…");
  try {
    await warmUpFaceEngine();
    faceProgress("محرّك الوجه جاهز على جهازك.");
  } catch (error) {
    faceProgress(error.message);
  } finally {
    setBusy(button, false);
  }
});

el("my-tabs").addEventListener("click", async (event) => {
  const tab = event.target.closest(".tab");
  if (!tab) return;

  for (const node of el("my-tabs").querySelectorAll(".tab")) {
    node.classList.toggle("is-active", node === tab);
  }

  state.myResource = tab.dataset.resource;
  setAlert(el("my-result"), "");
  await renderMyForm();
});

el("my-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  const button = el("my-submit");
  setBusy(button, true);

  const payload = collectFormValues(el("my-fields"));
  const response = await api(`/forms/${state.myResource}`, { method: "POST", body: payload });

  setBusy(button, false);
  setAlert(
    el("my-result"),
    response.ok ? response.message : (response.error ?? "تعذّر إرسال الطلب"),
    response.ok ? "ok" : "error",
  );

  if (response.ok) await refreshMyForms();
});

el("extras-nav").addEventListener("click", async (event) => {
  const tab = event.target.closest("[data-panel]");
  if (!tab) return;
  await showPanel(tab.dataset.panel);
});

el("file-refresh").addEventListener("click", refreshMyFile);

el("set-branch").addEventListener("click", async () => {
  const button = el("set-branch");
  const result = el("punch-result");
  setBusy(button, true);

  try {
    const position = await requestPosition();
    const response = await api(`/branches/${state.branch.id}/location`, {
      method: "PATCH",
      body: {
        latitude: position.coords.latitude,
        longitude: position.coords.longitude,
      },
    });

    if (response.ok) {
      state.branch = response.branch;
      el("geo-radius").textContent = `${response.branch.radiusMeters} م`;
      setAlert(result, `تم تحديث موقع ${response.branch.name} إلى موقعك الحالي`, "ok");
    } else {
      setAlert(result, response.error ?? "تعذّر تحديث موقع الفرع", "error");
    }
  } catch (error) {
    setAlert(result, error.message, "error");
  } finally {
    setBusy(button, false);
  }
});

el("logout").addEventListener("click", async () => {
  stopIdleWatch();
  await api("/auth/logout", { method: "POST" });
  setToken(null);
  clearActivity();
  showLogin("");
});

/* ── الإقلاع ───────────────────────────────────────────────── */

setInterval(tickClock, 1000);

/**
 * إقلاع الشاشة: من عاد بعد انقضاء فترة الخمول (أو أُخرج من لوحة الإدارة)
 * يجد نفسه في شاشة الدخول برسالة واضحة بدل جلسة نصف صالحة.
 */
async function boot() {
  const reason = new URLSearchParams(window.location.search).get("session");

  if (reason === "idle") {
    setToken(null);
    clearActivity();
    showLogin(IDLE_MESSAGE);
    window.history.replaceState(null, "", "/app/");
    return;
  }

  // إعدادات التشغيل تُقرأ قبل التحقق من التوكن لأن شاشة الاستعادة تحتاج
  // معرفة ما إذا كان الموقع يستطيع إرسال الرمز بالبريد
  const config = await loadRuntimeConfig();
  if (config.ok) {
    state.idleSeconds = config.session?.idleSeconds ?? state.idleSeconds;
    state.resetByEmail = Boolean(config.passwordReset?.emailEnabled);
  }

  if (!getToken()) {
    showLogin();
    return;
  }

  if (idleExceeded(state.idleSeconds)) {
    // الجلسة على الخادم انتهت أيضاً بنفس المدة — نكتفي بتنظيف الجهاز
    setToken(null);
    clearActivity();
    showLogin(IDLE_MESSAGE);
    return;
  }

  await loadProfile();
}

boot();

/*
 * تسجيل عامل الخدمة. `updateViaCache: "none"` يمنع المتصفح من قراءة ملف
 * العامل نفسه من ذاكرته، و`update()` يفحص وجود نسخة أحدث عند كل إقلاع،
 * فيصل التحديث المنشور إلى الجهاز بدل بقاء الواجهة على نسخة قديمة.
 */
if ("serviceWorker" in navigator) {
  window.addEventListener("load", async () => {
    // هل كانت الصفحة تحت سيطرة عامل خدمة قديم قبل التسجيل؟
    const wasControlled = Boolean(navigator.serviceWorker.controller);
    let reloading = false;

    /*
     * عند سيطرة نسخة أحدث نُحدّث الصفحة مرة واحدة: الوحدات المُحمَّلة في
     * الصفحة الحالية تكون من النسخة القديمة، وخلطها مع ملفات النسخة الجديدة
     * يُنتج أخطاء يصعب تفسيرها على المستخدم.
     */
    navigator.serviceWorker.addEventListener("controllerchange", () => {
      if (!wasControlled || reloading) return;
      reloading = true;
      window.location.reload();
    });

    try {
      const registration = await navigator.serviceWorker.register("/app/sw.js", {
        updateViaCache: "none",
      });
      await registration.update();
    } catch {
      /* العمل دون اتصال ميزة إضافية — تجاهل الفشل بهدوء */
    }
  });
}
