/**
 * تبويب «التنبيه والتصعيد» داخل شاشة الرقابة والكاميرات: مستلمو واتساب بحسب
 * المستوى (موظف/مدير/مالك)، مهل التصعيد، سجل الإبلاغ، تقييمات قوقل، شكاوى
 * الطاولات برمز QR، والتقرير الليلي للمالك.
 */

import { api, button, el, formatDateTime, row, setAlert, setBusy } from "../api.js";

const QR_LIB = "https://cdn.jsdelivr.net/npm/qrcode-generator@1.4.4/qrcode.js";

const state = { wired: false, branchId: null, date: "", data: null, canManage: false, employees: [] };

function note(message, kind) {
  setAlert(el("sv-result"), message, kind);
}

function chip(text, kind) {
  const node = document.createElement("span");
  node.className = `badge ${kind ?? ""}`;
  node.textContent = text;
  return node;
}

function para(text) {
  const p = document.createElement("p");
  p.className = "hint";
  p.textContent = text;
  return p;
}

function table(headers, rows, emptyText) {
  if (!rows.length) return para(emptyText);
  const wrap = document.createElement("div");
  wrap.className = "table-wrap";
  const t = document.createElement("table");
  t.className = "table";
  const head = document.createElement("thead");
  const hr = document.createElement("tr");
  for (const h of headers) {
    const th = document.createElement("th");
    th.textContent = h;
    hr.append(th);
  }
  head.append(hr);
  const body = document.createElement("tbody");
  for (const values of rows) body.append(row(values));
  t.append(head, body);
  wrap.append(t);
  return wrap;
}

const tierLabel = (tier) => state.data?.labels?.tiers?.[tier] ?? tier;
const zoneLabel = (zone) => state.data?.labels?.zones?.[zone] ?? zone;

function duration(seconds) {
  if (seconds === null || seconds === undefined) return "—";
  if (seconds < 60) return `${seconds} ث`;
  return `${Math.floor(seconds / 60)} د ${seconds % 60} ث`;
}

/* ── العرض ─────────────────────────────────────────────────────── */

function renderStatus() {
  const { whatsapp, google, settings, recipients } = state.data;
  const box = el("ct-status");
  box.replaceChildren(
    whatsapp.provider === "edge"
      ? whatsapp.edge?.state === "connected"
        ? chip("واتساب جوال المطعم مربوط ويرسل", "badge--ok")
        : whatsapp.edge?.state === "need_qr"
          ? chip("واتساب: امسح رمز QR على جهاز المطعم", "badge--warn")
          : chip("واتساب جوال المطعم غير مربوط — لن تخرج رسائل", "badge--disputed")
      : whatsapp.configured
        ? chip(`واتساب مضبوط (${whatsapp.provider === "meta" ? `Meta — قالب ${whatsapp.template}` : "UltraMsg"})`, "badge--ok")
        : chip("واتساب غير مضبوط — لن تخرج رسائل", "badge--disputed"),
    settings.enabled ? chip("الإبلاغ مفعّل", "badge--ok") : chip("الإبلاغ متوقف", "badge--warn"),
    google.configured && settings.googleLocation
      ? chip("تقييمات قوقل مربوطة", "badge--ok")
      : !settings.googleLocation
        ? chip("تقييمات قوقل: أدخل معرّف المطعم (ChIJ…)", "badge--warn")
        : chip("تقييمات قوقل: ينقص مفتاح GOOGLE_PLACES_API_KEY في Netlify", "badge--warn"),
  );
  for (const tier of ["owner", "manager", "staff"]) {
    const count = recipients.filter((r) => r.tier === tier && r.isActive).length;
    box.append(chip(`${tierLabel(tier)}: ${count}`, count ? "badge--reviewed" : "badge--warn"));
  }
  if (settings.reviewsLastError) box.append(chip(`قوقل: ${settings.reviewsLastError}`, "badge--disputed"));
}

