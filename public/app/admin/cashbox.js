/**
 * النقدية والخزينة في لوحة الإدارة — بعد نقل المصاريف والمتبقي والرصيد
 * الشهري إلى صفحة تقفيل الكاشير نفسها.
 *
 * ما بقي هنا خمسة أقسام:
 * 1) الشبكات: تجميع شهري لكل شبكة من التقفيلات اليومية، وتسويتها على
 *    المجمَّع الشهري عند وصول الحوالة إلى البنك، مع دفعات التحويل.
 * 2) تطبيقات التوصيل: قسم مستقل تماماً بتجميعه الشهري وتسويته الخاصة.
 * 3) تقرير نهاية الشهر وترحيل ما لم يُحوَّل إلى الشهر الجديد.
 * 4) سجل التسويات، ثم 5) إقفال الشهر والترحيل أو التصفير.
 *
 * معادلات التسوية الشهرية كلها في الخادم وما هنا عرض فقط:
 *   الأساس المستحق = مبيعات الشهر المجمّعة + المرحّل من الشهر السابق
 *   المتوقع خصمه   = الأساس × نسبة العقد ÷ 100
 *   الفرق          = المخصوم الفعلي − المتوقع
 *   المرحّل        = الأساس − المحوّل − المخصوم الفعلي
 * والمحوّل = مجموع دفعات التحويل إن سُجِّلت دفعات لا رقماً يكتبه أحد.
 *
 * والإجراءات مفصولة كما يفصلها الخادم بندَاً بندَاً، فلا يظهر زرٌّ سيُرفَض عند
 * الضغط: «إضافة» درجة 2، و«تعديل» درجة 3، و«اعتماد» درجة 4، و«حذف» خانة
 * مستقلة عن السلّم كله — ودفعات التحويل بندها المستقل عن بند التسوية نفسها.
 * ودخول الشاشة نفسه يُسجَّل في سجل التدقيق بمن دخل ومتى ومن أي عنوان.
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
  openPayments: { network: null, delivery_app: null },
};

/**
 * القدرة الفعلية على إجراء بعينه. الخادم يرسل الإجراءات مفصولة لكل بند
 * (اطلاع/إضافة/تعديل/اعتماد/حذف) فلا يُعرض زرٌّ سيُرفَض عند الضغط. وإن جاء
 * ردٌّ قديم بلا هذا التفصيل رجعنا إلى القدرة العامة حتى لا تختفي الأزرار
 * أثناء نشرٍ نصفه قديم.
 */
function can(name, fallbackName) {
  const caps = state.caps || {};
  if (typeof caps[name] === "boolean") return caps[name];
  return fallbackName ? Boolean(caps[fallbackName]) : false;
}

/** الحذف خانة مستقلة عن سلّم الدرجات: علم الخادم أولاً ثم درجة البند. */
function canDelete(name, moduleKey) {
  const caps = state.caps || {};
  if (typeof caps[name] === "boolean") return caps[name];
  return state.canDeleteIn(moduleKey);
}

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

/** النسبة الفعلية للخصم على الأساس المستحق — عرضاً لا حساباً معتمَداً. */
function actualRateOf(provider) {
  const base = Number(provider.settlementBase) || 0;
  if (base <= 0) return 0;
  return Math.round(((Number(provider.actualDeducted) || 0) / base) * 10000) / 100;
}

/**
 * تسوية شهر جهة واحدة — التسوية النهائية في نهاية الشهر.
 *
 * المبيعات لا تُرسل من هنا إطلاقاً: الخادم يجمعها من تقفيلات الشهر نفسه
 * ويضيف إليها المرحّل من الشهر السابق. والمطلوب من المحاسب:
 *   نسبة العقد → يُحسب منها المبلغ المتوقع خصمه
 *   المبلغ المخصوم الفعلي كما في كشف الجهة
 *   والمحوّل: مجموع دفعاته إن سُجِّلت دفعات، وإلا رقم واحد يُدخله.
 * ثم يحسب الخادم الفرق (فعلي − متوقع) والمرحّل إلى الشهر الجديد.
 */
