/**
 * حزمة النماذج المطبوعة: يختار المستخدم النموذج والموظف (والسجل المرجعي أو
 * الشهر عند الحاجة) فتُفتح صفحة الطباعة مُملّأة تلقائياً من ملف الموظف.
 *
 * الشاشة تضم كذلك إدارة الإنذارات التأديبية (مصدر بيانات نموذج الإنذار)،
 * وسجل النماذج المُصدرة.
 */

import {
  api,
  button,
  el,
  formatDateTime,
  formatMoney,
  openDocument,
  row,
  setAlert,
  setBusy,
  todayIso,
} from "../api.js";
import { createPager } from "../pagination.js";

/** تقسيم صفحات جدولي الإنذارات وسجل النماذج المُصدرة. */
const actionsPager = createPager("disc-table", { unit: "إنذار" });
const issuesPager = createPager("doc-issues-table", { unit: "مستند" });

const LEVEL_LABELS = {
  notice: "تنبيه",
  first: "إنذار أول",
  second: "إنذار ثانٍ",
  final: "إنذار نهائي",
  suspension: "إيقاف عن العمل",
};

const DISCIPLINARY_STATUS = {
  draft: "مسودّة",
  issued: "صادر",
  acknowledged: "مُستلم بالتوقيع",
  cancelled: "ملغى",
};

const state = {
  can: () => false,
  /** درجة المستخدم في بنود «المستندات» و«الجزاءات» (0..4) من الخادم. */
  levelOf: () => 0,
  /** درجة الحذف المستقلة في هذين البندين. */
  canDeleteIn: () => false,
  documents: [],
  current: null,
  actions: [],
  issues: [],
  editingActionId: null,
};

/* ── اختيار النموذج ────────────────────────────────────────────── */

function fillCatalog() {
  const picker = el("doc-kind");
  picker.textContent = "";

  // نجمّع النماذج حسب المجموعة ليسهل العثور عليها في القائمة
  const groups = new Map();
  for (const doc of state.documents) {
    if (!groups.has(doc.group)) groups.set(doc.group, []);
    groups.get(doc.group).push(doc);
  }

  for (const [group, docs] of groups) {
    const optgroup = document.createElement("optgroup");
    optgroup.label = group;
    for (const doc of docs) {
      const option = document.createElement("option");
      option.value = doc.key;
      option.textContent = doc.title;
      optgroup.append(option);
    }
    picker.append(optgroup);
  }
}

/** يُظهر/يُخفي حقول النموذج حسب ما يحتاجه القالب المختار. */
async function onDocChange() {
  state.current = state.documents.find((doc) => doc.key === el("doc-kind").value) ?? null;
  const doc = state.current;
  if (!doc) return;

  el("doc-description").textContent = doc.description;
  el("doc-employee-field").hidden = !doc.needsEmployee;
  el("doc-month-field").hidden = !doc.needsMonth;
  el("doc-ref-field").hidden = !doc.refType;
  el("doc-legal-hint").hidden = !doc.legal;
  // كشوف الفرع (مثل ملف التحضير والانصراف) تحتاج فرعاً وتاريخاً بدل الموظف
  el("doc-branch-field").hidden = !doc.needsBranch;
  el("doc-date-field").hidden = !doc.needsDate;
  el("doc-from-field").hidden = !doc.needsRange;
  el("doc-to-field").hidden = !doc.needsRange;

  if (doc.refType) {
    el("doc-ref-label").textContent = doc.refLabel;
    await loadReferences();
  }
}

async function loadReferences() {
  const doc = state.current;
  const picker = el("doc-ref");
  picker.textContent = "";

  if (!doc?.refType) return;

  const employeeId = el("doc-employee").value;
  const query = new URLSearchParams({ doc: doc.key });
  if (employeeId) query.set("employeeId", employeeId);

  const result = await api(`/documents/references?${query.toString()}`);

  const none = document.createElement("option");
  none.value = "";
  none.textContent = result.ok && result.references?.length ? "— بدون سجل مرتبط —" : "لا توجد سجلات";
  picker.append(none);

  for (const reference of result.references ?? []) {
    const option = document.createElement("option");
    option.value = String(reference.id);
    option.textContent = reference.label;
    picker.append(option);
  }
}