function renderSettings() {
  const s = state.data.settings;
  el("ct-staff-min").value = s.staffAckMinutes;
  el("ct-order-min").value = s.orderStaffAckMinutes;
  el("ct-manager-min").value = s.managerAckMinutes;
  el("ct-queue").value = s.queueMax;
  el("ct-queue-sec").value = s.queueSeconds;
  el("ct-table-wait").value = s.tableWaitMinutes;
  el("ct-table-clear").value = s.tableClearMinutes;
  el("ct-stars").value = s.reviewMaxStars;
  el("ct-tables").value = s.tableCount;
  el("ct-brief-time").value = s.briefTime;
  el("ct-google").value = s.googleLocation;
  el("ct-enabled").checked = s.enabled;
  el("ct-feedback").checked = s.feedbackEnabled;
  el("ct-minor").checked = s.notifyMinor;
}

function renderRecipients() {
  const body = el("ct-recipients-table").querySelector("tbody");
  body.replaceChildren();
  const order = { owner: 0, manager: 1, staff: 2 };
  const list = [...state.data.recipients].sort((a, b) => order[a.tier] - order[b.tier] || a.id - b.id);
  if (!list.length) {
    body.append(row(["لا يوجد مستلمون بعد — أضف المالك ومدير المطعم والموظفين.", "", "", "", "", ""]));
    return;
  }
  for (const r of list) {
    const actions = document.createElement("div");
    actions.className = "row row--wrap row--tight";
    if (state.canManage) {
      actions.append(
        button("تجربة", { onClick: (node) => testRecipient(r, node) }),
        button(r.isActive ? "إيقاف" : "تفعيل", { onClick: (node) => toggleRecipient(r, node) }),
        button("حذف", { className: "btn btn--danger btn--xs", onClick: (node) => deleteRecipient(r, node) }),
      );
    }
    body.append(
      row([
        tierLabel(r.tier),
        r.name,
        `+${r.phone}`,
        r.tier === "staff"
          ? `${r.zones.length ? r.zones.map(zoneLabel).join("، ") : "كل المناطق"}${r.onShiftOnly ? " — على رأس العمل فقط" : ""}`
          : "—",
        r.isActive ? chip("فعّال", "badge--ok") : chip("موقوف", "badge--warn"),
        actions,
      ]),
    );
  }
}

function renderRecipientForm() {
  const select = el("ct-r-employee");
  const current = select.value;
  select.replaceChildren(new Option("— بدون —", ""));
  for (const e of state.employees) {
    select.append(new Option(`${e.employeeCode} — ${e.fullName}${e.jobTitle ? ` (${e.jobTitle})` : ""}`, e.id));
  }
  if ([...select.options].some((o) => o.value === current)) select.value = current;

  const zones = el("ct-r-zones");
  if (!zones.childElementCount) {
    for (const [key, label] of Object.entries(state.data.labels.zones)) {
      const wrap = document.createElement("label");
      wrap.className = "check";
      const input = document.createElement("input");
      input.type = "checkbox";
      input.value = key;
      wrap.append(input, ` ${label}`);
      zones.append(wrap);
    }
  }
  el("ct-r-staff-only").hidden = el("ct-r-tier").value !== "staff";
}

const DISPATCH_STATUS = {
  open: ["بانتظار الاستلام", "badge--warn"],
  acked: ["استُلم", "badge--ok"],
  exhausted: ["لا مستلم متاح", "badge--disputed"],
  closed: ["حُسم بالمراجعة", "badge--reviewed"],
};

function renderDispatches() {
  const rows = state.data.dispatches.map((d) => {
    const [text, kind] = DISPATCH_STATUS[d.status] ?? [d.status, ""];
    const status = document.createElement("div");
    status.className = "row row--wrap row--tight";
    status.append(chip(text, kind));
    if (d.status === "open") {
      status.append(button("استلمته", { onClick: (node) => ackDispatch(d, node) }));
    }
    const sent = d.messages.failed
      ? `${d.messages.sent} ✓ / ${d.messages.failed} ✗ ${d.messages.error}`
      : `${d.messages.sent} ✓${d.messages.skipped ? ` / ${d.messages.skipped} متجاوز` : ""}`;
    return [
      formatDateTime(d.occurredAt),
      d.label,
      d.location || "—",
      tierLabel(d.currentTier),
      sent,
      status,
      d.ackAt ? `${d.ackByName || "—"} بعد ${duration(d.ackSeconds)}${d.ackNote ? ` — ${d.ackNote}` : ""}` : "—",
    ];
  });
  el("ct-dispatches").replaceChildren(
    table(
      ["الوقت", "التنبيه", "الموقع", "وصل إلى", "الرسائل", "الحالة", "من استلم"],
      rows,
      "لا تنبيهات مُبلَّغة في هذا اليوم.",
    ),
  );
}