async function settleMonth(type, provider) {
  const month = monthOf(type);
  const base = Number(provider.settlementBase) || 0;
  const hasPayments = (provider.paymentsCount || 0) > 0;

  let received = Number(provider.receivedAmount) || 0;
  if (!hasPayments) {
    const answer = window.prompt(
      "المبلغ الواصل إلى البنك عن " +
        provider.providerName +
        " في شهر " +
        month +
        "\nالأساس المستحق " +
        formatMoney(base) +
        " = مبيعات " +
        formatMoney(provider.monthlySales) +
        " + مرحّل " +
        formatMoney(provider.carriedInAmount),
      String(provider.receivedAmount || ""),
    );
    if (answer === null) return;
    received = Number(answer || 0);
  }

  const rate = window.prompt(
    "نسبة العقد % مع " +
      provider.providerName +
      " (منها يُحسب المبلغ المتوقع خصمه — صفر يعني بلا عقد):",
    String(provider.contractRate || 0),
  );
  if (rate === null) return;
  const expected = Number(rate || 0) > 0 ? (base * Number(rate)) / 100 : 0;

  const actual = window.prompt(
    "المبلغ المخصوم الفعلي كما في كشف " +
      provider.providerName +
      " (المتوقع بحسب العقد " +
      formatMoney(expected) +
      "):",
    String(provider.actualDeducted || ""),
  );
  if (actual === null) return;
  const actualAmount = Number(actual || 0);

  const vat = window.prompt(
    "نسبة الضريبة على العمولة % (اختياري — صفر يعني بلا ضريبة):",
    String(provider.vatRate || 0),
  );
  if (vat === null) return;

  const willCarry = Math.max(0, base - received - actualAmount);

  // التأكيد إجراء موافقة ببنده المستقل؛ من لا يملكه تُحفظ تسويته معلّقة
  const confirmed = state.caps.confirmSettlements
    ? window.confirm(
        "التسوية النهائية لـ" +
          provider.providerName +
          " لشهر " +
          month +
          ":\nالأساس " +
          formatMoney(base) +
          " — المحوّل " +
          formatMoney(received) +
          " — المخصوم الفعلي " +
          formatMoney(actualAmount) +
          " — المتوقع " +
          formatMoney(expected) +
          "\nسيُرحَّل إلى الشهر الجديد: " +
          formatMoney(willCarry) +
          "\n\nموافق = تأكيد وإقفال التسوية، إلغاء = حفظها بانتظار السداد",
      )
    : false;

  const body = {
    month,
    providerType: type,
    providerName: provider.providerName,
    contractRate: Number(rate || 0),
    actualDeducted: actualAmount,
    vatRate: Number(vat || 0),
    confirm: confirmed,
  };
  // مع وجود دفعات لا يُكتب رقم مجمّع فوقها
  if (!hasPayments) body.receivedAmount = received;

  const result = await api("/finance/settlements/monthly", {
    method: "POST",
    body: withBranchBody(body),
  });

  setAlert(
    el("cashbox-" + SECTIONS[type].key + "-result"),
    result.ok ? result.message : (result.error || "تعذّر حفظ التسوية الشهرية"),
    result.ok ? "ok" : "error",
  );

  if (result.ok) await refreshSettlementSections();
}

/* ── دفعات التحويل: إضافة مبالغ وتعديلها ─────────────────────── */

function paymentsBox(type) {
  return el("cashbox-" + SECTIONS[type].key + "-payments");
}

function closePayments(type) {
  state.openPayments[type] = null;
  const box = paymentsBox(type);
  if (box) box.hidden = true;
}

/**
 * إضافة مبلغ محوَّل: إن لم تكن للجهة تسوية في هذا الشهر أُنشئت أولاً بلا
 * تحويل ولا خصم (فيكون كامل الأساس بانتظار التحويل) ثم تُضاف الدفعة.
 */
