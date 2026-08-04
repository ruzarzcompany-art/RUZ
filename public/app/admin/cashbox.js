/**
 * النقدية والخزينة في لوحة الإدارة — بعد نقل المصاريف والمتبقي والرصيد
 * الشهري إلى صفحة تقفيل الكاشير نفسها.
 *
 * ما بقي هنا ثلاثة أقسام:
 * 1) الشبكات: تجميع شهري لكل شبكة من التقفيلات اليومية، وتسويتها على
 *    المجمَّع الشهري عند وصول الحوالة إلى البنك.
 * 2) تطبيقات التوصيل: قسم مستقل تماماً بتجميعه الشهري وتسويته الخاصة.
 * 3) سجل التسويات، ثم إقفال الشهر والترحيل أو التصفير.
 *
 * العمولة = المبيعات − المستلم، والنسبة = العمولة ÷ المبيعات × 100،
 * يحسبهما الخادم من المجمَّع الشهري لا من يوم واحد — وما هنا عرض فقط.
 */

import {
  api,
  button,
  currentMonthKey,
  el,
  formatDateTime,
  formatMoney,
  row,
  setAlert,
  setBusy,
} from "../api.js";
import { createPager } from "../pagination.js";

const PROVIDER_LABELS = { network: "شبكة", delivery_app: "تطبيق توصيل" };
const SETTLEMENT_STATUS = {
  open: "لم تُسجَّل بعد",
  pending: "بانتظار السداد",
  confirmed: "مؤكَّدة",
};

/** القسمان المستقلان: لكل نوع بادئة معرّفاته وعنوانه. */
const SECTIONS = {
  network: { key: "network", title: "الشبكات" },
  delivery_app: { key: "delivery", title: "تطبيقات التوصيل" },
};

const settlementsPager = createPager("cashbox-settlements-table", { unit: "تسوية" });

const state = {
  ready: false,
  caps: {},
  meta: null,
  levelOf: () => 0,
  canDeleteIn: () => false,
  monthClosings: [],
};

/* ── أدوات صغيرة ─────────────────────────────────────────────── */

function chipsInto(nodeId, items) {
  const box = el(nodeId);
  if (!box) return;
  box.textContent = "";
  for (const item of items) {
    const chip = document.createElement("span");
    chip.className = item[2] ? "chip " + item[2] : "chip";
    const strong = document.createElement("strong");
    strong.textContent = item[1];
    chip.append(document.createTextNode(item[0] + ": "), strong);
    box.append(chip);
  }
}

function selectedBranch() {
  const node = el("cashbox-branch");
  return node ? node.value : "";
}

function withBranch(params) {
  const branch = selectedBranch();
  if (branch) params.set("branchId", branch);
  return params;
}

function query(params) {
  const text = params.toString();
  return text ? "?" + text : "";
}

function withBranchBody(body) {
  const branch = selectedBranch();
  if (branch) body.branchId = Number(branch);
  return body;
}

function moneyCell(value, negativeIsBad) {
  const node = document.createElement("span");
  node.textContent = formatMoney(value);
  if (negativeIsBad) {
    node.classList.toggle("is-negative", Number(value) < -0.009);
    node.classList.toggle("is-positive", Number(value) > 0.009);
  }
  return node;
}

/* ── إشعارات ملخّص الإقفال ───────────────────────────────────── */

async function loadNotifications() {
  const box = el("cashbox-notices");
  const result = await api("/finance/notifications");
  box.textContent = "";

  const unread = result.ok
    ? (result.notifications || []).filter((item) => !item.isRead)
    : [];
  el("cashbox-notices-empty").hidden = unread.length > 0;

  for (const notice of unread) {
    const card = document.createElement("p");
    card.className = "alert alert--warn";
    const title = document.createElement("strong");
    title.textContent = notice.title;
    const seen = button("تم الاطلاع", {
      onClick: async () => {
        await api("/finance/notifications/" + notice.id + "/read", { method: "POST" });
        await loadNotifications();
      },
    });
    card.append(title, document.createTextNode(" — " + notice.body + " "), seen);
    box.append(card);
  }
}

