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
    whatsapp.configured
      ? chip(`واتساب مضبوط (${whatsapp.provider === "meta" ? `Meta — قالب ${whatsapp.template}` : "UltraMsg"})`, "badge--ok")
      : chip("واتساب غير مضبوط — لن تخرج رسائل", "badge--disputed"),
    settings.enabled ? chip("الإبلاغ مفعّل", "badge--ok") : chip("الإبلاغ متوقف", "badge--warn"),
    google.configured && settings.googleLocation
      ? chip("تقييمات قوقل مربوطة", "badge--ok")
      : chip("تقييمات قوقل غير مربوطة", "badge--submitted"),
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
