/**
 * شاشة الرقابة والكاميرات: تنبيهات المدير العام ومدير المستودعات ومراقب
 * الكاميرات، توقيت الطلبات وأحداث الكاشير، الهدر، سجل الكاميرات، والتقرير
 * اليومي.
 *
 * الشاشة تقرأ بياناتها المرجعية (الفروع والموظفين والكاميرات) من مسار الوحدة
 * نفسها، فلا تحتاج صلاحية الموظفين أو الفروع. وكل قاعدة إلزامية (المراجعة
 * البشرية، الخصوصية، الثقة المنخفضة) مفروضة في الخادم لا هنا.
 */

import {
  api,
  button,
  el,
  formatDateTime,
  formatMoney,
  row,
  setAlert,
  setBusy,
  todayIso,
  toLocalInputValue,
} from "../api.js";

const state = {
  meta: null,
  access: { canWrite: false, canManage: false, canReview: false, canDelete: false },
  cameras: [],
  report: null,
  reviewId: null,
  editingCameraId: null,
  tab: "alerts",
  wired: false,
  /** أعلى رقم تنبيه فوري رآه المستخدم — لإشعار التنبيهات الجديدة */
  lastUrgentId: null,
  timer: null,
};

const STATUS_BADGE = {
  open: "badge--submitted",
  needs_review: "badge--warn",
  confirmed: "badge--disputed",
  dismissed: "badge--reviewed",
};
const CAMERA_BADGE = {
  online: "badge--ok",
  offline: "badge--disputed",
  covered: "badge--disputed",
  moved: "badge--warn",
  unknown: "badge--submitted",
};

function badge(text, kind) {
  const node = document.createElement("span");
  node.className = `badge ${kind ?? ""}`;
  node.textContent = text;
  return node;
}

function labels() {
  return state.meta?.labels ?? {};
}

function branchId() {
  return el("sv-branch").value;
}

function day() {
  return el("sv-date").value || todayIso();
}

function result(message, kind) {
  setAlert(el("sv-result"), message, kind);
}