/* ══ التجميع الشهري والتسوية — قسم مستقل لكل نوع ══════════════════ */

/** الشهر المختار في قسم نوع بعينه. */
function monthOf(type) {
  const node = el("cashbox-" + SECTIONS[type].key + "-month");
  return (node && node.value) || currentMonthKey();
}

/**
 * تسوية شهر جهة واحدة.
 *
 * المبيعات لا تُرسل من هنا إطلاقاً: الخادم يجمعها من تقفيلات الشهر نفسه.
 * والمطلوب من المحاسب رقمٌ واحد: المبلغ الذي وصل البنك — ومنه يُحسب:
 * العمولة = المبيعات المجمّعة − المستلم، والنسبة = العمولة ÷ المبيعات × 100.
 */
async function settleMonth(type, provider) {
  const month = monthOf(type);

  const received = window.prompt(
    "المبلغ الواصل إلى البنك عن " +
      provider.providerName +
      " في شهر " +
      month +
      " (المبيعات المجمّعة " +
      formatMoney(provider.monthlySales) +
      "):",
    String(provider.receivedAmount || ""),
  );
  if (received === null) return;

  const vat = window.prompt(
    "نسبة الضريبة على العمولة % (اختياري — صفر يعني بلا ضريبة):",
    String(provider.vatRate || 0),
  );
  if (vat === null) return;

  // التأكيد إجراء موافقة ببنده المستقل؛ من لا يملكه تُحفظ تسويته معلّقة
  const confirmed = state.caps.confirmSettlements
    ? window.confirm(
        "تأكيد وصول الحوالة وإقفال تسوية " +
          provider.providerName +
          " لشهر " +
          month +
          "؟ (إلغاء = حفظها بانتظار السداد)",
      )
    : false;

  const result = await api("/finance/settlements/monthly", {
    method: "POST",
    body: withBranchBody({
      month,
      providerType: type,
      providerName: provider.providerName,
      receivedAmount: Number(received || 0),
      vatRate: Number(vat || 0),
      confirm: confirmed,
    }),
  });

  setAlert(
    el("cashbox-" + SECTIONS[type].key + "-result"),
    result.ok ? result.message : (result.error || "تعذّر حفظ التسوية الشهرية"),
    result.ok ? "ok" : "error",
  );

  if (result.ok) await Promise.all([loadMonthlySection(type), loadSettlements()]);
}

/**
 * قسم نوع واحد: مبيعات كل جهة مجمّعة على الشهر كله، وما وصل البنك منها،
 * والعمولة ونسبتها. الشبكات وتطبيقات التوصيل لا يختلطان في جدول واحد.
 */
async function loadMonthlySection(type) {
  if (!state.caps.readSettlements) return;
  const meta = SECTIONS[type];
  const params = withBranch(new URLSearchParams());
  params.set("providerType", type);
  params.set("month", monthOf(type));

  const result = await api("/finance/settlements/monthly" + query(params));
  const body = el("cashbox-" + meta.key + "-table").querySelector("tbody");

  if (!result.ok) {
    body.replaceChildren();
    chipsInto("cashbox-" + meta.key + "-chips", []);
    setAlert(
      el("cashbox-" + meta.key + "-result"),
      result.error || "تعذّر قراءة التجميع الشهري",
      "error",
    );
    return;
  }

  const providers = result.providers || [];
  body.replaceChildren(
    ...providers.map((provider) => {
      const actions = document.createElement("span");
      actions.className = "row-actions";

      if (state.caps.manageSettlements && provider.status !== "confirmed") {
        actions.append(
          button(provider.status === "pending" ? "تحديث التسوية" : "تسوية الشهر", {
            className: "btn btn--primary btn--xs",
            onClick: () => settleMonth(type, provider),
          }),
        );
      }

      return row([
        provider.providerName,
        formatMoney(provider.monthlySales),
        formatMoney(provider.receivedAmount),
        moneyCell(provider.commissionAmount, false),
        String(provider.commissionRate) + "%",
        formatMoney(provider.vatAmount),
        SETTLEMENT_STATUS[provider.status] || provider.status,
        provider.confirmedByName || "—",
        actions,
      ]);
    }),
  );

  el("cashbox-" + meta.key + "-empty").hidden = providers.length > 0;

  const totals = result.totals || {};
  chipsInto("cashbox-" + meta.key + "-chips", [
    ["الشهر", result.month || monthOf(type)],
    ["مبيعات الشهر المجمّعة", formatMoney(totals.monthlySales)],
    ["الواصل للبنك", formatMoney(totals.receivedAmount)],
    ["العمولة", formatMoney(totals.commissionAmount)],
    ["نسبة العمولة", String(totals.commissionRate || 0) + "%"],
    ["الضريبة", formatMoney(totals.vatAmount)],
    ["بانتظار السداد", String(totals.pending || 0)],
  ]);
  setAlert(el("cashbox-" + meta.key + "-result"), "");
}