function renderBrief() {
  const box = el("ct-brief");
  box.replaceChildren();
  const brief = state.data.brief;
  if (!brief) {
    box.append(para("لم يصدر تقرير لهذا اليوم بعد. يصدر تلقائياً ويُرسل للمالك في الوقت المضبوط أعلاه."));
    return;
  }
  if (brief.score !== null) box.append(chip(`تقييم اليوم ${brief.score} / 10`, brief.score >= 7 ? "badge--ok" : brief.score >= 5 ? "badge--warn" : "badge--disputed"));
  const text = document.createElement("p");
  text.style.whiteSpace = "pre-line";
  text.textContent = brief.text;
  box.append(text, para(`صدر ${formatDateTime(brief.createdAt)}`));
}

function renderReviews() {
  const max = state.data.settings.reviewMaxStars;
  const rows = state.data.reviews.map((r) => [
    formatDateTime(r.reviewedAt),
    chip(`${"★".repeat(r.rating)}${"☆".repeat(Math.max(0, 5 - r.rating))}`, r.rating && r.rating <= max ? "badge--disputed" : "badge--ok"),
    r.author || "—",
    r.comment || "(بلا تعليق)",
    r.hasReply ? "تم الرد" : "بلا رد",
  ]);
  el("ct-reviews").replaceChildren(
    table(["التاريخ", "التقييم", "العميل", "التعليق", "الرد"], rows, "لا تقييمات مسحوبة بعد."),
  );
}

function renderFeedback() {
  const labels = state.data.labels.feedback;
  const rows = state.data.feedback.map((f) => [
    formatDateTime(f.createdAt),
    f.tableNo || "—",
    labels[f.category] ?? f.category,
    f.message || "—",
    f.phone ? `+${f.phone}` : "—",
  ]);
  el("ct-feedback-list").replaceChildren(
    table(["الوقت", "الطاولة", "النوع", "الملاحظة", "جوال العميل"], rows, "لا شكاوى طاولات في هذا اليوم."),
  );
}

function renderRoutes() {
  const rows = state.data.routes.map((r) => [
    r.label,
    tierLabel(r.first),
    r.escalate ? "نعم — حتى المالك" : "لا",
    r.minor ? "ملاحظة بسيطة (في التقرير فقط ما لم تُفعَّل)" : "فوري",
  ]);
  el("ct-routes").replaceChildren(table(["نوع التنبيه", "يستلمه أولاً", "يُصعَّد", "الإرسال"], rows, ""));
}

/* ── الإجراءات ─────────────────────────────────────────────────── */

async function load() {
  const res = await api(`/control/overview?branchId=${state.branchId}&date=${state.date}`);
  if (!res.ok) {
    note(res.error ?? "تعذّر تحميل بيانات التنبيه والتصعيد", "error");
    return;
  }
  state.data = res;
  renderStatus();
  renderSettings();
  renderRecipients();
  renderRecipientForm();
  renderDispatches();
  renderBrief();
  renderReviews();
  renderFeedback();
  renderRoutes();
  renderEdge();
  await loadZones();
}

async function run(node, request, { reload = true } = {}) {
  setBusy(node, true);
  const res = await request();
  setBusy(node, false);
  note(res.ok ? (res.message ?? "تم.") : (res.error ?? "تعذّر تنفيذ الطلب"), res.ok ? "ok" : "error");
  if (res.ok && reload) await load();
  return res;
}