async function addPayment(type, provider) {
  const month = monthOf(type);
  let settlementId = provider.settlementId;

  if (!settlementId) {
    const created = await api("/finance/settlements/monthly", {
      method: "POST",
      body: withBranchBody({
        month,
        providerType: type,
        providerName: provider.providerName,
        receivedAmount: 0,
        actualDeducted: 0,
        contractRate: Number(provider.contractRate) || 0,
      }),
    });
    if (!created.ok || !created.settlement) {
      setAlert(
        el("cashbox-" + SECTIONS[type].key + "-result"),
        created.error || "تعذّر تجهيز تسوية الشهر لإضافة المبلغ",
        "error",
      );
      return;
    }
    settlementId = created.settlement.id;
  }

  const amount = window.prompt(
    "مبلغ الدفعة الواصلة إلى البنك عن " + provider.providerName + ":",
    "",
  );
  if (amount === null) return;
  if (!(Number(amount) > 0)) {
    setAlert(
      el("cashbox-" + SECTIONS[type].key + "-result"),
      "مبلغ الدفعة مطلوب",
      "error",
    );
    return;
  }

  const date = window.prompt(
    "تاريخ وصول الدفعة (YYYY-MM-DD):",
    (state.meta && state.meta.today) || "",
  );
  if (date === null) return;

  const reference = window.prompt("رقم الحوالة أو المرجع (اختياري):", "");
  if (reference === null) return;

  const result = await api("/finance/settlements/" + settlementId + "/payments", {
    method: "POST",
    body: {
      amount: Number(amount),
      paymentDate: date,
      reference,
    },
  });

  setAlert(
    el("cashbox-" + SECTIONS[type].key + "-result"),
    result.ok ? result.message : (result.error || "تعذّر إضافة المبلغ"),
    result.ok ? "ok" : "error",
  );

  if (result.ok) {
    await refreshSettlementSections();
    await loadPayments(type, { ...provider, settlementId });
  }
}

/** تعديل دفعة محفوظة: مبلغها أو تاريخها أو مرجعها، ثم إعادة الحساب. */
async function editPayment(type, provider, payment) {
  const amount = window.prompt("مبلغ الدفعة:", String(payment.amount || ""));
  if (amount === null) return;
  const date = window.prompt("تاريخ وصول الدفعة (YYYY-MM-DD):", payment.paymentDate || "");
  if (date === null) return;
  const reference = window.prompt("المرجع / رقم الحوالة:", payment.reference || "");
  if (reference === null) return;

  const result = await api("/finance/settlements/payments/" + payment.id, {
    method: "PATCH",
    body: { amount: Number(amount || 0), paymentDate: date, reference },
  });

  setAlert(
    el("cashbox-" + SECTIONS[type].key + "-payments-result"),
    result.ok ? result.message : (result.error || "تعذّر تعديل الدفعة"),
    result.ok ? "ok" : "error",
  );

  if (result.ok) {
    await refreshSettlementSections();
    await loadPayments(type, provider);
  }
}

/** حذف دفعة أُدخلت خطأً — بخانة الحذف المستقلة وحدها. */
async function removePayment(type, provider, payment) {
  if (
    !window.confirm(
      "حذف دفعة " +
        formatMoney(payment.amount) +
        " بتاريخ " +
        payment.paymentDate +
        "؟ سيُعاد حساب المحوّل والمرحّل.",
    )
  )
    return;

  const result = await api("/finance/settlements/payments/" + payment.id, {
    method: "DELETE",
  });

  setAlert(
    el("cashbox-" + SECTIONS[type].key + "-payments-result"),
    result.ok ? result.message : (result.error || "تعذّر حذف الدفعة"),
    result.ok ? "ok" : "error",
  );

  if (result.ok) {
    await refreshSettlementSections();
    await loadPayments(type, provider);
  }
}

/** لوحة دفعات جهة واحدة: كل دفعة بتاريخها ومرجعها مرئية للمراجعة. */
async function loadPayments(type, provider) {
  const meta = SECTIONS[type];
  const box = paymentsBox(type);
  if (!box) return;

  if (!provider || !provider.settlementId) {
    closePayments(type);
    return;
  }

  const result = await api("/finance/settlements/" + provider.settlementId + "/payments");
  if (!result.ok) {
    setAlert(
      el("cashbox-" + meta.key + "-payments-result"),
      result.error || "تعذّر قراءة الدفعات",
      "error",
    );
    return;
  }

  state.openPayments[type] = provider;
  box.hidden = false;
  el("cashbox-" + meta.key + "-payments-title").textContent =
    "دفعات التحويل — " +
    provider.providerName +
    " / شهر " +
    (result.month || monthOf(type)) +
    " (المجموع " +
    formatMoney(result.totals && result.totals.amount) +
    ")";

  const payments = result.payments || [];
  const body = el("cashbox-" + meta.key + "-payments-table").querySelector("tbody");
  const editable = provider.status !== "confirmed";
  const mayEditPayment = editable && can("editPayments", "manageSettlements");
  const mayDeletePayment = editable && canDelete("deletePayments", "settlements");

  body.replaceChildren(
    ...payments.map((payment) => {
      const actions = document.createElement("span");
      actions.className = "row-actions";
      if (mayEditPayment) {
        actions.append(
          button("تعديل", {
            className: "btn btn--ghost btn--xs",
            onClick: () => editPayment(type, provider, payment),
          }),
        );
      }
      if (mayDeletePayment) {
        actions.append(
          button("حذف", {
            className: "btn btn--danger btn--xs",
            onClick: () => removePayment(type, provider, payment),
          }),
        );
      }
      return row([
        payment.paymentDate,
        formatMoney(payment.amount),
        payment.reference || "—",
        payment.notes || "—",
        actions,
      ]);
    }),
  );

  el("cashbox-" + meta.key + "-payments-empty").hidden = payments.length > 0;
  setAlert(el("cashbox-" + meta.key + "-payments-result"), "");
}