/* ══ سجل التسويات ═════════════════════════════════════════════════ */

async function removeSettlement(settlement) {
  if (!window.confirm("حذف تسوية " + settlement.providerName + "؟")) return;
  const reason = window.prompt("سبب الحذف (يُسجَّل في التدقيق):", "") || "";
  const result = await api("/finance/settlements/" + settlement.id, {
    method: "DELETE",
    body: { reason },
  });
  setAlert(
    el("cashbox-settlements-result"),
    result.ok ? (result.message || "تم الحذف") : (result.error || "تعذّر الحذف"),
    result.ok ? "ok" : "error",
  );
  if (result.ok) await refreshSettlementSections();
}

/** كل التسويات المسجّلة: الشهر، المبيعات المجمّعة، المستلم، العمولة ونسبتها. */
export async function loadSettlements() {
  if (!state.caps.readSettlements) return;
  const params = withBranch(new URLSearchParams());
  const status = el("cashbox-settlements-status").value;
  const type = el("cashbox-settlements-type").value;
  if (status) params.set("status", status);
  if (type) params.set("providerType", type);

  const result = await api("/finance/settlements" + query(params));
  if (!result.ok) {
    settlementsPager.clear();
    setAlert(
      el("cashbox-settlements-result"),
      result.error || "تعذّر تحميل التسويات",
      "error",
    );
    return;
  }

  const settlements = result.settlements || [];
  settlementsPager.render(settlements, (settlement) => {
    const actions = document.createElement("span");
    actions.className = "row-actions";

    if (
      settlement.status === "pending" &&
      state.caps.manageSettlements &&
      state.canDeleteIn("settlements")
    ) {
      actions.append(
        button("حذف", {
          className: "btn btn--danger btn--xs",
          onClick: () => removeSettlement(settlement),
        }),
      );
    }

    return row([
      settlement.providerName,
      PROVIDER_LABELS[settlement.providerType] || settlement.providerType,
      String(settlement.periodFrom).slice(0, 7),
      formatMoney(settlement.salesAmount),
      formatMoney(settlement.receivedAmount),
      moneyCell(settlement.commissionAmount, false),
      String(settlement.commissionRate) + "%",
      formatMoney(settlement.vatAmount),
      SETTLEMENT_STATUS[settlement.status] || settlement.status,
      settlement.confirmedAt ? formatDateTime(settlement.confirmedAt) : "—",
      settlement.confirmedByName || "—",
      actions,
    ]);
  });

  el("cashbox-settlements-empty").hidden = settlements.length > 0;
  const summary = result.summary || {};
  chipsInto("cashbox-settlements-chips", [
    ["عدد التسويات", String(summary.count || 0)],
    ["بانتظار السداد", String(summary.pending || 0)],
    ["المبيعات المجمّعة", formatMoney(summary.salesAmount)],
    ["المستلم المؤكَّد", formatMoney(summary.receivedAmount)],
    ["العمولات", formatMoney(summary.commissionAmount)],
    ["الضريبة", formatMoney(summary.vatAmount)],
  ]);
  setAlert(el("cashbox-settlements-result"), "");
}