async function saveSettings(event) {
  event.preventDefault();
  await run(el("ct-settings-save"), () =>
    api("/control/settings", {
      method: "PUT",
      body: {
        branchId: Number(state.branchId),
        staffAckMinutes: Number(el("ct-staff-min").value),
        orderStaffAckMinutes: Number(el("ct-order-min").value),
        managerAckMinutes: Number(el("ct-manager-min").value),
        queueMax: Number(el("ct-queue").value),
        queueSeconds: Number(el("ct-queue-sec").value),
        tableWaitMinutes: Number(el("ct-table-wait").value),
        tableClearMinutes: Number(el("ct-table-clear").value),
        reviewMaxStars: Number(el("ct-stars").value),
        tableCount: Number(el("ct-tables").value),
        briefTime: el("ct-brief-time").value,
        googleLocation: el("ct-google").value.trim(),
        enabled: el("ct-enabled").checked,
        feedbackEnabled: el("ct-feedback").checked,
        notifyMinor: el("ct-minor").checked,
      },
    }),
  );
}

async function addRecipient(event) {
  event.preventDefault();
  const zones = [...el("ct-r-zones").querySelectorAll("input:checked")].map((i) => i.value);
  const res = await run(el("ct-r-save"), () =>
    api("/control/recipients", {
      method: "POST",
      body: {
        branchId: Number(state.branchId),
        tier: el("ct-r-tier").value,
        employeeId: el("ct-r-employee").value ? Number(el("ct-r-employee").value) : null,
        name: el("ct-r-name").value.trim(),
        phone: el("ct-r-phone").value.trim(),
        zones,
        onShiftOnly: el("ct-r-onshift").checked,
      },
    }),
  );
  if (res.ok) {
    el("ct-r-name").value = "";
    el("ct-r-phone").value = "";
    el("ct-r-employee").value = "";
  }
}

const testRecipient = (r, node) =>
  run(node, () => api(`/control/recipients/${r.id}/test`, { method: "POST", body: {} }), { reload: false });

const toggleRecipient = (r, node) =>
  run(node, () => api(`/control/recipients/${r.id}`, { method: "PUT", body: { isActive: !r.isActive } }));

async function deleteRecipient(r, node) {
  if (!window.confirm(`حذف ${r.name} من مستلمي التنبيهات؟`)) return;
  await run(node, () => api(`/control/recipients/${r.id}`, { method: "DELETE" }));
}

const ackDispatch = (d, node) =>
  run(node, () => api(`/control/dispatches/${d.id}/ack`, { method: "POST", body: {} }));

const makeBrief = (send) => (event) =>
  run(event.currentTarget, () =>
    api("/control/brief", { method: "POST", body: { branchId: Number(state.branchId), date: state.date, send } }),
  );

/* ── طباعة رموز QR ─────────────────────────────────────────────── */

function loadQrLib() {
  if (window.qrcode) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const script = document.createElement("script");
    script.src = QR_LIB;
    script.onload = resolve;
    script.onerror = () => reject(new Error("تعذّر تحميل مكتبة QR"));
    document.head.append(script);
  });
}

async function printQr() {
  const count = state.data.settings.tableCount;
  if (!count) {
    note("حدّد عدد طاولات الصالة في الإعدادات أولاً.", "warn");
    return;
  }
  try {
    await loadQrLib();
  } catch (error) {
    note(error.message, "error");
    return;
  }
  const cards = [];
  for (let table = 1; table <= count; table++) {
    const qr = window.qrcode(0, "M");
    qr.addData(`${state.data.feedbackUrl}&t=${table}`);
    qr.make();
    cards.push(
      `<div class="card"><h2>طاولة ${table}</h2>${qr.createSvgTag({ cellSize: 5, margin: 2, scalable: true })}<p>نحتاج شيئاً؟ أو عندك ملاحظة؟<br>امسح الرمز ويصلك الموظف فوراً</p></div>`,
    );
  }
  const win = window.open("", "_blank");
  if (!win) {
    note("اسمح بالنوافذ المنبثقة لطباعة الرموز.", "warn");
    return;
  }
  win.document.write(`<!doctype html><html lang="ar" dir="rtl"><head><meta charset="utf-8"><title>رموز QR للطاولات</title>
<style>
body{font-family:"IBM Plex Sans Arabic","Segoe UI",sans-serif;margin:0;padding:8mm;color:#16150f}
.grid{display:grid;grid-template-columns:repeat(3,1fr);gap:6mm}
.card{border:1.5px solid #16150f;border-radius:4mm;padding:5mm;text-align:center;break-inside:avoid}
.card h2{margin:0 0 3mm;font-size:16pt}
.card svg{width:42mm;height:42mm}
.card p{margin:3mm 0 0;font-size:10pt;line-height:1.5}
@page{size:A4;margin:8mm}
</style></head><body><div class="grid">${cards.join("")}</div></body></html>`);
  win.document.close();
  win.focus();
  setTimeout(() => win.print(), 300);
}