/**
 * قسم نوع واحد: لكل جهة مبيعاتها المجمّعة على الشهر، والمرحّل الداخل،
 * والأساس المستحق، ونسبة العقد، والمتوقع خصمه، والمخصوم الفعلي، والفرق،
 * والمحوّل فعلاً بعدد دفعاته، وما سيُرحَّل إلى الشهر الجديد.
 *
 * الشبكات وتطبيقات التوصيل لا يختلطان في جدول واحد.
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

      // المؤكَّدة لا تُعدَّل، والتسجيل أول مرة «إضافة» وما بعده «تعديل»
      const editable = provider.status !== "confirmed";
      const mayWrite = provider.settlementId
        ? can("editSettlements", "manageSettlements")
        : can("addSettlements", "manageSettlements");
      const pendingRow = provider.status === "pending";

      if (editable && mayWrite) {
        actions.append(
          button(provider.settlementId ? "تعديل التسوية" : "إضافة تسوية الشهر", {
            className: "btn btn--primary btn--xs",
            onClick: () => settleMonth(type, provider),
          }),
        );
      }
      if (editable && can("addPayments", "manageSettlements")) {
        actions.append(
          button("إضافة مبلغ", {
            className: "btn btn--ghost btn--xs",
            onClick: () => addPayment(type, provider),
          }),
        );
      }
      if (
        provider.settlementId &&
        pendingRow &&
        can("approveSettlements", "confirmSettlements")
      ) {
        actions.append(
          button("اعتماد", {
            className: "btn btn--primary btn--xs",
            onClick: () =>
              approveSettlement(
                {
                  id: provider.settlementId,
                  providerName: provider.providerName,
                  receivedAmount: provider.receivedAmount,
                },
                "cashbox-" + meta.key + "-result",
              ),
          }),
        );
      }
      if (
        provider.settlementId &&
        pendingRow &&
        canDelete("deleteSettlements", "settlements")
      ) {
        actions.append(
          button("حذف", {
            className: "btn btn--danger btn--xs",
            onClick: () =>
              removeSettlement({
                id: provider.settlementId,
                providerName: provider.providerName,
              }),
          }),
        );
      }
      if (provider.settlementId && can("viewPayments", "readSettlements")) {
        actions.append(
          button("الدفعات (" + String(provider.paymentsCount || 0) + ")", {
            className: "btn btn--ghost btn--xs",
            onClick: () => loadPayments(type, provider),
          }),
        );
      }

      return row([
        provider.providerName,
        formatMoney(provider.monthlySales),
        formatMoney(provider.carriedInAmount),
        formatMoney(provider.settlementBase),
        provider.contractRate ? String(provider.contractRate) + "%" : "—",
        provider.contractRate ? formatMoney(provider.expectedAmount) : "—",
        formatMoney(provider.actualDeducted),
        provider.contractRate ? moneyCell(provider.varianceAmount, true) : "—",
        formatMoney(provider.receivedAmount) +
          (provider.paymentsCount ? " (" + String(provider.paymentsCount) + ")" : ""),
        formatMoney(provider.carriedOutAmount),
        String(actualRateOf(provider)) + "%",
        SETTLEMENT_STATUS[provider.status] || provider.status,
        actions,
      ]);
    }),
  );

  el("cashbox-" + meta.key + "-empty").hidden = providers.length > 0;

  // لوحة الدفعات المفتوحة تتحدّث مع القسم فلا تبقى على رقم قديم
  const open = state.openPayments[type];
  if (open) {
    const fresh = providers.find((item) => item.providerName === open.providerName);
    if (fresh && fresh.settlementId) await loadPayments(type, fresh);
    else closePayments(type);
  }

  const totals = result.totals || {};
  chipsInto("cashbox-" + meta.key + "-chips", [
    ["الشهر", result.month || monthOf(type)],
    ["مبيعات الشهر المجمّعة", formatMoney(totals.monthlySales)],
    ["مرحّل من السابق", formatMoney(totals.carriedInAmount)],
    ["الأساس المستحق", formatMoney(totals.settlementBase)],
    ["المتوقع خصمه", formatMoney(totals.expectedAmount)],
    ["المخصوم الفعلي", formatMoney(totals.actualDeducted)],
    ["الفرق", formatMoney(totals.varianceAmount)],
    ["المحوّل فعلاً", formatMoney(totals.receivedAmount)],
    ["سيُرحَّل للشهر الجديد", formatMoney(totals.carriedOutAmount)],
    ["بانتظار السداد", String(totals.pending || 0)],
    ["الشهر منتهٍ", result.isMonthEnded ? "نعم" : "لا"],
  ]);
  setAlert(el("cashbox-" + meta.key + "-result"), "");
}

/* ── تقرير نهاية الشهر وترحيل غير المحوّل ─────────────────────── */