function printSelected() {
  const doc = state.current;
  if (!doc) return;

  const employeeId = el("doc-employee").value;
  if (doc.needsEmployee && !employeeId) {
    setAlert(el("doc-result"), "اختر الموظف أولاً.", "warn");
    return;
  }

  const opened = openDocument(doc.key, {
    employeeId: doc.needsEmployee ? employeeId : "",
    refId: doc.refType ? el("doc-ref").value : "",
    month: doc.needsMonth ? el("doc-month").value : "",
    branchId: doc.needsBranch ? el("doc-branch").value : "",
    date: doc.needsDate ? el("doc-date").value : "",
    from: doc.needsRange ? el("doc-from").value : "",
    to: doc.needsRange ? el("doc-to").value : "",
  });

  setAlert(
    el("doc-result"),
    opened === "tab"
      ? "فُتحت صفحة الطباعة في تبويب جديد."
      : "جارٍ فتح صفحة الطباعة… استخدم زر «رجوع» فيها للعودة إلى هذه الشاشة.",
    "ok",
  );

  // سجل الإصدار يُكتب من صفحة الطباعة نفسها؛ نُحدّث القائمة بعد لحظة
  window.setTimeout(loadIssues, 2500);
}

/* ── الإنذارات التأديبية ───────────────────────────────────────── */

function fillActionForm(action) {
  el("disc-employee").value = action ? String(action.employeeId) : "";
  el("disc-level").value = action?.level ?? "first";
  el("disc-date").value = action?.incidentDate ?? todayIso();
  el("disc-violation").value = action?.violationType ?? "";
  el("disc-description").value = action?.incidentDescription ?? "";
  el("disc-action").value = action?.actionTaken ?? "";
  el("disc-deduction").value = action?.deductionAmount ?? 0;
  el("disc-status").value = action?.status ?? "issued";
  el("disc-notes").value = action?.notes ?? "";

  state.editingActionId = action?.id ?? null;
  el("disc-submit").textContent = action ? "حفظ التعديل" : "تسجيل الإنذار";
  el("disc-cancel").hidden = !action;
}

async function submitAction(event) {
  event.preventDefault();
  const submit = el("disc-submit");
  setBusy(submit, true);

  const body = {
    employeeId: Number(el("disc-employee").value),
    level: el("disc-level").value,
    incidentDate: el("disc-date").value,
    violationType: el("disc-violation").value.trim(),
    incidentDescription: el("disc-description").value.trim(),
    actionTaken: el("disc-action").value.trim(),
    deductionAmount: Number(el("disc-deduction").value || 0),
    status: el("disc-status").value,
    notes: el("disc-notes").value.trim(),
  };

  const result = state.editingActionId
    ? await api(`/disciplinary/${state.editingActionId}`, { method: "PATCH", body })
    : await api("/disciplinary", { method: "POST", body });

  setBusy(submit, false);
  setAlert(
    el("disc-result"),
    result.ok ? "تم حفظ الإنذار." : (result.error ?? "تعذّر الحفظ"),
    result.ok ? "ok" : "error",
  );

  if (result.ok) {
    fillActionForm(null);
    await loadActions();
  }
}

async function removeAction(action) {
  if (!window.confirm(`حذف الإنذار الصادر بتاريخ ${action.incidentDate}؟`)) return;
  const result = await api(`/disciplinary/${action.id}`, { method: "DELETE" });
  setAlert(
    el("disc-result"),
    result.ok ? result.message : (result.error ?? "تعذّر الحذف"),
    result.ok ? "ok" : "error",
  );
  if (result.ok) await loadActions();
}