/* ── التحليل المباشر: حالة الجهاز ورسم المناطق ─────────────────── */

const ZONE_COLORS = { table: "#7f9d63", queue: "#d9a13b", door: "#6fa8dc", restricted: "#c25c44" };
const ZONE_HINTS = {
  table: "انقر على زوايا سطح الطاولة نفسه (لا الكراسي) — 3 نقاط على الأقل.",
  queue: "ارسم المساحة التي يقف فيها العملاء أمام الكاشير.",
  door: "انقر نقطتين عبر عتبة الباب من اليسار إلى اليمين. الدخول = العبور نحو أسفل الصورة؛ إن كان الداخل يتجه لأعلى الصورة فارسمه من اليمين إلى اليسار.",
  restricted: "ارسم أرضية المنطقة الممنوعة خارج الدوام (المستودع، مدخل الباب الخلفي).",
};

const zoneState = { zones: [], cameras: [], image: null, draft: [] };

function renderEdge() {
  const edge = state.data.edge;
  const box = el("ct-edge-status");
  box.replaceChildren();
  if (!edge.lastSeenAt) {
    box.append(chip("جهاز التحليل لم يتصل بعد", "badge--submitted"));
  } else if (edge.online) {
    box.append(chip("جهاز التحليل متصل", "badge--ok"));
    for (const camera of edge.status?.cameras ?? []) {
      box.append(chip(`${camera.number}: ${camera.ok ? "بث يعمل" : "لا بث"}`, camera.ok ? "badge--ok" : "badge--disputed"));
    }
  } else {
    box.append(chip(`جهاز التحليل منقطع منذ ${formatDateTime(edge.lastSeenAt)}`, "badge--disputed"));
  }
  box.append(chip(`مناطق مرسومة: ${edge.zones}`, edge.zones ? "badge--reviewed" : "badge--warn"));
  const t = edge.tables;
  if (t.sessions) {
    box.append(
      chip(`جلسات الطاولات اليوم: ${t.sessions}`, "badge--reviewed"),
      chip(`متوسط وصول الموظف: ${duration(t.avgFirstVisitSeconds)}`, "badge--reviewed"),
      chip(`غادروا بلا خدمة: ${t.leftWithoutVisit}`, t.leftWithoutVisit ? "badge--disputed" : "badge--ok"),
      chip(`متوسط تنظيف الطاولة: ${duration(t.avgClearSeconds)}`, "badge--reviewed"),
    );
  }
  if (edge.footfall.entries !== null) box.append(chip(`الداخلون اليوم: ${edge.footfall.entries}`, "badge--reviewed"));
}

function currentCameraId() {
  return Number(el("ct-z-camera").value) || null;
}