function reportMonth() {
  const node = el("cashbox-report-month");
  return (node && node.value) || currentMonthKey();
}

/**
 * تقرير الشهر: القسمان في مستند واحد بلا اختلاط، ومعه ما سيُرحَّل.
 */
async function loadReport() {
  if (!state.caps.readSettlements) return;
  const params = withBranch(new URLSearchParams());
  params.set("month", reportMonth());

  const result = await api("/finance/settlements/monthly/report" + query(params));
  const body = el("cashbox-report-table").querySelector("tbody");

  if (!result.ok) {
    body.replaceChildren();
    chipsInto("cashbox-report-chips", []);
    setAlert(
      el("cashbox-report-result"),
      result.error || "تعذّر توليد تقرير نهاية الشهر",
      "error",
    );
    return;
  }

  const sections = result.sections || [];
  const rows = [];
  for (const section of sections) {
    for (const provider of section.providers || []) {
      rows.push(
        row([
          section.label,
          provider.providerName,
          formatMoney(provider.monthlySales),
          formatMoney(provider.carriedInAmount),
          formatMoney(provider.settlementBase),
          provider.contractRate ? String(provider.contractRate) + "%" : "—",
          provider.contractRate ? formatMoney(provider.expectedAmount) : "—",
          formatMoney(provider.actualDeducted),
          provider.contractRate ? moneyCell(provider.varianceAmount, true) : "—",
          formatMoney(provider.receivedAmount),
          formatMoney(provider.carriedOutAmount),
          SETTLEMENT_STATUS[provider.status] || provider.status,
        ]),
      );
    }
  }
  body.replaceChildren(...rows);
  el("cashbox-report-empty").hidden = rows.length > 0;

  const totals = result.totals || {};
  const chips = [
    ["الشهر", result.month || reportMonth()],
    ["الشهر الجديد", result.nextMonth || "—"],
    ["الشهر منتهٍ", result.isMonthEnded ? "نعم" : "لا"],
    ["الأساس المستحق", formatMoney(totals.settlementBase)],
    ["المتوقع خصمه", formatMoney(totals.expectedAmount)],
    ["المخصوم الفعلي", formatMoney(totals.actualDeducted)],
    ["الفرق", formatMoney(totals.varianceAmount)],
    ["المحوّل فعلاً", formatMoney(totals.receivedAmount)],
    ["المرحّل للشهر الجديد", formatMoney(totals.carriedOutAmount)],
    ["بانتظار الترحيل", formatMoney(result.pendingCarry)],
  ];
  for (const section of sections) {
    chips.push([
      "أساس " + section.label,
      formatMoney(section.totals && section.totals.settlementBase),
    ]);
  }
  chipsInto("cashbox-report-chips", chips);

  const carryButton = el("cashbox-report-carry");
  if (carryButton) {
    carryButton.hidden = !can("addSettlements", "manageSettlements");
    carryButton.disabled = Number(result.pendingCarry || 0) <= 0;
  }

  setAlert(
    el("cashbox-report-result"),
    Number(result.pendingCarry || 0) > 0
      ? "لم يُرحَّل بعد " +
          formatMoney(result.pendingCarry) +
          " إلى شهر " +
          (result.nextMonth || "") +
          (result.isMonthEnded
            ? ""
            : " — والشهر لم ينته بعد، والتسوية النهائية تقع في نهايته.")
      : "",
    Number(result.pendingCarry || 0) > 0 ? "warn" : "ok",
  );
}