function renderActions() {
  const canManage = state.can("disciplinary.manage");
  // التعديل يحتاج الدرجة الثالثة والتسجيل يكفيه الثانية، والحذف درجة مستقلة
  const canEdit = canManage && state.levelOf("disciplinary") >= 3;
  const canRemove = canManage && state.canDeleteIn("disciplinary");

  actionsPager.render(state.actions, (action) => {
    const actions = document.createElement("span");
    actions.className = "row-actions";

    actions.append(
      button("طباعة", {
        onClick: () =>
          openDocument("warning", { employeeId: action.employeeId, refId: action.id }),
      }),
    );

    if (canEdit) {
      actions.append(
        button("تعديل", {
          onClick: () => {
            fillActionForm(action);
            el("disc-form").scrollIntoView({ behavior: "smooth", block: "center" });
          },
        }),
      );
    }

    if (canRemove) {
      actions.append(
        button("حذف", {
          className: "btn btn--danger btn--xs",
          onClick: () => removeAction(action),
        }),
      );
    }

    return row([
      action.incidentDate,
      `${action.employeeCode ?? ""} — ${action.employeeName ?? ""}`,
      LEVEL_LABELS[action.level] ?? action.level,
      action.violationType || "—",
      action.incidentDescription,
      formatMoney(action.deductionAmount),
      DISCIPLINARY_STATUS[action.status] ?? action.status,
      actions,
    ]);
  });

  el("disc-empty").hidden = state.actions.length > 0;
  el("disc-form").hidden = !canManage;
}

export async function loadActions() {
  const employeeId = el("disc-filter-employee").value;
  const result = await api(`/disciplinary${employeeId ? `?employeeId=${employeeId}` : ""}`);

  if (!result.ok) {
    state.actions = [];
    renderActions();
    setAlert(el("disc-result"), result.error ?? "تعذّر تحميل الإنذارات", "error");
    return;
  }

  state.actions = result.actions ?? [];
  renderActions();
}

/* ── سجل النماذج المُصدرة ──────────────────────────────────────── */

function renderIssues() {
  // حذف سجلّات الإصدار وتنظيفها من درجة الحذف المستقلة في بند «المستندات»
  const canClean = state.can("documents.read_all") && state.canDeleteIn("documents");

  issuesPager.render(state.issues, (issue) =>
    row([
      formatDateTime(issue.issuedAt),
      issue.docTitle,
      issue.employeeName ? `${issue.employeeCode ?? ""} — ${issue.employeeName}` : "—",
      issue.branchName ?? "—",
      issue.issuedByName ?? "—",
      canClean
        ? button("حذف", {
            className: "btn btn--danger btn--xs",
            onClick: () => removeIssue(issue),
          })
        : "",
    ]),
  );

  el("doc-issues-empty").hidden = state.issues.length > 0;
  el("doc-issues-purge").hidden = !canClean;
}

/** حذف سطر واحد من السجل — للمستندات التجريبية أو الخاطئة. */
async function removeIssue(issue) {
  if (!window.confirm(`حذف سجل «${issue.docTitle}» الصادر في ${formatDateTime(issue.issuedAt)}؟`)) {
    return;
  }

  const reason = window.prompt("سبب الحذف (يُسجَّل في التدقيق):", "") ?? "";
  const result = await api(`/documents/issues/${issue.id}`, {
    method: "DELETE",
    body: { reason },
  });

  setAlert(
    el("doc-issues-result"),
    result.ok ? result.message : (result.error ?? "تعذّر الحذف"),
    result.ok ? "ok" : "error",
  );

  if (result.ok) await loadIssues();
}