function drawZones() {
  const canvas = el("ct-z-canvas");
  const ctx = canvas.getContext("2d");
  const { width, height } = canvas;
  ctx.clearRect(0, 0, width, height);
  if (zoneState.image) {
    ctx.drawImage(zoneState.image, 0, 0, width, height);
  } else {
    ctx.fillStyle = "#16150f";
    ctx.fillRect(0, 0, width, height);
    ctx.fillStyle = "#a99f88";
    ctx.font = "20px 'IBM Plex Sans Arabic', sans-serif";
    ctx.textAlign = "center";
    ctx.direction = "rtl";
    ctx.fillText("لا توجد لقطة لهذه الكاميرا بعد", width / 2, height / 2 - 14);
    ctx.fillText("تصل تلقائياً خلال دقائق من تشغيل جهاز التحليل", width / 2, height / 2 + 18);
  }
  const path = (points, close) => {
    ctx.beginPath();
    points.forEach(([x, y], i) => (i ? ctx.lineTo(x * width, y * height) : ctx.moveTo(x * width, y * height)));
    if (close) ctx.closePath();
  };
  const cameraId = currentCameraId();
  for (const zone of zoneState.zones.filter((z) => z.cameraId === cameraId)) {
    const color = ZONE_COLORS[zone.kind] ?? "#ece4d2";
    path(zone.points, zone.kind !== "door");
    ctx.lineWidth = 3;
    ctx.strokeStyle = color;
    if (zone.kind !== "door") {
      ctx.fillStyle = `${color}55`;
      ctx.fill();
    }
    ctx.stroke();
    const cx = zone.points.reduce((s, p) => s + p[0], 0) / zone.points.length;
    const cy = zone.points.reduce((s, p) => s + p[1], 0) / zone.points.length;
    const text = zone.label || state.data.edge.kinds[zone.kind] || zone.kind;
    ctx.font = "bold 18px 'IBM Plex Sans Arabic', sans-serif";
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    const w = ctx.measureText(text).width + 16;
    ctx.fillStyle = "#12120c";
    ctx.fillRect(cx * width - w / 2, cy * height - 14, w, 28);
    ctx.fillStyle = "#ece4d2";
    ctx.fillText(text, cx * width, cy * height);
  }
  if (zoneState.draft.length) {
    const kind = el("ct-z-kind").value;
    path(zoneState.draft, false);
    ctx.lineWidth = 2;
    ctx.setLineDash([8, 6]);
    ctx.strokeStyle = "#ece4d2";
    ctx.stroke();
    ctx.setLineDash([]);
    for (const [x, y] of zoneState.draft) {
      ctx.beginPath();
      ctx.arc(x * width, y * height, 6, 0, Math.PI * 2);
      ctx.fillStyle = ZONE_COLORS[kind] ?? "#ece4d2";
      ctx.fill();
      ctx.strokeStyle = "#12120c";
      ctx.stroke();
    }
  }
}

async function loadCameraImage() {
  zoneState.image = null;
  const cameraId = currentCameraId();
  if (cameraId) {
    const res = await api(`/surveillance/cameras/${cameraId}/latest`);
    if (res.ok && res.image) {
      const image = new Image();
      await new Promise((resolve) => {
        image.onload = resolve;
        image.onerror = resolve;
        image.src = res.image;
      });
      if (image.naturalWidth) {
        zoneState.image = image;
        const canvas = el("ct-z-canvas");
        canvas.height = Math.round((canvas.width * image.naturalHeight) / image.naturalWidth);
      }
    }
  }
  drawZones();
}

function renderZoneList() {
  const cameraName = (id) => {
    const camera = zoneState.cameras.find((c) => c.id === id);
    return camera ? `${camera.cameraNumber}${camera.name ? ` — ${camera.name}` : ""}` : "—";
  };
  const rows = zoneState.zones.map((zone) => {
    const actions = document.createElement("div");
    if (state.canManage) {
      actions.append(
        button("حذف", {
          className: "btn btn--danger btn--xs",
          onClick: async (node) => {
            if (!window.confirm("حذف هذه المنطقة؟")) return;
            await run(node, () => api(`/control/zones/${zone.id}`, { method: "DELETE" }));
          },
        }),
      );
    }
    return [cameraName(zone.cameraId), state.data.edge.kinds[zone.kind] ?? zone.kind, zone.label || "—", `${zone.points.length} نقاط`, actions];
  });
  el("ct-zones").replaceChildren(
    table(["الكاميرا", "النوع", "الاسم", "الرسم", ""], rows, "لم تُرسم مناطق بعد — اختر كاميرا الصالة وارسم الطاولات."),
  );
}

function syncZoneForm() {
  const kind = el("ct-z-kind").value;
  el("ct-z-hint").textContent = ZONE_HINTS[kind] ?? "";
  el("ct-z-label-text").textContent = kind === "table" ? "رقم الطاولة" : "اسم المنطقة (اختياري)";
}