/**
 * ترحيل ما لم يُحوَّل إلى الشهر الجديد لكل الشبكات والتطبيقات.
 *
 * إضافة لا حذف: لا يُمسّ صفّ الشهر المصدر إلا بوسم «رُحّل إلى»، وتكرار
 * الزر لا يضاعف مبلغاً لأن المُرحَّل مسبقاً يُتجاوز.
 */
async function carryForwardSettlements() {
  const month = reportMonth();
  if (
    !window.confirm(
      "ترحيل كل المبالغ التي لم تتم تحويلها في شهر " +
        month +
        " إلى الشهر الجديد، لكل الشبكات وتطبيقات التوصيل؟\n\nلا تُحذف ولا تُعدَّل" +
        " أي بيانات سابقة، والتكرار لا يضاعف مبلغاً.",
    )
  )
    return;

  const node = el("cashbox-report-carry");
  setBusy(node, true);
  const result = await api("/finance/settlements/monthly/carry-forward", {
    method: "POST",
    body: withBranchBody({ month }),
  });
  setBusy(node, false);

  setAlert(
    el("cashbox-report-result"),
    result.ok ? result.message : (result.error || "تعذّر ترحيل المبالغ"),
    result.ok ? "ok" : "error",
  );

  if (result.ok) await refreshSettlementSections();
}

/* ══ الاعتماد والتعديل والحذف — كل إجراء ببنده ═════════════════════ */

/**
 * اعتماد تسوية: الدرجة الرابعة في بند التسويات وحدها تفتحه. وبعد الاعتماد
 * تُقفَل التسوية فلا تُعدَّل، فيُعرض على المعتمِد رقم المحوّل ليؤكّد أنه ما
 * وصل البنك فعلاً — ومع وجود دفعات مسجّلة يُهمَل الرقم ويُعتمد مجموعها.
 */
async function approveSettlement(settlement, resultNodeId) {
  const received = window.prompt(
    "اعتماد تسوية " +
      settlement.providerName +
      ":\nالمبلغ المحوّل للبنك (يُهمَل إن كانت هناك دفعات مسجّلة):",
    String(settlement.receivedAmount || 0),
  );
  if (received === null) return;
  if (
    !window.confirm(
      "بعد الاعتماد تُقفَل التسوية ولا تُعدَّل، ويُسجَّل الاعتماد باسمك في سجل التدقيق.\nمتابعة اعتماد " +
        settlement.providerName +
        "؟",
    )
  ) {
    return;
  }

  const result = await api("/finance/settlements/" + settlement.id + "/confirm", {
    method: "POST",
    body: { receivedAmount: Number(received || 0) },
  });
  setAlert(
    el(resultNodeId || "cashbox-settlements-result"),
    result.ok ? (result.message || "تم الاعتماد") : (result.error || "تعذّر الاعتماد"),
    result.ok ? "ok" : "error",
  );
  if (result.ok) await refreshSettlementSections();
}

/**
 * تعديل تسوية قائمة من السجل: نسبة العقد والمخصوم الفعلي والمحوّل والضريبة.
 * درجة «تعديل» وحدها تفتحه، والمؤكَّدة لا تُعدَّل — تُحذف وتُعاد إن لزم.
 */