/** القيمة المحلية من حقل datetime-local كلحظة ISO كاملة. */
function isoFrom(input) {
  const value = el(input).value;
  if (!value) return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

function fillSelect(select, options, { placeholder } = {}) {
  const node = el(select);
  if (!node) return;
  const current = node.value;
  node.textContent = "";
  if (placeholder !== undefined) {
    const option = document.createElement("option");
    option.value = "";
    option.textContent = placeholder;
    node.append(option);
  }
  for (const [value, text] of options) {
    const option = document.createElement("option");
    option.value = String(value);
    option.textContent = text;
    node.append(option);
  }
  if ([...node.options].some((o) => o.value === current)) node.value = current;
}

function employeeOptions() {
  return (state.meta?.employees ?? []).map((e) => [
    e.id,
    `${e.employeeCode} — ${e.fullName}${e.jobTitle ? ` (${e.jobTitle})` : ""}`,
  ]);
}

function cameraOptions() {
  return state.cameras.map((c) => [c.id, `${c.cameraNumber}${c.name ? ` — ${c.name}` : ""}`]);
}

function employeeName(id) {
  const e = (state.meta?.employees ?? []).find((item) => item.id === id);
  return e ? e.fullName : `#${id}`;
}

function minutesText(seconds) {
  if (seconds === null || seconds === undefined) return "—";
  return `${(seconds / 60).toFixed(1)} د`;
}

/* ── البيانات المرجعية ─────────────────────────────────────────── */

async function loadMeta() {
  const query = branchId() ? `?branchId=${branchId()}` : "";
  const meta = await api(`/surveillance/meta${query}`);
  if (!meta.ok) {
    result(meta.error ?? "تعذّر تحميل بيانات الرقابة", "error");
    return false;
  }
  state.meta = meta;
  state.access = meta.access;

  fillSelect("sv-branch", meta.branches.map((b) => [b.id, b.name]));
  if (meta.branchId) el("sv-branch").value = String(meta.branchId);

  const people = employeeOptions();
  fillSelect("sv-alert-employees", people);
  fillSelect("sv-order-employee", people, { placeholder: "—" });
  fillSelect("sv-pos-employee", people, { placeholder: "—" });
  fillSelect("sv-waste-employee", people, { placeholder: "—" });
  fillSelect("sv-camera-zone", Object.entries(labels().zones ?? {}));
  fillSelect("sv-waste-reason", Object.entries(labels().wasteReasons ?? {}));
  fillAlertTypes();

  const items = el("sv-items-list");
  items.textContent = "";
  for (const target of meta.prepTargets) {
    const option = document.createElement("option");
    option.value = target.itemName;
    items.append(option);
  }

  if (meta.settings) {
    el("sv-set-prep").value = meta.settings.defaultPrepMinutes;
    el("sv-set-wait").value = meta.settings.customerWaitMinutes;
    el("sv-set-pos").value = meta.settings.repeatPosThreshold;
    el("sv-set-open").value = meta.settings.openTime;
    el("sv-set-close").value = meta.settings.closeTime;
    el("sv-set-emails").value = meta.settings.alertEmails;
  }
  renderConnect();
  el("sv-webhook-note").textContent = meta.webhookEnabled
    ? "نقطة الاستقبال الآلية مفعّلة: يرسل نظام الكاميرات أو نقطة البيع أحداثه إلى /api/surveillance/webhook بالمفتاح السرّي."
    : "نقطة الاستقبال الآلية غير مفعّلة. لتفعيلها اضبط متغيّر البيئة SURVEILLANCE_WEBHOOK_SECRET في إعدادات Netlify.";

  applyAccess();
  renderTargets();
  return true;
}

function fillAlertTypes() {
  const role = el("sv-alert-role").value;
  const types = (state.meta?.alertTypes ?? []).filter((t) => t.role === role || t.key === "other");
  fillSelect(
    "sv-alert-type",
    types.map((t) => [t.key, `${t.urgent ? "⚠ " : ""}${t.label}`]),
  );
}

function applyAccess() {
  for (const node of document.querySelectorAll("#panel-surveillance [data-sv-write]")) {
    node.hidden = !state.access.canWrite;
  }
  for (const node of document.querySelectorAll("#panel-surveillance [data-sv-manage]")) {
    node.hidden = !state.access.canManage;
  }
}

async function loadCameras() {
  const res = await api(`/surveillance/cameras?branchId=${branchId()}`);
  state.cameras = res.ok ? res.cameras : [];
  const options = cameraOptions();
  for (const id of ["sv-alert-camera", "sv-order-camera", "sv-pos-camera", "sv-waste-camera"]) {
    fillSelect(id, options, { placeholder: "—" });
  }
}

/* ── الملخّص ───────────────────────────────────────────────────── */

async function renderSummary() {
  const res = await api(`/surveillance/alerts?branchId=${branchId()}&from=${day()}&to=${day()}`);
  const alerts = res.ok ? res.alerts : [];
  const summary = el("sv-summary");
  summary.textContent = "";
  const urgent = alerts.filter((a) => a.isUrgent).length;
  const review = alerts.filter((a) => a.status === "needs_review").length;
  const down = state.cameras.filter(
    (c) => c.isActive && c.status !== "unknown" && (c.status !== "online" || !c.isRecording),
  ).length;
  summary.append(
    badge(`تنبيهات اليوم: ${alerts.length}`, "badge--submitted"),
    badge(`فورية: ${urgent}`, urgent ? "badge--disputed" : "badge--ok"),
    badge(`تحتاج مراجعة: ${review}`, review ? "badge--warn" : "badge--ok"),
    badge(`كاميرات معطّلة: ${down}`, down ? "badge--disputed" : "badge--ok"),
  );
}

/* ── التنبيهات ─────────────────────────────────────────────────── */

async function refreshAlerts() {
  const params = new URLSearchParams({
    branchId: branchId(),
    from: el("sv-alerts-from").value || day(),
    to: el("sv-alerts-to").value || el("sv-alerts-from").value || day(),
  });
  if (el("sv-alerts-status").value) params.set("status", el("sv-alerts-status").value);
  if (el("sv-alerts-role").value) params.set("role", el("sv-alerts-role").value);
  if (el("sv-alerts-urgent").value) params.set("urgent", "1");

  const res = await api(`/surveillance/alerts?${params}`);
  const body = el("sv-alerts-table").querySelector("tbody");
  body.textContent = "";
  if (!res.ok) {
    result(res.error, "error");
    return;
  }
  const L = labels();
  const types = new Map((state.meta?.alertTypes ?? []).map((t) => [t.key, t]));
  for (const alert of res.alerts) {
    const spec = types.get(alert.alertType);
    const typeCell = document.createElement("div");
    typeCell.append(
      document.createTextNode(spec?.label ?? alert.alertType),
      document.createElement("br"),
      badge(L.roles?.[alert.role] ?? alert.role, "badge--submitted"),
    );
    if (alert.isUrgent) typeCell.append(" ", badge("فوري", "badge--disputed"));
    if (alert.isSuspicion) typeCell.append(" ", badge("اشتباه يحتاج مراجعة", "badge--warn"));
    if (alert.source === "auto") typeCell.append(" ", badge("كشف آلي", "badge--ok"));

    const people = [...(alert.employeeIds ?? []).map(employeeName), alert.peopleNote]
      .filter(Boolean)
      .join("، ");

    const statusCell = document.createElement("div");
    statusCell.append(badge(L.statuses?.[alert.status] ?? alert.status, STATUS_BADGE[alert.status]));
    if (alert.reviewNote) {
      const note = document.createElement("small");
      note.className = "hint";
      note.textContent = ` ${alert.reviewerName ?? ""}: ${alert.reviewNote}`;
      statusCell.append(document.createElement("br"), note);
    }

    const actions = document.createElement("div");
    actions.className = "row row--wrap";
    if (alert.source === "auto" && alert.clipRef.includes("لقطة #")) {
      actions.append(
        button("اللقطة", {
          onClick: () => showFrame(`/surveillance/alerts/${alert.id}/frame`, spec?.label ?? alert.alertType),
        }),
      );
    }
    if (state.access.canReview) {
      actions.append(button("مراجعة", { onClick: () => openReview(alert, spec) }));
    }
    if (state.access.canDelete) {
      actions.append(
        button("حذف", {
          onClick: () => removeRecord("alerts", alert.id, refreshAll),
        }),
      );
    }

    body.append(
      row([
        formatDateTime(alert.occurredAt),
        typeCell,
        [alert.cameraNumber, alert.location].filter(Boolean).join(" — ") || "—",
        people || "غير محدد",
        L.confidence?.[alert.confidence] ?? alert.confidence,
        alert.clipRef || "—",
        alert.suggestedAction || "—",
        statusCell,
        actions,
      ]),
    );
  }
  el("sv-alerts-empty").hidden = res.alerts.length > 0;
}

function openReview(alert, spec) {
  state.reviewId = alert.id;
  el("sv-review-title").textContent = `مراجعة: ${spec?.label ?? alert.alertType} — ${formatDateTime(alert.occurredAt)}${alert.clipRef ? ` — المقطع: ${alert.clipRef}` : ""}`;
  el("sv-review-note").value = alert.reviewNote ?? "";
  el("sv-review-decision").value = alert.status === "dismissed" ? "dismissed" : "confirmed";
  el("sv-review-form").hidden = false;
  el("sv-review-note").focus();
}

async function submitReview(event) {
  event.preventDefault();
  if (!state.reviewId) return;
  const submit = el("sv-review-submit");
  setBusy(submit, true);
  const res = await api(`/surveillance/alerts/${state.reviewId}/review`, {
    method: "POST",
    body: { decision: el("sv-review-decision").value, note: el("sv-review-note").value },
  });
  setBusy(submit, false);
  if (!res.ok) {
    result(res.error, "error");
    return;
  }
  state.reviewId = null;
  el("sv-review-form").hidden = true;
  result("حُفظت نتيجة المراجعة.", "ok");
  await refreshAll();
}

async function submitAlert(event) {
  event.preventDefault();
  const submit = el("sv-alert-submit");
  setBusy(submit, true);
  const employeeIds = [...el("sv-alert-employees").selectedOptions].map((o) => Number(o.value));
  const res = await api("/surveillance/alerts", {
    method: "POST",
    body: {
      branchId: branchId(),
      role: el("sv-alert-role").value,
      alertType: el("sv-alert-type").value,
      occurredAt: isoFrom("sv-alert-time"),
      cameraId: el("sv-alert-camera").value || null,
      location: el("sv-alert-location").value,
      confidence: el("sv-alert-confidence").value,
      employeeIds,
      peopleNote: el("sv-alert-people").value,
      clipRef: el("sv-alert-clip").value,
      details: el("sv-alert-details").value,
      suggestedAction: el("sv-alert-action").value,
    },
  });
  setBusy(submit, false);
  if (!res.ok) {
    result(res.error, "error");
    return;
  }
  for (const id of ["sv-alert-location", "sv-alert-people", "sv-alert-clip", "sv-alert-details", "sv-alert-action"]) {
    el(id).value = "";
  }
  el("sv-alert-employees").selectedIndex = -1;
  el("sv-alert-time").value = toLocalInputValue();
  result(
    el("sv-alert-confidence").value === "low"
      ? "سُجّلت الحالة وأُحيلت لمراجعة بشرية لأن الثقة منخفضة."
      : "سُجّلت الحالة.",
    "ok",
  );
  await renderSummary();
}

/* ── الطلبات وأحداث الكاشير ───────────────────────────────────── */

async function refreshOrders() {
  const [orders, pos] = await Promise.all([
    api(`/surveillance/orders?branchId=${branchId()}&date=${day()}`),
    api(`/surveillance/pos-events?branchId=${branchId()}&date=${day()}`),
  ]);
  const L = labels();

  const ordersBody = el("sv-orders-table").querySelector("tbody");
  ordersBody.textContent = "";
  for (const order of orders.ok ? orders.orders : []) {
    ordersBody.append(
      row([
        order.orderRef,
        order.itemName || "—",
        L.channels?.[order.channel] ?? order.channel,
        formatDateTime(order.registeredAt),
        formatDateTime(order.deliveredAt),
        minutesText(order.prepSeconds),
        order.hasInvoice ? "نعم" : badge("بدون فاتورة", "badge--disputed"),
        order.preparedBy ?? "—",
        state.access.canDelete
          ? button("حذف", { onClick: () => removeRecord("orders", order.id, refreshOrders) })
          : "",
      ]),
    );
  }
  el("sv-orders-empty").hidden = (orders.orders ?? []).length > 0;

  const posBody = el("sv-pos-table").querySelector("tbody");
  posBody.textContent = "";
  for (const event of pos.ok ? pos.events : []) {
    posBody.append(
      row([
        formatDateTime(event.occurredAt),
        L.posEvents?.[event.eventType] ?? event.eventType,
        event.cashier || "—",
        formatMoney(event.amount),
        event.orderRef || "—",
        event.notes || "—",
        state.access.canDelete
          ? button("حذف", { onClick: () => removeRecord("pos-events", event.id, refreshOrders) })
          : "",
      ]),
    );
  }
  el("sv-pos-empty").hidden = (pos.events ?? []).length > 0;
}

function alertsNote(res, base) {
  const count = res.alerts?.length ?? 0;
  return count ? `${base} — وأُنشئ ${count} تنبيه تلقائياً.` : base;
}

async function submitOrder(event) {
  event.preventDefault();
  const submit = el("sv-order-submit");
  setBusy(submit, true);
  const res = await api("/surveillance/orders", {
    method: "POST",
    body: {
      branchId: branchId(),
      orderRef: el("sv-order-ref").value,
      itemName: el("sv-order-item").value,
      channel: el("sv-order-channel").value,
      registeredAt: isoFrom("sv-order-registered"),
      deliveredAt: isoFrom("sv-order-delivered"),
      preparedByEmployeeId: el("sv-order-employee").value || null,
      cameraId: el("sv-order-camera").value || null,
      hasInvoice: el("sv-order-invoice").value === "true",
    },
  });
  setBusy(submit, false);
  if (!res.ok) {
    result(res.error, "error");
    return;
  }
  el("sv-order-ref").value = "";
  el("sv-order-delivered").value = "";
  result(alertsNote(res, "سُجّل الطلب."), "ok");
  await Promise.all([refreshOrders(), renderSummary()]);
}

async function submitPos(event) {
  event.preventDefault();
  const submit = el("sv-pos-submit");
  setBusy(submit, true);
  const res = await api("/surveillance/pos-events", {
    method: "POST",
    body: {
      branchId: branchId(),
      eventType: el("sv-pos-type").value,
      occurredAt: isoFrom("sv-pos-time"),
      cashierEmployeeId: el("sv-pos-employee").value || null,
      amount: el("sv-pos-amount").value,
      orderRef: el("sv-pos-order").value,
      cameraId: el("sv-pos-camera").value || null,
      notes: el("sv-pos-notes").value,
    },
  });
  setBusy(submit, false);
  if (!res.ok) {
    result(res.error, "error");
    return;
  }
  el("sv-pos-amount").value = "";
  el("sv-pos-order").value = "";
  el("sv-pos-notes").value = "";
  result(alertsNote(res, "سُجّل الحدث."), "ok");
  await Promise.all([refreshOrders(), renderSummary()]);
}

/* ── الهدر ─────────────────────────────────────────────────────── */

async function refreshWaste() {
  const res = await api(`/surveillance/waste?branchId=${branchId()}&date=${day()}`);
  const L = labels();
  const body = el("sv-waste-table").querySelector("tbody");
  body.textContent = "";
  for (const item of res.ok ? res.waste : []) {
    body.append(
      row([
        formatDateTime(item.occurredAt),
        item.itemName,
        `${item.quantity} ${item.unit}`,
        L.wasteReasons?.[item.reason] ?? item.reason,
        item.station || "—",
        item.employee ?? "—",
        item.notes || "—",
        state.access.canDelete
          ? button("حذف", { onClick: () => removeRecord("waste", item.id, refreshWaste) })
          : "",
      ]),
    );
  }
  el("sv-waste-empty").hidden = (res.waste ?? []).length > 0;
}

async function submitWaste(event) {
  event.preventDefault();
  const submit = el("sv-waste-submit");
  setBusy(submit, true);
  const res = await api("/surveillance/waste", {
    method: "POST",
    body: {
      branchId: branchId(),
      itemName: el("sv-waste-item").value,
      quantity: el("sv-waste-qty").value,
      unit: el("sv-waste-unit").value,
      reason: el("sv-waste-reason").value,
      station: el("sv-waste-station").value,
      occurredAt: isoFrom("sv-waste-time"),
      employeeId: el("sv-waste-employee").value || null,
      cameraId: el("sv-waste-camera").value || null,
      notes: el("sv-waste-notes").value,
    },
  });
  setBusy(submit, false);
  if (!res.ok) {
    result(res.error, "error");
    return;
  }
  for (const id of ["sv-waste-item", "sv-waste-qty", "sv-waste-notes"]) el(id).value = "";
  result("سُجّل الهدر.", "ok");
  await refreshWaste();
}

/* ── الكاميرات ─────────────────────────────────────────────────── */

function renderCameras() {
  const L = labels();
  const body = el("sv-cameras-table").querySelector("tbody");
  body.textContent = "";
  for (const camera of state.cameras) {
    const status = document.createElement("div");
    status.append(badge(L.cameraStatuses?.[camera.status] ?? camera.status, CAMERA_BADGE[camera.status]));
    if (!camera.isRecording) status.append(" ", badge("لا يسجّل", "badge--disputed"));
    if (!camera.isActive) status.append(" ", badge("موقوفة من السجل", "badge--submitted"));

    const checks = document.createElement("div");
    checks.className = "row row--wrap";
    if (state.access.canWrite) {
      for (const [value, text] of [
        ["online", "تعمل"],
        ["offline", "متوقفة"],
        ["covered", "مغطاة"],
        ["moved", "محرّكة"],
      ]) {
        checks.append(button(text, { onClick: (node) => checkCamera(camera, value, node) }));
      }
    }

    const detection = document.createElement("div");
    if (camera.autoDetect) {
      detection.append(
        badge(camera.connectionMode === "pull" ? "مفعّل — رابط عام" : "مفعّل — جهاز الربط", "badge--ok"),
        document.createElement("br"),
        document.createTextNode(`كل ${camera.intervalMinutes} د · آخر تحليل: ${formatDateTime(camera.lastAnalysisAt)}`),
      );
      if (camera.lastError) {
        const err = document.createElement("small");
        err.className = "hint";
        err.textContent = camera.lastError;
        detection.append(document.createElement("br"), err);
      }
    } else {
      detection.append(badge("متوقف", "badge--submitted"));
      if (camera.lastError) {
        const err = document.createElement("small");
        err.className = "hint";
        err.textContent = ` ${camera.lastError}`;
        detection.append(err);
      }
    }
    if (camera.snapshotUrl) {
      const tools = document.createElement("div");
      tools.className = "row row--wrap";
      if (state.access.canManage) {
        tools.append(
          button("فحص الآن", { onClick: (node) => testCamera(camera, node) }),
          button("اعتماد الزاوية", { onClick: (node) => setReference(camera, node) }),
        );
      }
      tools.append(button("آخر اللقطات", { onClick: () => showFrames(camera) }));
      detection.append(tools);
    }

    const actions = document.createElement("div");
    actions.className = "row row--wrap";
    if (state.access.canManage) actions.append(button("تعديل", { onClick: () => editCamera(camera) }));
    if (state.access.canDelete) {
      actions.append(
        button("حذف", {
          onClick: async () => {
            if (!confirm(`حذف الكاميرا ${camera.cameraNumber}؟ تبقى التنبيهات المرتبطة بها محفوظة.`)) return;
            const res = await api(`/surveillance/cameras/${camera.id}`, { method: "DELETE" });
            result(res.ok ? "حُذفت الكاميرا." : res.error, res.ok ? "ok" : "error");
            await refreshCamerasTab();
          },
        }),
      );
    }

    body.append(
      row([
        camera.cameraNumber,
        camera.name || "—",
        [L.zones?.[camera.zone] ?? camera.zone, camera.location].filter(Boolean).join(" — "),
        status,
        formatDateTime(camera.lastCheckedAt),
        camera.blindSpots || "—",
        detection,
        checks,
        actions,
      ]),
    );
  }
  el("sv-cameras-empty").hidden = state.cameras.length > 0;
}

async function refreshCamerasTab() {
  await loadCameras();
  renderCameras();
  await renderSummary();
}

async function checkCamera(camera, status, node) {
  let note = "";
  if (status !== "online") {
    note = prompt(`ملاحظة عن الكاميرا ${camera.cameraNumber} (اختياري):`) ?? "";
  }
  setBusy(node, true);
  const res = await api(`/surveillance/cameras/${camera.id}/checks`, {
    method: "POST",
    body: { status, isRecording: status === "online", note },
  });
  setBusy(node, false);
  if (!res.ok) {
    result(res.error, "error");
    return;
  }
  result(res.alertId ? "سُجّل الفحص وأُنشئ تنبيه فوري." : "سُجّل الفحص.", res.alertId ? "warn" : "ok");
  await refreshCamerasTab();
}

function editCamera(camera) {
  state.editingCameraId = camera.id;
  el("sv-camera-number").value = camera.cameraNumber;
  el("sv-camera-name").value = camera.name;
  el("sv-camera-zone").value = camera.zone;
  el("sv-camera-location").value = camera.location;
  el("sv-camera-blind").value = camera.blindSpots;
  el("sv-camera-notes").value = camera.notes;
  el("sv-camera-auto").value = String(camera.autoDetect);
  el("sv-camera-mode").value = camera.connectionMode;
  el("sv-camera-brand").value = "custom";
  el("sv-camera-url").value = camera.snapshotUrl;
  el("sv-camera-user").value = camera.snapshotUsername;
  el("sv-camera-pass").value = "";
  el("sv-camera-pass").placeholder = camera.hasPassword ? "محفوظة — اتركها فارغة للإبقاء" : "تُحفظ مشفّرة";
  el("sv-camera-interval").value = camera.intervalMinutes;
  el("sv-camera-submit").textContent = "حفظ التعديل";
  el("sv-camera-cancel").hidden = false;
  el("sv-camera-number").focus();
}

function resetCameraForm() {
  state.editingCameraId = null;
  el("sv-camera-form").reset();
  el("sv-camera-pass").placeholder = "تُحفظ مشفّرة";
  el("sv-camera-submit").textContent = "إضافة كاميرا";
  el("sv-camera-cancel").hidden = true;
}

async function submitCamera(event) {
  event.preventDefault();
  const submit = el("sv-camera-submit");
  setBusy(submit, true);
  const body = {
    branchId: branchId(),
    cameraNumber: el("sv-camera-number").value,
    name: el("sv-camera-name").value,
    zone: el("sv-camera-zone").value,
    location: el("sv-camera-location").value,
    blindSpots: el("sv-camera-blind").value,
    notes: el("sv-camera-notes").value,
    autoDetect: el("sv-camera-auto").value === "true",
    connectionMode: el("sv-camera-mode").value,
    snapshotUrl: el("sv-camera-url").value,
    snapshotUsername: el("sv-camera-user").value,
    snapshotPassword: el("sv-camera-pass").value,
    intervalMinutes: el("sv-camera-interval").value,
  };
  const res = state.editingCameraId
    ? await api(`/surveillance/cameras/${state.editingCameraId}`, { method: "PATCH", body })
    : await api("/surveillance/cameras", { method: "POST", body });
  setBusy(submit, false);
  if (!res.ok) {
    result(res.error, "error");
    return;
  }
  result(state.editingCameraId ? "حُفظ تعديل الكاميرا." : "أُضيفت الكاميرا.", "ok");
  resetCameraForm();
  await refreshCamerasTab();
}

/** يبني رابط اللقطة من نوع الجهاز وعنوانه ورقم القناة. */
function buildSnapshotUrl() {
  const ip = el("sv-camera-ip").value.trim();
  const channel = Math.max(1, Number(el("sv-camera-channel").value) || 1);
  const brand = el("sv-camera-brand").value;
  if (!ip || brand === "custom") return;
  const host = /^https?:\/\//i.test(ip) ? ip.replace(/\/$/, "") : `http://${ip}`;
  el("sv-camera-url").value =
    brand === "hikvision"
      ? `${host}/ISAPI/Streaming/channels/${channel}01/picture`
      : `${host}/cgi-bin/snapshot.cgi?channel=${channel}`;
}

async function testCamera(camera, node) {
  setBusy(node, true);
  const res = await api(`/surveillance/cameras/${camera.id}/test`, { method: "POST" });
  setBusy(node, false);
  if (!res.ok) {
    result(res.error, "error");
    return;
  }
  if (res.queued) {
    result(res.message, "ok");
    return;
  }
  const r = res.result;
  const stateText = { ok: "سليمة", covered: "مغطاة", dark: "سوداء", blurry: "غير واضحة", moved: "محرّكة", unreachable: "لا تستجيب", error: "فشل التحليل", private_area: "مكان خاص — أُوقف الكشف" };
  result(
    `${camera.cameraNumber}: ${stateText[r.cameraState] ?? r.cameraState}${r.error ? ` — ${r.error}` : ""} · ملاحظات: ${r.findings} · تنبيهات جديدة: ${r.alerts.length}${r.summary ? ` — ${r.summary}` : ""}`,
    r.alerts.length || r.error ? "warn" : "ok",
  );
  if (r.frameId) await showFrame(`/surveillance/frames/${r.frameId}/image`, `فحص ${camera.cameraNumber}`);
  await refreshCamerasTab();
}

async function setReference(camera, node) {
  if (!confirm(`اعتماد آخر لقطة محفوظة للكاميرا ${camera.cameraNumber} زاويةً مرجعية؟`)) return;
  setBusy(node, true);
  const res = await api(`/surveillance/cameras/${camera.id}/reference`, { method: "POST" });
  setBusy(node, false);
  result(res.ok ? "اعتُمدت الزاوية المرجعية." : res.error, res.ok ? "ok" : "error");
}

function describeAnalysis(frame) {
  const a = frame.analysis;
  const parts = [`${formatDateTime(frame.capturedAt)} — حالة الكاميرا: ${frame.cameraState}`];
  if (frame.error) parts.push(frame.error);
  if (a?.summary) parts.push(a.summary);
  if (a?.cameraNote) parts.push(a.cameraNote);
  for (const f of a?.findings ?? []) {
    parts.push(`• ${f.description}${f.people ? ` (${f.people})` : ""} — ثقة ${labels().confidence?.[f.confidence] ?? f.confidence}`);
  }
  return parts.join("\n");
}

async function showFrame(path, title) {
  const res = await api(path);
  if (!res.ok) {
    result(res.error, "error");
    return;
  }
  el("sv-frame-title").textContent = title;
  el("sv-frame-img").hidden = !res.image;
  if (res.image) el("sv-frame-img").src = res.image;
  el("sv-frame-text").textContent = res.image
    ? describeAnalysis(res.frame)
    : `${describeAnalysis(res.frame)}\n(لم تُحفظ صورة لهذه اللقطة)`;
  el("sv-frame-text").style.whiteSpace = "pre-line";
  el("sv-frame-viewer").hidden = false;
  el("sv-frame-viewer").scrollIntoView({ behavior: "smooth", block: "start" });
}

async function showFrames(camera) {
  const res = await api(`/surveillance/frames?cameraId=${camera.id}&limit=20`);
  if (!res.ok) {
    result(res.error, "error");
    return;
  }
  el("sv-frame-title").textContent = `آخر لقطات ${camera.cameraNumber}`;
  el("sv-frame-img").hidden = true;
  const text = el("sv-frame-text");
  text.textContent = "";
  text.style.whiteSpace = "pre-line";
  if (!res.frames.length) text.textContent = "لا توجد لقطات بعد.";
  for (const frame of res.frames) {
    const line = document.createElement("div");
    line.textContent = describeAnalysis(frame);
    if (frame.hasImage) {
      line.append(" ", button("عرض", { onClick: () => showFrame(`/surveillance/frames/${frame.id}/image`, `${camera.cameraNumber}`) }));
    }
    line.style.marginBottom = "8px";
    text.append(line);
  }
  el("sv-frame-viewer").hidden = false;
  el("sv-frame-viewer").scrollIntoView({ behavior: "smooth", block: "start" });
}

function renderConnect() {
  const meta = state.meta;
  if (!meta) return;
  el("sv-connect-url").textContent = meta.siteUrl || location.origin;
  const box = el("sv-connect-status");
  box.textContent = "";
  const auto = state.cameras.filter((c) => c.autoDetect);
  const live = auto.filter((c) => c.lastAnalysisAt && Date.now() - new Date(c.lastAnalysisAt).getTime() < 30 * 60_000);
  box.append(
    badge(meta.webhookEnabled ? "المفتاح السري مضبوط" : "المفتاح السري غير مضبوط بعد", meta.webhookEnabled ? "badge--ok" : "badge--disputed"),
    badge(`كاميرات بالكشف الآلي: ${auto.length}`, auto.length ? "badge--ok" : "badge--warn"),
    badge(`تصل لقطاتها الآن: ${live.length}`, live.length ? "badge--ok" : "badge--warn"),
    badge(`نموذج التحليل: ${meta.visionModel}`, "badge--submitted"),
  );
}

/* ── التحديث التلقائي والإشعار ─────────────────────────────────── */

async function pollUrgent() {
  if (el("panel-surveillance").hidden || document.hidden) return;
  const res = await api(`/surveillance/alerts?branchId=${branchId()}&from=${todayIso()}&to=${todayIso()}&urgent=1`);
  if (!res.ok) return;
  const newest = res.alerts.reduce((max, a) => Math.max(max, a.id), 0);
  if (state.lastUrgentId !== null && newest > state.lastUrgentId) {
    const fresh = res.alerts.filter((a) => a.id > state.lastUrgentId);
    const types = new Map((state.meta?.alertTypes ?? []).map((t) => [t.key, t.label]));
    const text = fresh.map((a) => `${types.get(a.alertType) ?? a.alertType}${a.cameraNumber ? ` — ${a.cameraNumber}` : ""}`).join("\n");
    result(`تنبيه فوري جديد:\n${text}`, "warn");
    if ("Notification" in window && Notification.permission === "granted") {
      new Notification("تنبيه فوري — الرقابة والكاميرات", { body: text, icon: "/app/icon.svg" });
    }
    await loadCameras();
    await Promise.all([renderSummary(), showTab(state.tab)]);
  }
  state.lastUrgentId = Math.max(state.lastUrgentId ?? 0, newest);
}

function startPolling() {
  if (state.timer) return;
  state.timer = setInterval(() => pollUrgent().catch(() => undefined), 60_000);
  el("sv-live-note").textContent = "الشاشة تتحدّث تلقائياً كل دقيقة وتُشعرك بأي تنبيه فوري جديد.";
  if ("Notification" in window && Notification.permission === "default") {
    const ask = button("تفعيل إشعارات المتصفح", {
      onClick: async (node) => {
        await Notification.requestPermission();
        node.remove();
      },
    });
    el("sv-live-note").append(" ", ask);
  }
}

/* ── الحدود المعتمدة ───────────────────────────────────────────── */

function renderTargets() {
  const body = el("sv-targets-table").querySelector("tbody");
  body.textContent = "";
  const targets = state.meta?.prepTargets ?? [];
  for (const target of targets) {
    body.append(
      row([
        target.itemName,
        target.maxMinutes,
        state.access.canManage
          ? button("حذف", {
              onClick: async () => {
                await api(`/surveillance/prep-targets/${target.id}`, { method: "DELETE" });
                await loadMeta();
              },
            })
          : "",
      ]),
    );
  }
  el("sv-targets-empty").hidden = targets.length > 0;
}

async function submitSettings(event) {
  event.preventDefault();
  const res = await api("/surveillance/settings", {
    method: "PUT",
    body: {
      branchId: branchId(),
      defaultPrepMinutes: el("sv-set-prep").value,
      customerWaitMinutes: el("sv-set-wait").value,
      repeatPosThreshold: el("sv-set-pos").value,
      openTime: el("sv-set-open").value,
      closeTime: el("sv-set-close").value,
      alertEmails: el("sv-set-emails").value,
    },
  });
  result(res.ok ? "حُفظت الحدود." : res.error, res.ok ? "ok" : "error");
}

async function submitTarget(event) {
  event.preventDefault();
  const res = await api("/surveillance/prep-targets", {
    method: "PUT",
    body: { itemName: el("sv-target-item").value, maxMinutes: el("sv-target-minutes").value },
  });
  if (!res.ok) {
    result(res.error, "error");
    return;
  }
  el("sv-target-form").reset();
  result("حُفظ حد الصنف.", "ok");
  await loadMeta();
}

/* ── التقرير اليومي ────────────────────────────────────────────── */

function section(title) {
  const wrap = document.createElement("section");
  wrap.className = "sv-report__section";
  const heading = document.createElement("h3");
  heading.className = "card__title card__title--sm";
  heading.textContent = title;
  wrap.append(heading);
  return wrap;
}

function paragraph(text) {
  const p = document.createElement("p");
  p.textContent = text;
  return p;
}

function table(headers, rows, emptyText) {
  if (!rows.length) return paragraph(emptyText);
  const wrap = document.createElement("div");
  wrap.className = "table-wrap";
  const node = document.createElement("table");
  node.className = "table";
  const head = document.createElement("thead");
  const headRow = document.createElement("tr");
  for (const h of headers) {
    const th = document.createElement("th");
    th.textContent = h;
    headRow.append(th);
  }
  head.append(headRow);
  const body = document.createElement("tbody");
  for (const values of rows) body.append(row(values));
  node.append(head, body);
  wrap.append(node);
  return wrap;
}

function renderReport(report) {
  state.report = report;
  const root = el("sv-report");
  root.textContent = "";
  if (!report) return;

  const header = document.createElement("div");
  header.append(
    paragraph(`التقرير اليومي — ${report.branch.name} — ${report.date}`),
    paragraph(
      `التنبيهات: ${report.counts.alerts} · الفورية: ${report.counts.urgent} · تحتاج مراجعة: ${report.counts.needsReview}`,
    ),
  );
  root.append(header);

  const s1 = section("١. المبيعات مقابل الطلبات المرصودة");
  s1.append(
    paragraph(
      `مبيعات التقفيل: ${formatMoney(report.sales.posSales)} (${report.sales.closings} تقفيل) · طلبات مرصودة: ${report.sales.observedOrders} (${report.sales.observedItems} صنف) · بدون فاتورة: ${report.sales.ordersWithoutInvoice} · حركات إخراج من المستودع: ${report.sales.warehouseOutMovements}`,
    ),
  );
  if (report.sales.discrepancies.length) {
    const list = document.createElement("ul");
    for (const d of report.sales.discrepancies) {
      const li = document.createElement("li");
      li.textContent = d;
      list.append(li);
    }
    s1.append(list);
  } else {
    s1.append(paragraph("لا توجد فروقات مرصودة."));
  }

  const s2 = section("٢. أوقات التجهيز");
  const p = report.prep;
  s2.append(
    paragraph(
      p.overall.count
        ? `المتوسط: ${p.overall.avgMinutes} د · الأطول: ${p.overall.maxMinutes} د${p.slowest ? ` (الطلب ${p.slowest.orderRef} — ${p.slowest.item} — ${p.slowest.time})` : ""} · عدد الأصناف: ${p.overall.count}`
        : "لا توجد طلبات مكتملة التوقيت.",
    ),
    table(
      ["الفترة", "العدد", "المتوسط (د)", "الأطول (د)"],
      p.byPeriod.map((r) => [r.label, r.count, r.avgMinutes, r.maxMinutes]),
      "",
    ),
    table(
      ["الصنف", "العدد", "المتوسط (د)", "الأطول (د)", "الحد (د)", "تجاوزات"],
      p.byItem.map((r) => [r.item, r.count, r.avgMinutes, r.maxMinutes, r.targetMinutes, r.overCount]),
      "",
    ),
  );

  const s3 = section("٣. الهدر المرصود");
  s3.append(
    table(
      ["الصنف", "الكمية", "السبب", "المحطة", "المصدر"],
      report.waste.map((w) => [w.item, `${w.quantity} ${w.unit}`, w.reason, w.station, w.source]),
      "لا يوجد هدر مرصود.",
    ),
  );

  const alertRows = (rows) =>
    rows.map((a) => [a.severity, a.type, a.time, `${a.camera} — ${a.location}`, a.employees, a.confidence, a.clipRef, a.status]);
  const alertHeaders = ["الخطورة", "الحالة", "الوقت", "الكاميرا والموقع", "الموظفون", "الثقة", "المقطع", "المراجعة"];

  const s4 = section("٤. حالات الاشتباه (مرتبة حسب الخطورة)");
  s4.append(table(alertHeaders, alertRows(report.suspicions), "لا توجد حالات اشتباه."));

  const s5 = section("٥. مشاكل العملاء");
  s5.append(table(alertHeaders, alertRows(report.customerIssues), "لا توجد مشاكل عملاء مرصودة."));

  const s6 = section("٦. أداء الموظفين");
  s6.append(
    table(
      ["الموظف", "المسمى", "الحضور", "الانصراف", "الالتزام", "الإنتاجية", "الملاحظات"],
      report.staff.map((m) => [m.name, m.jobTitle, m.checkIn, m.checkOut, m.commitment, m.productivity, m.notes]),
      "لا توجد بيانات موظفين لهذا اليوم.",
    ),
  );

  const s7 = section("٧. حالة الكاميرات");
  s7.append(
    table(
      ["الرقم", "الاسم", "المنطقة", "الحالة", "تسجّل", "فُحصت اليوم", "مشاكل اليوم", "النقاط العمياء"],
      report.cameras.map((c) => [c.number, c.name, c.zone, c.status, c.recording, c.checkedToday, c.issuesToday, c.blindSpots]),
      "لا توجد كاميرات مسجّلة.",
    ),
  );

  const s8 = section("٨. ثلاث توصيات لليوم التالي");
  const list = document.createElement("ol");
  for (const r of report.recommendations) {
    const li = document.createElement("li");
    li.textContent = r;
    list.append(li);
  }
  s8.append(list);

  const note = paragraph(report.disclaimer);
  note.className = "hint";
  root.append(s1, s2, s3, s4, s5, s6, s7, s8, note);
}

async function loadReport({ live = false } = {}) {
  const res = await api(
    `/surveillance/daily-report?branchId=${branchId()}&date=${day()}${live ? "&live=1" : ""}`,
  );
  if (!res.ok) {
    result(res.error, "error");
    return;
  }
  el("sv-report-meta").textContent = res.saved
    ? `تقرير محفوظ — صدر في ${formatDateTime(res.savedAt)}`
    : res.hasSaved
      ? "معاينة حيّة (يوجد تقرير محفوظ لهذا اليوم — اضغط «إصدار» لاستبداله)"
      : "معاينة حيّة غير محفوظة";
  renderReport(res.report);
}

async function generateReport() {
  const submit = el("sv-report-generate");
  setBusy(submit, true);
  const res = await api("/surveillance/daily-report", {
    method: "POST",
    body: { branchId: branchId(), date: day() },
  });
  setBusy(submit, false);
  if (!res.ok) {
    result(res.error, "error");
    return;
  }
  el("sv-report-meta").textContent = `تقرير محفوظ — صدر الآن`;
  renderReport(res.report);
  result("صدر التقرير اليومي وحُفظ.", "ok");
}

function escapeHtml(text) {
  const node = document.createElement("span");
  node.textContent = String(text ?? "");
  return node.innerHTML;
}

function printReport() {
  if (!state.report) return;
  const win = window.open("", "_blank");
  if (!win) return;
  win.document.write(`<!doctype html><html lang="ar" dir="rtl"><head><meta charset="utf-8" />
<title>التقرير اليومي — ${escapeHtml(state.report.branch.name)} — ${escapeHtml(state.report.date)}</title>
<style>
body{font-family:"IBM Plex Sans Arabic",Tahoma,sans-serif;color:#111;margin:24px;font-size:13px}
h3{margin:18px 0 6px;font-size:15px;border-bottom:1px solid #999;padding-bottom:4px}
table{width:100%;border-collapse:collapse;margin:6px 0}th,td{border:1px solid #bbb;padding:4px 6px;text-align:right;vertical-align:top}
th{background:#eee}.hint{color:#555;font-size:12px;margin-top:16px}
</style></head><body>${el("sv-report").innerHTML}</body></html>`);
  win.document.close();
  win.focus();
  win.print();
}

/* ── الحذف المشترك ─────────────────────────────────────────────── */

async function removeRecord(kind, id, after) {
  if (!confirm("حذف هذا السجل نهائياً؟")) return;
  const res = await api(`/surveillance/${kind}/${id}`, { method: "DELETE" });
  result(res.ok ? "حُذف السجل." : res.error, res.ok ? "ok" : "error");
  await after();
}

/* ── التنقّل ───────────────────────────────────────────────────── */

const TAB_LOADERS = {
  alerts: refreshAlerts,
  new: async () => {},
  orders: refreshOrders,
  waste: refreshWaste,
  cameras: async () => renderCameras(),
  report: () => loadReport(),
  limits: async () => renderTargets(),
  connect: async () => renderConnect(),
};

async function showTab(tab) {
  state.tab = tab;
  for (const node of el("sv-tabs").querySelectorAll(".tab")) {
    node.classList.toggle("is-active", node.dataset.sv === tab);
  }
  for (const node of document.querySelectorAll("#panel-surveillance [data-sv-section]")) {
    node.hidden = node.dataset.svSection !== tab;
  }
  await TAB_LOADERS[tab]?.();
}

async function refreshAll() {
  await loadCameras();
  await Promise.all([renderSummary(), showTab(state.tab)]);
}

function wire() {
  if (state.wired) return;
  state.wired = true;

  el("sv-date").value = todayIso();
  for (const id of ["sv-alert-time", "sv-order-registered", "sv-pos-time", "sv-waste-time"]) {
    el(id).value = toLocalInputValue();
  }

  el("sv-tabs").addEventListener("click", (event) => {
    const tab = event.target.closest(".tab");
    if (tab) showTab(tab.dataset.sv);
  });
  el("sv-branch").addEventListener("change", async () => {
    await loadMeta();
    await refreshAll();
  });
  el("sv-date").addEventListener("change", () => {
    el("sv-alerts-from").value = "";
    el("sv-alerts-to").value = "";
    refreshAll();
  });
  el("sv-refresh").addEventListener("click", refreshAll);
  for (const id of ["sv-alerts-from", "sv-alerts-to", "sv-alerts-status", "sv-alerts-role", "sv-alerts-urgent"]) {
    el(id).addEventListener("change", refreshAlerts);
  }
  el("sv-alert-role").addEventListener("change", fillAlertTypes);
  el("sv-review-form").addEventListener("submit", submitReview);
  el("sv-review-cancel").addEventListener("click", () => {
    state.reviewId = null;
    el("sv-review-form").hidden = true;
  });
  el("sv-alert-form").addEventListener("submit", submitAlert);
  el("sv-order-form").addEventListener("submit", submitOrder);
  el("sv-pos-form").addEventListener("submit", submitPos);
  el("sv-waste-form").addEventListener("submit", submitWaste);
  el("sv-camera-form").addEventListener("submit", submitCamera);
  el("sv-camera-cancel").addEventListener("click", resetCameraForm);
  for (const id of ["sv-camera-brand", "sv-camera-ip", "sv-camera-channel"]) {
    el(id).addEventListener("input", buildSnapshotUrl);
    el(id).addEventListener("change", buildSnapshotUrl);
  }
  el("sv-frame-close").addEventListener("click", () => {
    el("sv-frame-viewer").hidden = true;
  });
  el("sv-settings-form").addEventListener("submit", submitSettings);
  el("sv-target-form").addEventListener("submit", submitTarget);
  el("sv-report-generate").addEventListener("click", generateReport);
  el("sv-report-live").addEventListener("click", () => loadReport({ live: true }));
  el("sv-report-print").addEventListener("click", printReport);
}

export function initSurveillanceModule() {
  wire();
}

export async function refreshSurveillancePanel() {
  wire();
  if (!state.meta && !(await loadMeta())) return;
  await refreshAll();
  renderConnect();
  startPolling();
  await pollUrgent().catch(() => undefined);
}