/** حذف جماعي للسجل: ما قبل تاريخ، أو مستندات الحسابات التجريبية، أو الكل. */
async function purgeIssues() {
  const scope = el("doc-issues-purge-scope").value;
  const before = el("doc-issues-purge-before").value;

  if (scope === "before" && !before) {
    setAlert(el("doc-issues-result"), "حدّد التاريخ الذي يُحذف ما قبله.", "error");
    return;
  }

  const confirmed = window.prompt(
    "حذف جماعي لسجل النماذج المُصدرة — العملية نهائية.\nاكتب كلمة «حذف» للتأكيد:",
    "",
  );
  if (confirmed === null) return;

  const reason = window.prompt("سبب الحذف (يُسجَّل في التدقيق):", "تنظيف سجل التجربة") ?? "";
  const runner = el("doc-issues-purge-run");
  setBusy(runner, true);

  const result = await api("/documents/issues/purge", {
    method: "POST",
    body: {
      scope,
      ...(scope === "before" ? { before } : {}),
      confirm: confirmed.trim(),
      reason,
    },
  });

  setBusy(runner, false);
  setAlert(
    el("doc-issues-result"),
    result.ok ? result.message : (result.error ?? "تعذّر الحذف"),
    result.ok ? "ok" : "error",
  );

  if (result.ok) await loadIssues();
}

export async function loadIssues() {
  const params = new URLSearchParams();
  const employeeId = el("doc-issues-employee").value;
  const docType = el("doc-issues-kind").value;
  if (employeeId) params.set("employeeId", employeeId);
  if (docType) params.set("doc", docType);

  const query = params.toString();
  const result = await api(`/documents/issues${query ? `?${query}` : ""}`);

  if (!result.ok) {
    state.issues = [];
    renderIssues();
    return;
  }

  state.issues = result.issues ?? [];
  renderIssues();
}

function fillIssuesKindPicker() {
  const picker = el("doc-issues-kind");
  picker.textContent = "";
  const all = document.createElement("option");
  all.value = "";
  all.textContent = "كل النماذج";
  picker.append(all);

  for (const doc of state.documents) {
    const option = document.createElement("option");
    option.value = doc.key;
    option.textContent = doc.title;
    picker.append(option);
  }
}

/* ── التهيئة ───────────────────────────────────────────────────── */

export function initDocumentsModule({ can, levelOf, canDeleteIn }) {
  state.can = can;
  if (levelOf) state.levelOf = levelOf;
  if (canDeleteIn) state.canDeleteIn = canDeleteIn;

  el("doc-kind").addEventListener("change", onDocChange);
  el("doc-employee").addEventListener("change", loadReferences);
  el("doc-print").addEventListener("click", printSelected);

  el("disc-form").addEventListener("submit", submitAction);
  el("disc-cancel").addEventListener("click", () => fillActionForm(null));
  el("disc-filter-run").addEventListener("click", loadActions);

  el("doc-issues-run").addEventListener("click", loadIssues);
  el("doc-issues-purge-run").addEventListener("click", purgeIssues);
  el("doc-issues-purge-scope").addEventListener("change", () => {
    el("doc-issues-purge-date-wrap").hidden = el("doc-issues-purge-scope").value !== "before";
    setAlert(el("doc-issues-result"), "");
  });

  el("doc-month").value = todayIso().slice(0, 7);
  el("doc-date").value = todayIso();
  el("doc-from").value = todayIso();
  el("doc-to").value = todayIso();
  el("disc-date").value = todayIso();
}

export async function refreshDocumentsPanel() {
  if (state.documents.length === 0) {
    const catalog = await api("/documents/catalog");
    if (!catalog.ok) {
      setAlert(el("doc-result"), catalog.error ?? "تعذّر تحميل دليل النماذج", "error");
      return;
    }

    state.documents = catalog.documents ?? [];
    fillCatalog();
    fillIssuesKindPicker();
    el("doc-legal-notice").textContent = catalog.legalNotice ?? "";

    if (!catalog.canPrintForOthers) {
      setAlert(el("doc-result"), "يمكنك طباعة نماذج ملفك الشخصي فقط حسب صلاحياتك.", "warn");
    }

    await onDocChange();
  }

  await Promise.all([loadActions(), loadIssues()]);
}