async function loadZones() {
  const res = await api(`/control/zones?branchId=${state.branchId}`);
  if (!res.ok) return;
  zoneState.zones = res.zones;
  zoneState.cameras = res.cameras;
  const select = el("ct-z-camera");
  const current = select.value;
  select.replaceChildren();
  for (const camera of res.cameras) {
    select.append(new Option(`${camera.cameraNumber}${camera.name ? ` — ${camera.name}` : ""} (${zoneLabel(camera.zone)})`, camera.id));
  }
  if ([...select.options].some((o) => o.value === current)) select.value = current;
  const kinds = el("ct-z-kind");
  if (!kinds.childElementCount) {
    for (const [key, label] of Object.entries(state.data.edge.kinds)) kinds.append(new Option(label, key));
  }
  syncZoneForm();
  renderZoneList();
  if (!zoneState.image || zoneState.imageCamera !== currentCameraId()) {
    zoneState.imageCamera = currentCameraId();
    await loadCameraImage();
  } else {
    drawZones();
  }
}

async function saveZone() {
  const kind = el("ct-z-kind").value;
  const need = kind === "door" ? 2 : 3;
  if (zoneState.draft.length < need) {
    note(kind === "door" ? "انقر نقطتين لخط الباب." : "ارسم ثلاث نقاط على الأقل.", "warn");
    return;
  }
  const res = await run(el("ct-z-save"), () =>
    api("/control/zones", {
      method: "POST",
      body: {
        branchId: Number(state.branchId),
        cameraId: currentCameraId(),
        kind,
        label: el("ct-z-label").value.trim(),
        points: zoneState.draft,
      },
    }),
  );
  if (res.ok) {
    zoneState.draft = [];
    const label = el("ct-z-label");
    // الطاولة التالية غالباً رقمها التالي
    label.value = kind === "table" && /^\d+$/.test(label.value.trim()) ? String(Number(label.value) + 1) : "";
    drawZones();
  }
}

function wireZones() {
  const canvas = el("ct-z-canvas");
  canvas.addEventListener("click", (event) => {
    if (!state.canManage || !currentCameraId()) return;
    const rect = canvas.getBoundingClientRect();
    const x = Math.min(1, Math.max(0, (event.clientX - rect.left) / rect.width));
    const y = Math.min(1, Math.max(0, (event.clientY - rect.top) / rect.height));
    const max = el("ct-z-kind").value === "door" ? 2 : 12;
    if (zoneState.draft.length >= max) return;
    zoneState.draft.push([Math.round(x * 10000) / 10000, Math.round(y * 10000) / 10000]);
    drawZones();
  });
  el("ct-z-camera").addEventListener("change", async () => {
    zoneState.draft = [];
    zoneState.imageCamera = currentCameraId();
    await loadCameraImage();
  });
  el("ct-z-kind").addEventListener("change", () => {
    zoneState.draft = [];
    syncZoneForm();
    drawZones();
  });
  el("ct-z-undo").addEventListener("click", () => {
    zoneState.draft.pop();
    drawZones();
  });
  el("ct-z-clear").addEventListener("click", () => {
    zoneState.draft = [];
    drawZones();
  });
  el("ct-z-reload").addEventListener("click", loadCameraImage);
  el("ct-z-save").addEventListener("click", saveZone);
}

/* ── الربط ─────────────────────────────────────────────────────── */

function wire() {
  if (state.wired) return;
  state.wired = true;
  el("ct-settings-form").addEventListener("submit", saveSettings);
  el("ct-recipient-form").addEventListener("submit", addRecipient);
  el("ct-r-tier").addEventListener("change", () => {
    el("ct-r-staff-only").hidden = el("ct-r-tier").value !== "staff";
  });
  el("ct-r-employee").addEventListener("change", () => {
    const employee = state.employees.find((e) => String(e.id) === el("ct-r-employee").value);
    if (employee && !el("ct-r-name").value.trim()) el("ct-r-name").value = employee.fullName;
  });
  el("ct-brief-make").addEventListener("click", makeBrief(false));
  el("ct-brief-send").addEventListener("click", makeBrief(true));
  el("ct-reviews-sync").addEventListener("click", (event) =>
    run(event.currentTarget, () =>
      api("/control/reviews/sync", { method: "POST", body: { branchId: Number(state.branchId) } }),
    ),
  );
  el("ct-qr-print").addEventListener("click", printQr);
  wireZones();
}

export async function refreshControlTab(branchId, date, { employees = [], canManage = false } = {}) {
  state.branchId = branchId;
  state.date = date;
  state.employees = employees;
  state.canManage = canManage;
  wire();
  if (!branchId) return;
  await load();
}