/** القسمان والسجل معاً بعد أي تغيير. */
async function refreshSettlementSections() {
  await Promise.all([
    loadMonthlySection("network"),
    loadMonthlySection("delivery_app"),
    loadSettlements(),
  ]);
}

/* ══ إقفال الشهر والترحيل ══════════════════════════════════════════ */

async function decideMonth(closing, decision) {
  const isCarry = decision === "carry_forward";
  const confirmText = isCarry
    ? "اعتماد ترحيل صافي شهر " +
      closing.monthKey +
      " (" +
      formatMoney(closing.netAmount) +
      ") إلى بداية الشهر الجديد؟"
    : "تصفير رصيد شهر " +
      closing.monthKey +
      " والبدء من صفر؟ الصافي " +
      formatMoney(closing.netAmount) +
      " لن يُرحّل.";
  if (!window.confirm(confirmText)) return;

  const note = window.prompt("ملاحظة القرار (اختيارية — تُسجَّل في سجل المراجعة):", "") || "";
  const result = await api("/finance/monthly-closings/" + closing.id + "/decision", {
    method: "POST",
    body: { decision, note },
  });

  setAlert(
    el("cashbox-months-result"),
    result.ok ? result.message : (result.error || "تعذّر تنفيذ القرار"),
    result.ok ? "ok" : "error",
  );
  if (result.ok) await Promise.all([loadMonthClosings(), loadNotifications()]);
}

async function prepareMonth() {
  const month = el("cashbox-prepare-month").value;
  if (!month) {
    setAlert(el("cashbox-months-result"), "اختر الشهر أولاً", "error");
    return;
  }
  const node = el("cashbox-prepare-run");
  setBusy(node, true);
  const result = await api("/finance/monthly-closings/prepare", {
    method: "POST",
    body: withBranchBody({ month }),
  });
  setBusy(node, false);

  setAlert(
    el("cashbox-months-result"),
    result.ok ? result.message : (result.error || "تعذّر تجهيز الملخّص"),
    result.ok ? "ok" : "error",
  );
  if (result.ok) await Promise.all([loadMonthClosings(), loadNotifications()]);
}

export async function loadMonthClosings() {
  if (!state.caps.viewMonthlySummary) return;
  const params = withBranch(new URLSearchParams());
  const year = el("cashbox-year").value;
  if (year) params.set("year", year);

  const result = await api("/finance/monthly-closings" + query(params));
  const body = el("cashbox-months-table").querySelector("tbody");

  if (!result.ok) {
    body.replaceChildren();
    setAlert(
      el("cashbox-months-result"),
      result.error || "تعذّر تحميل إقفالات الشهور",
      "error",
    );
    return;
  }

  state.monthClosings = result.closings || [];
  body.replaceChildren(
    ...state.monthClosings.map((closing) => {
      const actions = document.createElement("span");
      actions.className = "row-actions";

      if (closing.status === "pending_approval") {
        if (result.canCarryForward) {
          actions.append(
            button("اعتماد الترحيل", {
              className: "btn btn--primary btn--xs",
              onClick: () => decideMonth(closing, "carry_forward"),
            }),
          );
        }
        if (result.canReset) {
          actions.append(
            button("تصفير", {
              className: "btn btn--danger btn--xs",
              onClick: () => decideMonth(closing, "reset"),
            }),
          );
        }
        if (!result.canCarryForward && !result.canReset) {
          const note = document.createElement("span");
          note.className = "hint";
          note.textContent = "بانتظار صاحب الصلاحية";
          actions.append(note);
        }
      }

      const statusChip = document.createElement("span");
      statusChip.className = "badge badge--" + closing.status;
      statusChip.textContent = closing.statusLabel;

      return row([
        closing.monthKey,
        formatMoney(closing.openingBalance),
        formatMoney(closing.cashSalesTotal),
        formatMoney(closing.expensesTotal),
        moneyCell(closing.netAmount, true),
        formatMoney(closing.carriedAmount),
        statusChip,
        closing.decidedByName || "—",
        closing.decidedAt ? formatDateTime(closing.decidedAt) : "—",
        actions,
      ]);
    }),
  );

  el("cashbox-months-empty").hidden = state.monthClosings.length > 0;
  el("cashbox-months-note").textContent =
    result.prepared > 0
      ? "جُهّز ملخّص " +
        String(result.prepared) +
        " شهر تلقائياً وأُرسل إشعاره لأصحاب الصلاحية."
      : "";
}

