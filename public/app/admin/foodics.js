/**
 * تبويب «فوديكس والرقابة الثلاثية» داخل شاشة الرقابة والكاميرات:
 * ضبط مفتاح فوديكس وربط الفرع، المزامنة الفورية، وتقرير اليوم الذي يطابق
 * الكاميرات بفوديكس بتقفيل الكاشير بالجرد اليدوي.
 */

import { api, el, formatDateTime, formatMoney, row, setAlert, setBusy } from "../api.js";

const state = { wired: false, branchId: null, date: "", foodicsBranches: [] };

function note(message, kind) {
  setAlert(el("sv-result"), message, kind);
}

function chip(text, kind) {
  const node = document.createElement("span");
  node.className = `badge ${kind ?? ""}`;
  node.textContent = text;
  return node;
}

function heading(text) {
  const h = document.createElement("h3");
  h.className = "card__title card__title--sm";
  h.textContent = text;
  return h;
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

const money = (v) => (v === null || v === undefined ? "—" : formatMoney(v));
const gapChip = (gap, tol) =>
  gap === null ? chip("لا تقفيل", "") : Math.abs(gap) <= tol ? chip(formatMoney(gap), "badge--ok") : chip(formatMoney(gap), "badge--disputed");

/* ── الحالة والإعدادات ─────────────────────────────────────────── */

async function loadStatus() {
  const res = await api(`/foodics/status?branchId=${state.branchId}`);
  const box = el("fx-status");
  box.replaceChildren();
  if (!res.ok) {
    box.append(chip(res.error ?? "تعذّر قراءة الحالة", "badge--disputed"));
    return null;
  }
  const s = res.status;
  box.append(
    s.connected ? chip(`مفتاح فوديكس مضبوط (${s.tokenSource === "env" ? "من Netlify" : "محفوظ في النظام"})`, "badge--ok") : chip("مفتاح فوديكس غير مضبوط", "badge--warn"),
    s.foodicsBranchId ? chip("الفرع مربوط", "badge--ok") : chip("الفرع غير مربوط", "badge--warn"),
    chip(s.lastSyncAt ? `آخر مزامنة: ${formatDateTime(s.lastSyncAt)}` : "لم تتم مزامنة بعد", ""),
    chip(`فواتير محفوظة: ${s.ordersStored}`, ""),
  );
  if (s.lastError) box.append(chip(`ملاحظة: ${s.lastError}`, "badge--warn"));
  el("fx-window").value = s.matchMinutes;
  el("fx-tolerance").value = s.salesGapTolerance;
  const select = el("fx-branch");
  if (s.foodicsBranchId && ![...select.options].some((o) => o.value === s.foodicsBranchId)) {
    select.append(new Option(`فرع فوديكس ${s.foodicsBranchId.slice(0, 8)}…`, s.foodicsBranchId));
  }
  select.value = s.foodicsBranchId;
  return s;
}

function fillBranches(list) {
  const select = el("fx-branch");
  const current = select.value;
  select.replaceChildren(new Option("— غير مربوط —", ""));
  for (const b of list) select.append(new Option(`${b.name}${b.reference ? ` (${b.reference})` : ""}`, b.id));
  select.value = current;
}

async function saveToken(event) {
  event.preventDefault();
  const token = el("fx-token").value.trim();
  if (!token) {
    note("الصق مفتاح فوديكس أولاً.", "error");
    return;
  }
  setBusy(el("fx-token-save"), true);
  const res = await api("/foodics/token", { method: "PUT", body: { token } });
  setBusy(el("fx-token-save"), false);
  el("fx-token").value = "";
  note(res.ok ? res.message : res.error, res.ok ? "ok" : "error");
  if (res.ok) await testConnection();
}

async function testConnection() {
  setBusy(el("fx-test"), true);
  const res = await api("/foodics/test", { method: "POST" });
  setBusy(el("fx-test"), false);
  if (!res.ok) {
    note(res.error, "error");
    return;
  }
  state.foodicsBranches = res.branches ?? [];
  fillBranches(state.foodicsBranches);
  note(`نجح الاتصال بفوديكس — ${state.foodicsBranches.length} فرع. اختر الفرع المقابل ثم احفظ الربط.`, "ok");
  const fields = el("fx-fields");
  fields.hidden = !res.orderFields?.length;
  fields.textContent = res.orderFields?.length ? `الحقول الواردة في فواتير حسابك: ${res.orderFields.join("، ")}` : "";
  await loadStatus();
}

async function saveBranch(event) {
  event.preventDefault();
  const res = await api("/foodics/branch", {
    method: "PUT",
    body: {
      branchId: state.branchId,
      foodicsBranchId: el("fx-branch").value,
      matchMinutes: el("fx-window").value,
      salesGapTolerance: el("fx-tolerance").value,
    },
  });
  note(res.ok ? res.message : res.error, res.ok ? "ok" : "error");
  await loadStatus();
}

async function syncNow() {
  setBusy(el("fx-sync"), true);
  note("جارٍ السحب من فوديكس…", "");
  const res = await api("/foodics/sync", { method: "POST", body: { branchId: state.branchId } });
  setBusy(el("fx-sync"), false);
  if (!res.ok) {
    note(res.error, "error");
    return;
  }
  const s = res.stats;
  note(
    `تمت المزامنة: ${s.orders} فاتورة، ${s.posEvents} حدث إلغاء/خصم/استرجاع، ${s.prepOrders} طلب بوقت مطبخ، ${s.waste} سطر هدر/تعديل، ` +
      `فتح درج مطابق ${s.drawerMatched} وغير مطابق ${s.drawerUnmatched}، و${s.alerts.length} تنبيه.${s.notes.length ? ` ملاحظات: ${s.notes.join(" | ")}` : ""}`,
    "ok",
  );
  await loadStatus();
  await loadReport();
}

/* ── التقرير ───────────────────────────────────────────────────── */

const MATCH_TEXT = { matched: ["توجد فاتورة", "badge--ok"], unmatched: ["لا فاتورة", "badge--disputed"], pending: ["بانتظار المزامنة", ""] };
const FLAG_TEXT = { unexplained_shortage: ["نقص بلا هدر مسجّل", "badge--disputed"], camera_only: ["هدر بالكاميرا فقط", "badge--warn"], "": ["متطابق", "badge--ok"] };

async function loadReport() {
  const box = el("fx-report");
  box.replaceChildren(para("جارٍ التحميل…"));
  const res = await api(`/foodics/triple?branchId=${state.branchId}&date=${state.date}`);
  if (!res.ok) {
    box.replaceChildren(para(res.error ?? "تعذّر تحميل التقرير"));
    return;
  }
  const r = res.report;
  const tol = Number(el("fx-tolerance").value || 5);
  const f = r.sales.foodics;
  box.replaceChildren(
    heading(`1) المبيعات — فوديكس مقابل تقفيل الكاشير (${r.date})`),
    table(
      ["البند", "فوديكس", "التقفيل", "الفرق"],
      [
        ["إجمالي المبيعات", money(f.total), r.sales.closings.count ? money(r.sales.closings.total) : "—", gapChip(r.sales.totalGap, tol)],
        ["النقد", money(f.cash), r.sales.closings.count ? money(r.sales.closings.cash) : "—", gapChip(r.sales.cashGap, tol)],
        ["الشبكة", money(f.card), "", ""],
        ["شبكة فوديكس", money(f.foodicsPay), "", ""],
        ["تطبيقات التوصيل", money(f.deliveryApps), "", ""],
        ["الخصومات", money(f.discounts), "", ""],
        ["المرتجعات", money(f.refunds), "", ""],
        ["الملغاة", money(f.voids), "", ""],
        ["عدد الفواتير", String(f.invoices), "", ""],
      ],
      "",
    ),
    heading("2) فتح الدرج المرصود بالكاميرا ↔ فواتير فوديكس"),
    table(
      ["الوقت", "الكاشير", "المطابقة", "التفاصيل"],
      r.drawer.map((d) => {
        const [text, kind] = MATCH_TEXT[d.match] ?? MATCH_TEXT.pending;
        return [formatDateTime(d.at), d.cashier || "—", chip(text, kind), d.note || ""];
      }),
      "لم ترصد الكاميرات فتح درج في هذا اليوم.",
    ),
    heading("3) الإلغاء والخصم والاسترجاع في فوديكس لكل كاشير"),
    table(
      ["الكاشير", "إلغاء", "خصم", "استرجاع", "المبلغ"],
      r.cashiers.map((c) => [c.name, String(c.void), String(c.discount), String(c.refund), money(c.amount)]),
      "لا عمليات إلغاء أو خصم أو استرجاع.",
    ),
    heading("4) خدمة الزبائن والتأخير"),
    table(
      ["المؤشر", "القيمة"],
      [
        ["طلبات بوقت مطبخ من فوديكس", String(r.service.ordersWithKitchenTime)],
        ["متوسط وقت التجهيز (دقيقة)", r.service.avgPrepMinutes ?? "— (فوديكس لم يرسل أوقات المطبخ)"],
        [`طلبات تجاوزت ${r.service.targetMinutes} دقيقة`, String(r.service.overTarget)],
        ["تنبيهات انتظار زبون بلا خدمة (الكاميرات)", String(r.service.customerWaitAlerts)],
      ],
      "",
    ),
    table(
      ["الساعة", "فواتير فوديكس", "أعلى عدد أشخاص رصدته الكاميرات"],
      r.hourly.map((h) => [`${String(h.hour).padStart(2, "0")}:00`, String(h.invoices), String(h.peopleMax)]),
      "لا بيانات ساعية.",
    ),
    para("عدد الأشخاص مؤشر تقريبي من لقطات الصالة والمدخل والكاشير — للمقارنة مع عدد الفواتير، لا عدّ دقيق للزبائن."),
    heading("5) المخزون والهدر — فوديكس ↔ الجرد اليدوي ↔ الكاميرات"),
    table(
      ["الصنف", "هدر فوديكس", "تعديل فوديكس", "هدر مسجّل يدوياً", "فرق الجرد", "مشاهدات هدر بالكاميرا", "الحالة"],
      r.inventory.map((i) => {
        const [text, kind] = FLAG_TEXT[i.flag] ?? FLAG_TEXT[""];
        return [i.item || i.code, String(i.foodicsWaste), String(i.foodicsAdjust), String(i.manualWaste), String(i.countVariance), String(i.cameraWaste), chip(text, kind)];
      }),
      "لا حركات هدر أو جرد في هذا اليوم.",
    ),
    heading("6) تنبيهات مهمة في اليوم"),
    table(
      ["التنبيه", "العدد"],
      [
        ["باب الثلاجة مفتوح", String(r.alerts.fridgeDoorOpen)],
        ["دخول المستودع/الثلاجة خارج الدوام", String(r.alerts.warehouseOffHours)],
        ["إخراج مواد من المستودع", String(r.alerts.warehouseExit)],
        ["فتح الدرج", String(r.alerts.drawer)],
        ["إلغاء/خصم متكرر", String(r.alerts.repeatedPos)],
        ["فرق مبيعات", String(r.alerts.salesGap)],
        ["فرق هدر/جرد", String(r.alerts.wasteGap)],
      ],
      "",
    ),
  );
}

/* ── الربط ─────────────────────────────────────────────────────── */

function wire() {
  if (state.wired) return;
  state.wired = true;
  el("fx-token-form").addEventListener("submit", saveToken);
  el("fx-test").addEventListener("click", testConnection);
  el("fx-branch-form").addEventListener("submit", saveBranch);
  el("fx-sync").addEventListener("click", syncNow);
  el("fx-report-load").addEventListener("click", loadReport);
}

export async function refreshFoodicsTab(branchId, date) {
  wire();
  state.branchId = branchId;
  state.date = date;
  const status = await loadStatus();
  if (status?.foodicsBranchId) await loadReport();
  else el("fx-report").replaceChildren(para("اربط الفرع بفوديكس لعرض تقرير الرقابة الثلاثية."));
}