async function editSettlementRow(settlement) {
  const rate = window.prompt(
    "نسبة العقد % لـ" + settlement.providerName + " (صفر = بلا نسبة):",
    String(settlement.contractRate || 0),
  );
  if (rate === null) return;

  const actual = window.prompt(
    "المخصوم الفعلي كما في كشف الجهة (اتركه فارغاً لإبقاء الحساب على سلوكه):",
    String(settlement.actualDeducted || ""),
  );
  if (actual === null) return;

  const received = window.prompt(
    "المحوّل للبنك (يُهمَل إن كانت هناك دفعات مسجّلة):",
    String(settlement.receivedAmount || 0),
  );
  if (received === null) return;

  const vat = window.prompt(
    "نسبة الضريبة على العمولة % (صفر = بلا ضريبة):",
    String(settlement.vatRate || 0),
  );
  if (vat === null) return;

  const body = {
    contractRate: Number(rate || 0),
    receivedAmount: Number(received || 0),
    vatRate: Number(vat || 0),
  };
  if (String(actual).trim() !== "") body.actualDeducted = Number(actual);

  const result = await api("/finance/settlements/" + settlement.id, {
    method: "PATCH",
    body,
  });
  setAlert(
    el("cashbox-settlements-result"),
    result.ok ? (result.message || "تم التعديل") : (result.error || "تعذّر التعديل"),
    result.ok ? "ok" : "error",
  );
  if (result.ok) await refreshSettlementSections();
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

    // الإجراءات الثلاثة على السجل، كلٌّ ببنده ودرجته — والمؤكَّدة لا تُمَس
    const pending = settlement.status === "pending";
    if (pending && can("editSettlements", "manageSettlements")) {
      actions.append(
        button("تعديل", {
          className: "btn btn--ghost btn--xs",
          onClick: () => editSettlementRow(settlement),
        }),
      );
    }
    if (pending && can("approveSettlements", "confirmSettlements")) {
      actions.append(
        button("اعتماد", {
          className: "btn btn--primary btn--xs",
          onClick: () => approveSettlement(settlement, "cashbox-settlements-result"),
        }),
      );
    }
    if (pending && canDelete("deleteSettlements", "settlements")) {
      actions.append(
        button("حذف", {
          className: "btn btn--danger btn--xs",
          onClick: () => removeSettlement(settlement),
        }),
      );
    }

    const base =
      (Number(settlement.salesAmount) || 0) + (Number(settlement.carriedInAmount) || 0);

    return row([
      settlement.providerName,
      PROVIDER_LABELS[settlement.providerType] || settlement.providerType,
      String(settlement.periodFrom).slice(0, 7),
      formatMoney(settlement.salesAmount),
      formatMoney(settlement.carriedInAmount),
      formatMoney(base),
      settlement.contractRate ? String(settlement.contractRate) + "%" : "—",
      settlement.contractRate ? formatMoney(settlement.expectedAmount) : "—",
      formatMoney(settlement.actualDeducted),
      settlement.contractRate ? moneyCell(settlement.varianceAmount, true) : "—",
      formatMoney(settlement.receivedAmount),
      formatMoney(settlement.carriedOutAmount),
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
    ["مرحّل داخل", formatMoney(summary.carriedInAmount)],
    ["المتوقع خصمه", formatMoney(summary.expectedAmount)],
    ["المخصوم الفعلي", formatMoney(summary.actualDeducted)],
    ["الفرق", formatMoney(summary.varianceAmount)],
    ["مرحّل للشهر التالي", formatMoney(summary.carriedOutAmount)],
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
    loadReport(),
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
  el("cashbox-report-card").hidden = !state.caps.readSettlements;
  el("cashbox-settlements-card").hidden = !state.caps.readSettlements;
  el("cashbox-months-card").hidden = !state.caps.viewMonthlySummary;
  el("cashbox-prepare-row").hidden = !state.caps.viewMonthlySummary;

  // «إضافة مبلغ» في رأس لوحة الدفعات بندها المستقل عن بند التسوية
  const mayAddPayment = can("addPayments", "manageSettlements");
  for (const type of ["network", "delivery_app"]) {
    el("cashbox-" + SECTIONS[type].key + "-payments-add").hidden = !mayAddPayment;
  }
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

  el("cashbox-report-run").addEventListener("click", loadReport);
  el("cashbox-report-month").addEventListener("change", loadReport);
  el("cashbox-report-carry").addEventListener("click", carryForwardSettlements);

  for (const type of ["network", "delivery_app"]) {
    const key = SECTIONS[type].key;
    el("cashbox-" + key + "-payments-close").addEventListener("click", () =>
      closePayments(type),
    );
    el("cashbox-" + key + "-payments-add").addEventListener("click", () => {
      const open = state.openPayments[type];
      if (open) addPayment(type, open);
    });
  }

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
  if (!el("cashbox-report-month").value) el("cashbox-report-month").value = month;
  if (!el("cashbox-year").value) el("cashbox-year").value = today.slice(0, 4);
  if (!el("cashbox-prepare-month").value) el("cashbox-prepare-month").value = month;

  el("cashbox-decision-hint").hidden = state.caps.carryForward || state.caps.resetBalance;

  await loadNotifications();
  if (state.caps.readSettlements) await refreshSettlementSections();
  if (state.caps.viewMonthlySummary) await loadMonthClosings();
}