/* ── التهيئة ─────────────────────────────────────────────────── */

/** يخفي الأقسام التي لا يملك المستخدم صلاحيتها بالكامل. */
function applyCapabilities() {
  el("cashbox-network-card").hidden = !state.caps.readSettlements;
  el("cashbox-delivery-card").hidden = !state.caps.readSettlements;
  el("cashbox-settlements-card").hidden = !state.caps.readSettlements;
  el("cashbox-months-card").hidden = !state.caps.viewMonthlySummary;
  el("cashbox-prepare-row").hidden = !state.caps.viewMonthlySummary;
}

export function initCashboxModule({ can, levelOf, canDeleteIn }) {
  if (state.ready) return;
  state.ready = true;
  if (levelOf) state.levelOf = levelOf;
  if (canDeleteIn) state.canDeleteIn = canDeleteIn;

  el("cashbox-network-run").addEventListener("click", () => loadMonthlySection("network"));
  el("cashbox-network-month").addEventListener("change", () => loadMonthlySection("network"));
  el("cashbox-delivery-run").addEventListener("click", () =>
    loadMonthlySection("delivery_app"),
  );
  el("cashbox-delivery-month").addEventListener("change", () =>
    loadMonthlySection("delivery_app"),
  );

  el("cashbox-settlements-run").addEventListener("click", loadSettlements);
  el("cashbox-months-run").addEventListener("click", loadMonthClosings);
  el("cashbox-prepare-run").addEventListener("click", prepareMonth);
  el("cashbox-branch").addEventListener("change", refreshCashboxPanel);
}

/** يُستدعى عند فتح التبويب: يقرأ القدرات ثم يحمّل الأقسام المسموح بها. */
export async function refreshCashboxPanel() {
  const meta = await api("/finance/meta");
  if (!meta.ok) {
    setAlert(el("cashbox-alert"), meta.error || "لا تملك صلاحية شاشة النقدية", "error");
    return;
  }

  setAlert(el("cashbox-alert"), "");
  state.meta = meta;
  state.caps = meta.can || {};
  applyCapabilities();

  const branchSelect = el("cashbox-branch");
  if (branchSelect.options.length <= 1) {
    branchSelect.textContent = "";
    for (const branch of meta.branches || []) {
      const option = document.createElement("option");
      option.value = String(branch.id);
      option.textContent = branch.name;
      branchSelect.append(option);
    }
    if (meta.defaultBranchId) branchSelect.value = String(meta.defaultBranchId);
  }

  const today = meta.today || "";
  const month = today ? today.slice(0, 7) : currentMonthKey();
  if (!el("cashbox-network-month").value) el("cashbox-network-month").value = month;
  if (!el("cashbox-delivery-month").value) el("cashbox-delivery-month").value = month;
  if (!el("cashbox-year").value) el("cashbox-year").value = today.slice(0, 4);
  if (!el("cashbox-prepare-month").value) el("cashbox-prepare-month").value = month;

  el("cashbox-decision-hint").hidden = state.caps.carryForward || state.caps.resetBalance;

  await loadNotifications();
  if (state.caps.readSettlements) await refreshSettlementSections();
  if (state.caps.viewMonthlySummary) await loadMonthClosings();
}
