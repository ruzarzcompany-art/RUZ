/**
 * لوحة الموارد البشرية: الحضور اليدوي والتصحيحات، النماذج والاعتمادات،
 * تعريف الرواتب ومسيّراتها، بصمات الوجه، وسجل التدقيق.
 *
 * كل شاشة تُخفى إن لم يملك المستخدم صلاحيتها — والخادم يفرض الصلاحية أيضاً.
 */

import {
  api,
  button,
  clearActivity,
  currentMonthKey,
  DEFAULT_IDLE_SECONDS,
  el,
  formatDateTime,
  formatMoney,
  getToken,
  idleExceeded,
  label,
  loadRuntimeConfig,
  markActivity,
  onSessionExpired,
  openPrint,
  requireLogin,
  row,
  setAlert,
  setBusy,
  setToken,
  startIdleWatch,
  stopIdleWatch,
  toLocalInputValue,
} from "../api.js";
import {
  collectFormValues,
  LIST_COLUMNS,
  loadFormsSchema,
  renderFormFields,
} from "../forms-ui.js";
import {
  employeeRowActions,
  fillPeopleSelects,
  initPeopleModule,
  loadPeopleMeta,
  refreshBranchesPanel,
  refreshSchedules,
} from "./people.js";
import { initReportsModule } from "./reports.js";
import { initSettingsModule, refreshSettingsPanel } from "./settings.js";
import { initCashierModule, refreshCashierPanel } from "./cashier.js";
import { initInventoryModule, refreshInventoryPanel } from "./inventory.js";
import { initDocumentsModule, refreshDocumentsPanel } from "./documents.js";

const state = {
  permissions: [],
  employees: [],
  branches: [],
  schema: null,
  formsResource: "advances",
  editingLogId: null,
  correctingLogId: null,
  idleSeconds: DEFAULT_IDLE_SECONDS,
};

const can = (code) => state.permissions.includes(code);

/* ── تعبئة القوائم المنسدلة ───────────────────────────────── */

function fillEmployees(select, { includeAll = false, includeEmpty = false, placeholder } = {}) {
  if (!select) return;
  select.textContent = "";

  if (placeholder || includeAll || includeEmpty) {
    const option = document.createElement("option");
    option.value = "";
    option.textContent = placeholder ?? (includeAll ? "الكل" : "بدون موظف");
    select.append(option);
  }

  for (const employee of state.employees) {
    const option = document.createElement("option");
    option.value = String(employee.id);
    option.textContent = `${employee.employeeCode} — ${employee.fullName}`;
    select.append(option);
  }
}

function fillBranches(select, { placeholder } = {}) {
  if (!select) return;
  select.textContent = "";

  if (placeholder) {
    const option = document.createElement("option");
    option.value = "";
    option.textContent = placeholder;
    select.append(option);
  }

  for (const branch of state.branches) {
    const option = document.createElement("option");
    option.value = String(branch.id);
    option.textContent = branch.name;
    select.append(option);
  }
}

/* ── الحضور ───────────────────────────────────────────────── */

async function refreshOpenShifts() {
  const result = await api("/attendance/open-shifts");
  const body = el("open-table").querySelector("tbody");
  body.textContent = "";

  if (!result.ok) return;
  const shifts = result.openShifts ?? [];
  el("open-empty").hidden = shifts.length > 0;

  for (const shift of shifts) {
    const employee = state.employees.find((item) => item.id === shift.employeeId);
    const jump = button("عرض سجلاته", {
      onClick: async () => {
        el("filter-employee").value = String(shift.employeeId);
        await refreshLogs();
      },
    });

    body.append(
      row([
        employee ? `${employee.employeeCode} — ${employee.fullName}` : `#${shift.employeeId}`,
        formatDateTime(shift.serverTime),
        jump,
      ]),
    );
  }
}

function logActions(log) {
  const wrap = document.createElement("div");
  wrap.className = "row row--tight";

  if (log.type === "check_out" && (can("attendance.correct_checkout") || can("attendance.manual_write"))) {
    wrap.append(
      button("تصحيح", {
        onClick: () => startCorrection(log),
      }),
    );
  }

  if (can("attendance.manual_write")) {
    wrap.append(
      button("تعديل", { onClick: () => startEdit(log) }),
      button("حذف", {
        className: "btn btn--danger btn--xs",
        onClick: () => deleteLog(log),
      }),
    );
  }

  return wrap;
}

async function refreshLogs() {
  const params = new URLSearchParams();
  const employeeId = el("filter-employee").value;
  const from = el("filter-from").value;
  const to = el("filter-to").value;

  if (employeeId) params.set("employeeId", employeeId);
  if (from) params.set("from", `${from}T00:00:00`);
  if (to) params.set("to", `${to}T23:59:59`);
  params.set("limit", "200");

  const result = await api(`/admin/attendance?${params.toString()}`);
  const body = el("logs-table").querySelector("tbody");
  body.textContent = "";

  if (!result.ok) {
    setAlert(el("admin-alert"), result.error ?? "تعذّر قراءة السجلات", "error");
    return;
  }

  const logs = result.logs ?? [];
  el("logs-empty").hidden = logs.length > 0;

  for (const log of logs) {
    body.append(
      row(
        [
          `${log.employeeCode} — ${log.fullName}`,
          label(log.type),
          log.localTime ?? formatDateTime(log.serverTime),
          log.branchName ?? "—",
          label(log.status),
          label(log.source),
          log.distanceMeters === null ? "—" : `${Math.round(log.distanceMeters)} م`,
          log.faceVerified ? "✓" : log.faceDistance === null ? "—" : "✗",
          log.deductedHours ? `${log.deductedHours} س` : "—",
          logActions(log),
        ],
        { className: log.status === "rejected" ? "is-rejected" : log.status === "flagged" ? "is-flagged" : "" },
      ),
    );
  }
}

function startEdit(log) {
  state.editingLogId = log.id;
  el("manual-employee").value = String(log.employeeId);
  el("manual-type").value = log.type;
  if (log.branchId) el("manual-branch").value = String(log.branchId);
  el("manual-time").value = toLocalInputValue(new Date(log.serverTime));
  el("manual-status").value = log.status;
  el("manual-deduct").value = String(log.deductedHours ?? 0);
  el("manual-reason").value = "";
  el("manual-submit").textContent = `حفظ تعديل السجل #${log.id}`;
  el("manual-reset").hidden = false;
  el("manual-card").scrollIntoView({ behavior: "smooth", block: "center" });
}

function resetManualForm() {
  state.editingLogId = null;
  el("manual-submit").textContent = "حفظ السجل";
  el("manual-reset").hidden = true;
  el("manual-reason").value = "";
  el("manual-deduct").value = "0";
  el("manual-time").value = toLocalInputValue();
}

async function deleteLog(log) {
  const reason = window.prompt("سبب حذف السجل (إلزامي للتوثيق):", "");
  if (!reason) return;

  const result = await api(`/admin/attendance/${log.id}`, {
    method: "DELETE",
    body: { reason },
  });

  setAlert(
    el("manual-result"),
    result.ok ? result.message : (result.error ?? "تعذّر الحذف"),
    result.ok ? "ok" : "error",
  );

  if (result.ok) await Promise.all([refreshLogs(), refreshOpenShifts()]);
}

function startCorrection(log) {
  state.correctingLogId = log.id;
  el("correct-card").hidden = false;
  el("correct-target").textContent = `${log.employeeCode} — ${log.localTime ?? ""}`;
  el("correct-time").value = toLocalInputValue(new Date(log.serverTime));
  el("correct-deduct").value = String(log.deductedHours ?? 0);
  el("correct-reason").value = "";
  setAlert(el("correct-result"), "");
  el("correct-card").scrollIntoView({ behavior: "smooth", block: "center" });
}

/* ── النماذج ──────────────────────────────────────────────── */

function formActions(resource, item) {
  const wrap = document.createElement("div");
  wrap.className = "row row--tight";

  if (resource.decidable && item.status === "pending") {
    wrap.append(
      button("اعتماد", {
        className: "btn btn--primary btn--xs",
        onClick: () => decide(resource.key, item.id, "approved"),
      }),
      button("رفض", {
        className: "btn btn--danger btn--xs",
        onClick: () => decide(resource.key, item.id, "rejected"),
      }),
    );
  }

  if (resource.key === "vouchers") {
    wrap.append(button("طباعة", { onClick: () => openPrint("voucher", item.id) }));
  }
  if (resource.key === "contracts") {
    wrap.append(button("طباعة", { onClick: () => openPrint("contract", item.id) }));
  }

  wrap.append(
    button("حذف", {
      className: "btn btn--danger btn--xs",
      onClick: async () => {
        const reason = window.prompt("سبب الحذف:", "") ?? "";
        const result = await api(`/forms/${resource.key}/${item.id}`, {
          method: "DELETE",
          body: { reason },
        });
        setAlert(
          el("forms-result"),
          result.ok ? result.message : (result.error ?? "تعذّر الحذف"),
          result.ok ? "ok" : "error",
        );
        if (result.ok) await refreshFormsList();
      },
    }),
  );

  return wrap;
}

async function decide(resourceKey, id, status) {
  const note = window.prompt(status === "approved" ? "ملاحظة الاعتماد (اختياري):" : "سبب الرفض:", "") ?? "";
  const result = await api(`/forms/${resourceKey}/${id}/decision`, {
    method: "POST",
    body: { status, decisionNote: note },
  });

  setAlert(
    el("forms-result"),
    result.ok ? result.message : (result.error ?? "تعذّر تنفيذ القرار"),
    result.ok ? "ok" : "error",
  );

  if (result.ok) await refreshFormsList();
}

async function refreshFormsList() {
  const resource = state.schema.get(state.formsResource);
  const result = await api(`/forms/${state.formsResource}`);
  const table = el("forms-table");
  const head = table.querySelector("thead");
  const body = table.querySelector("tbody");

  head.textContent = "";
  body.textContent = "";

  if (!result.ok) {
    setAlert(el("forms-result"), result.error ?? "تعذّر قراءة النماذج", "error");
    el("forms-empty").hidden = false;
    return;
  }

  const columns = LIST_COLUMNS[state.formsResource] ?? [];
  const headRow = document.createElement("tr");
  for (const column of ["الموظف", ...columns.map((item) => item.label), ""]) {
    const th = document.createElement("th");
    th.textContent = column;
    headRow.append(th);
  }
  head.append(headRow);

  const items = result.items ?? [];
  el("forms-empty").hidden = items.length > 0;

  for (const item of items) {
    const cells = columns.map((column) => {
      const value = item[column.key];
      if (column.money) return formatMoney(value);
      if (column.badge || column.translate) return label(value);
      return value ?? "—";
    });

    body.append(
      row([
        item.fullName ? `${item.employeeCode ?? ""} ${item.fullName}`.trim() : "—",
        ...cells,
        formActions(resource, item),
      ]),
    );
  }
}

async function renderFormsCreate() {
  const resource = state.schema.get(state.formsResource);
  if (!resource) return;

  fillEmployees(el("forms-employee"), { includeEmpty: resource.ownerOptional });
  renderFormFields(el("forms-fields"), resource, { mode: "manage" });
  applyPurgeScope();
  await refreshFormsList();
}

/* ── تنظيف النماذج السابقة أو التجريبية ─────────────────────── */

/** خيار «المعتمدة والمرفوضة» لا معنى له في النماذج بلا اعتماد (العهد، السندات). */
function applyPurgeScope() {
  const resource = state.schema.get(state.formsResource);
  const scopeSelect = el("forms-purge-scope");
  const decided = scopeSelect.querySelector('option[value="decided"]');

  // بطاقة التنظيف لا تظهر إلا لمن يملك صلاحية إدارة هذا النموذج
  el("forms-purge-card").hidden = !resource || !can(resource.managePermission);

  if (decided) {
    decided.disabled = !resource?.decidable;
    if (decided.disabled && scopeSelect.value === "decided") scopeSelect.value = "before";
  }

  el("forms-purge-date-wrap").hidden = scopeSelect.value !== "before";
  setAlert(el("forms-purge-result"), "");
}

/** جسم الطلب المشترك بين المعاينة والتنفيذ. */
function purgeQuery() {
  const scope = el("forms-purge-scope").value;
  const before = el("forms-purge-before").value;
  return { scope, ...(scope === "before" ? { before } : {}) };
}

async function countPurgeTargets() {
  const query = purgeQuery();

  if (query.scope === "before" && !query.before) {
    setAlert(el("forms-purge-result"), "حدّد التاريخ الذي يُحذف ما قبله.", "error");
    return null;
  }

  const search = new URLSearchParams(query).toString();
  const result = await api(`/forms/${state.formsResource}/purge/preview?${search}`);

  if (!result.ok) {
    setAlert(el("forms-purge-result"), result.error ?? "تعذّر حساب العدد", "error");
    return null;
  }

  setAlert(
    el("forms-purge-result"),
    result.count === 0
      ? `لا توجد سجلات مطابقة (${result.describe}).`
      : `عدد السجلات المطابقة (${result.describe}): ${result.count}`,
    result.count === 0 ? "" : "warn",
  );

  return result;
}

async function runPurge() {
  const resource = state.schema.get(state.formsResource);
  const preview = await countPurgeTargets();
  if (!preview || preview.count === 0) return;

  const confirmed = window.prompt(
    `سيُحذف ${preview.count} من «${resource?.labelAr ?? ""}» (${preview.describe}) نهائياً.\n` +
      "اكتب كلمة «حذف» للتأكيد:",
    "",
  );
  if (confirmed === null) return;

  const reason = window.prompt("سبب الحذف (يُسجَّل في التدقيق):", "تنظيف بيانات التجربة") ?? "";
  const button = el("forms-purge-run");
  setBusy(button, true);

  const result = await api(`/forms/${state.formsResource}/purge`, {
    method: "POST",
    body: { ...purgeQuery(), confirm: confirmed.trim(), reason },
  });

  setBusy(button, false);
  setAlert(
    el("forms-purge-result"),
    result.ok ? result.message : (result.error ?? "تعذّر الحذف"),
    result.ok ? "ok" : "error",
  );

  if (result.ok) await refreshFormsList();
}

/* ── الرواتب ──────────────────────────────────────────────── */

async function refreshSalaries() {
  const result = await api("/forms/salary");
  const body = el("salary-table").querySelector("tbody");
  body.textContent = "";
  if (!result.ok) return;

  for (const item of result.items ?? []) {
    body.append(
      row([
        `${item.employeeCode ?? ""} ${item.fullName ?? ""}`.trim() || `#${item.employeeId}`,
        formatMoney(item.basicSalary, item.currency),
        formatMoney(item.housingAllowance, item.currency),
        formatMoney(item.transportAllowance, item.currency),
        formatMoney(item.otherAllowances, item.currency),
        item.hourlyRate
          ? formatMoney(item.hourlyRate, item.currency)
          : formatMoney(
              (item.basicSalary ?? 0) / (item.contractHoursPerMonth || 240),
              item.currency,
            ),
      ]),
    );
  }
}

async function previewPayroll() {
  const period = el("payroll-period").value || currentMonthKey();
  const result = await api(`/payroll/preview?period=${encodeURIComponent(period)}`);
  const body = el("payroll-table").querySelector("tbody");
  body.textContent = "";

  if (!result.ok) {
    setAlert(el("payroll-result"), result.error ?? "تعذّرت المعاينة", "error");
    return;
  }

  const items = result.items ?? [];
  el("payroll-empty").hidden = items.length > 0;
  setAlert(
    el("payroll-result"),
    `${items.length} موظف — إجمالي الصافي ${formatMoney(result.totalNetPay)}`,
    "ok",
  );

  for (const item of items) {
    const save = button("حفظ المسير", {
      className: "btn btn--primary btn--xs",
      onClick: async (node) => {
        setBusy(node, true);
        const saved = await api("/payroll/slips", {
          method: "POST",
          body: { employeeId: item.employeeId, period: item.period },
        });
        setBusy(node, false);
        setAlert(
          el("payroll-result"),
          saved.ok ? saved.message : (saved.error ?? "تعذّر الحفظ"),
          saved.ok ? "ok" : "error",
        );
        if (saved.ok) await refreshSavedSlips();
      },
    });

    body.append(
      row([
        `${item.employeeCode} — ${item.fullName}`,
        formatMoney(item.basicSalary, item.currency),
        formatMoney(item.allowancesTotal, item.currency),
        `${item.workedHours} س`,
        formatMoney(item.overtimeAmount, item.currency),
        formatMoney(item.bonusesAmount, item.currency),
        formatMoney(item.advancesAmount, item.currency),
        formatMoney(item.hoursDeductionAmount, item.currency),
        formatMoney(item.netPay, item.currency),
        save,
      ]),
    );
  }
}

async function refreshSavedSlips() {
  const result = await api("/payroll/slips");
  const body = el("saved-slips").querySelector("tbody");
  body.textContent = "";
  if (!result.ok) return;

  for (const slip of result.items ?? []) {
    body.append(
      row([
        slip.period,
        `${slip.employeeCode ?? ""} ${slip.fullName ?? ""}`.trim(),
        formatMoney(slip.netPay, slip.currency),
        label(slip.status),
        button("طباعة", { onClick: () => openPrint("payroll", slip.id) }),
      ]),
    );
  }
}

/* ── الموظفون وبصمات الوجه ────────────────────────────────── */

/**
 * علامة صح «تفعيل البصمة» لكل موظف. التغيير يُحفظ فوراً على الخادم، وإن
 * فشل تُرجَع العلامة إلى حالتها السابقة حتى لا تُظهر الشاشة ما لم يُحفظ.
 */
function faceEnabledCell(employee) {
  const wrap = document.createElement("label");
  wrap.className = "check";

  const box = document.createElement("input");
  box.type = "checkbox";
  box.checked = employee.faceEnabled !== false;
  box.disabled = !can("employees.write");

  const text = document.createElement("span");
  const paint = () => {
    text.textContent = box.checked ? "مُفعّلة" : "معطّلة";
  };
  paint();

  box.addEventListener("change", async () => {
    const wanted = box.checked;
    box.disabled = true;

    const result = await api(`/employees/${employee.id}/face-enabled`, {
      method: "PATCH",
      body: { enabled: wanted },
    });

    box.disabled = !can("employees.write");

    if (result.ok) {
      employee.faceEnabled = wanted;
    } else {
      box.checked = !wanted;
    }
    paint();

    setAlert(
      el("people-result"),
      result.ok ? result.message : (result.error ?? "تعذّر تغيير تفعيل البصمة"),
      result.ok ? "ok" : "error",
    );
  });

  wrap.append(box, text);
  return wrap;
}

async function setFaceEnabledForAll(enabled) {
  const node = el(enabled ? "face-enable-all" : "face-disable-all");
  const verb = enabled ? "تفعيل" : "تعطيل";
  if (!window.confirm(`${verb} بصمة الوجه لكل الموظفين؟`)) return;

  setBusy(node, true);
  const result = await api("/employees/face-enabled/bulk", {
    method: "POST",
    body: { enabled },
  });
  setBusy(node, false);

  setAlert(
    el("people-result"),
    result.ok ? result.message : (result.error ?? `تعذّر ${verb} البصمة للكل`),
    result.ok ? "ok" : "error",
  );

  if (result.ok) await refreshPeople();
}

async function refreshPeople() {
  const [employeesResult, faceResult] = await Promise.all([
    api("/employees"),
    api("/face/enrollments"),
  ]);

  if (!employeesResult.ok) return;
  state.employees = employeesResult.employees ?? [];

  const enrolled = new Map(
    (faceResult.enrollments ?? []).map((item) => [item.employeeId, item]),
  );

  const body = el("people-table").querySelector("tbody");
  body.textContent = "";

  for (const employee of state.employees) {
    const face = enrolled.get(employee.id);
    const actions = employeeRowActions(employee);

    if (can("employees.write")) {
      actions.append(
        button("رمز استعادة", {
          onClick: () => issueResetCode(employee.id),
        }),
      );
    }

    if (face && can("attendance.manual_write")) {
      actions.append(
        button("تصفير البصمة", {
          className: "btn btn--danger btn--xs",
          onClick: async () => {
            const reason = window.prompt("سبب تصفير بصمة الوجه:", "") ?? "";
            const result = await api(`/admin/face/${employee.id}`, {
              method: "DELETE",
              body: { reason },
            });
            setAlert(
              el("people-result"),
              result.ok ? result.message : (result.error ?? "تعذّر التصفير"),
              result.ok ? "ok" : "error",
            );
            if (result.ok) await refreshPeople();
          },
        }),
      );
    }

    body.append(
      row([
        employee.employeeCode,
        employee.fullName,
        employee.jobTitle,
        employee.department || "—",
        employee.phone || "—",
        employee.nationalId || "—",
        employee.joinDate ?? "—",
        employee.branchName ?? "—",
        employee.branchManagerName ?? "—",
        employee.roleNameAr ?? employee.roleName ?? "—",
        faceEnabledCell(employee),
        face ? `مسجّلة (${formatDateTime(face.enrolledAt)})` : "غير مسجّلة",
        actions,
      ]),
    );
  }

  fillEmployees(el("manual-employee"));
  fillEmployees(el("filter-employee"), { includeAll: true });
  fillEmployees(el("salary-employee"));
  fillEmployees(el("reset-employee"), { placeholder: "اختر الموظف" });
  fillNewPanelSelects();
  fillPeopleSelects();
}

/* ── استعادة كلمات المرور ─────────────────────────────────── */

const RESET_STATUS_LABELS = {
  pending: "في انتظار المسؤول",
  sent: "أُرسل الرمز",
  used: "استُخدم",
  expired: "منتهي",
  cancelled: "ملغى",
};

const RESET_CHANNEL_LABELS = {
  email: "بريد إلكتروني",
  admin: "من المسؤول",
};

/** يصدر رمز استعادة ويعرضه مرة واحدة ليسلّمه المسؤول للموظف. */
async function issueResetCode(employeeId) {
  const target = employeeId ?? Number(el("reset-employee").value || 0);
  if (!target) {
    setAlert(el("people-result"), "اختر الموظف أولاً.", "error");
    return;
  }

  const node = el("reset-issue");
  setBusy(node, true);
  const result = await api("/admin/password-resets/issue", {
    method: "POST",
    body: { employeeId: target },
  });
  setBusy(node, false);

  const box = el("reset-code-box");
  if (!result.ok) {
    box.hidden = true;
    setAlert(el("people-result"), result.error ?? "تعذّر إصدار الرمز", "error");
    return;
  }

  // الرمز يظهر في هذه الاستجابة فقط ولا يُخزَّن نصاً في قاعدة البيانات
  box.hidden = false;
  box.textContent = `${result.message} الرمز: ${result.code} (${result.employeeCode}) — ينتهي ${formatDateTime(result.expiresAt)}`;
  setAlert(el("people-result"), "");
  await refreshResetRequests();
}

async function refreshResetRequests() {
  if (!can("employees.write")) return;

  const all = el("reset-show-all").checked ? "?all=1" : "";
  const result = await api(`/admin/password-resets${all}`);
  const body = el("reset-table").querySelector("tbody");
  body.textContent = "";

  if (!result.ok) {
    setAlert(el("people-result"), result.error ?? "تعذّر قراءة طلبات الاستعادة", "error");
    return;
  }

  el("reset-mail-note").textContent = result.mailConfigured
    ? "إرسال البريد مضبوط: يصل الرمز إلى بريد الموظف تلقائياً، ويبقى الإصدار اليدوي متاحاً لمن لا بريد له."
    : "إرسال البريد غير مضبوط على هذا الموقع، فكل طلب يبقى هنا لتصدر الرمز بنفسك وتسلّمه للموظف.";

  const requests = result.requests ?? [];
  el("reset-empty").hidden = requests.length > 0;

  for (const request of requests) {
    const cancel = button("إلغاء", {
      className: "btn btn--danger btn--xs",
      onClick: async () => {
        const response = await api(`/admin/password-resets/${request.id}/cancel`, {
          method: "POST",
        });
        setAlert(
          el("people-result"),
          response.ok ? response.message : (response.error ?? "تعذّر الإلغاء"),
          response.ok ? "ok" : "error",
        );
        if (response.ok) await refreshResetRequests();
      },
    });

    const issue = button("إصدار رمز", {
      onClick: () => issueResetCode(request.employeeId),
    });

    const actions = document.createElement("div");
    actions.className = "row row--tight";
    if (request.status === "pending" || request.status === "sent") {
      actions.append(issue, cancel);
    }

    body.append(
      row([
        formatDateTime(request.createdAt),
        `${request.employeeCode ?? "—"} ${request.fullName ?? ""}`.trim(),
        request.maskedEmail || "بلا بريد",
        RESET_CHANNEL_LABELS[request.deliveryChannel] ?? "—",
        RESET_STATUS_LABELS[request.status] ?? request.status,
        String(request.attempts ?? 0),
        formatDateTime(request.expiresAt),
        actions,
      ]),
    );
  }
}

/** قوائم الموظفين والفروع في شاشات النماذج والكاشير والمخزون. */
function fillNewPanelSelects() {
  fillEmployees(el("doc-employee"), { placeholder: "اختر الموظف" });
  fillEmployees(el("doc-issues-employee"), { includeAll: true });
  fillEmployees(el("disc-employee"), { placeholder: "اختر الموظف" });
  fillEmployees(el("disc-filter-employee"), { includeAll: true });
  fillEmployees(el("cashier-employee"), { placeholder: "أنا" });

  fillBranches(el("cashier-branch"), { placeholder: "فرعي" });
  fillBranches(el("cashier-filter-branch"), { placeholder: "الكل" });
  fillBranches(el("inventory-branch"), { placeholder: "فرعي" });
}

/* ── سجل التدقيق ──────────────────────────────────────────── */

async function refreshAudit() {
  const result = await api("/admin/audit?limit=200");
  const body = el("audit-table").querySelector("tbody");
  body.textContent = "";

  if (!result.ok) {
    setAlert(el("admin-alert"), result.error ?? "لا تملك صلاحية سجل التدقيق", "error");
    return;
  }

  const entries = result.entries ?? [];
  el("audit-empty").hidden = entries.length > 0;

  for (const entry of entries) {
    body.append(
      row([
        formatDateTime(entry.createdAt),
        entry.actorName ? `${entry.actorCode ?? ""} ${entry.actorName}`.trim() : "النظام",
        entry.action,
        `${entry.entityType}#${entry.entityId ?? "—"}`,
        entry.reason || "—",
      ]),
    );
  }
}

/* ── التنقّل ───────────────────────────────────────────────── */

const PANEL_LOADERS = {
  attendance: async () => {
    await Promise.all([refreshOpenShifts(), refreshLogs()]);
  },
  forms: async () => {
    if (!state.schema) state.schema = await loadFormsSchema();
    await renderFormsCreate();
  },
  payroll: async () => {
    await Promise.all([refreshSalaries(), refreshSavedSlips()]);
  },
  people: async () => {
    await refreshPeople();
    await refreshSchedules();
    await refreshResetRequests();
  },
  branches: refreshBranchesPanel,
  documents: refreshDocumentsPanel,
  cashier: refreshCashierPanel,
  inventory: refreshInventoryPanel,
  reports: async () => {
    fillPeopleSelects();
  },
  settings: async () => {
    await refreshSettingsPanel(state.employees);
  },
  audit: refreshAudit,
};

el("admin-tabs").addEventListener("click", async (event) => {
  const tab = event.target.closest(".tab");
  if (!tab) return;

  for (const node of el("admin-tabs").querySelectorAll(".tab")) {
    node.classList.toggle("is-active", node === tab);
  }
  for (const panel of document.querySelectorAll(".panel")) {
    panel.hidden = panel.id !== `panel-${tab.dataset.panel}`;
  }

  setAlert(el("admin-alert"), "");
  await PANEL_LOADERS[tab.dataset.panel]?.();
});

/* ── الأحداث ───────────────────────────────────────────────── */

el("manual-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  const submit = el("manual-submit");
  setBusy(submit, true);

  const payload = {
    employeeId: Number(el("manual-employee").value),
    branchId: el("manual-branch").value ? Number(el("manual-branch").value) : undefined,
    type: el("manual-type").value,
    time: new Date(el("manual-time").value).toISOString(),
    status: el("manual-status").value,
    deductedHours: Number(el("manual-deduct").value || 0),
    reason: el("manual-reason").value.trim(),
  };

  const result = state.editingLogId
    ? await api(`/admin/attendance/${state.editingLogId}`, { method: "PATCH", body: payload })
    : await api("/admin/attendance", { method: "POST", body: payload });

  setBusy(submit, false);
  setAlert(
    el("manual-result"),
    result.ok ? result.message : (result.error ?? "تعذّر حفظ السجل"),
    result.ok ? "ok" : "error",
  );

  if (result.ok) {
    resetManualForm();
    await Promise.all([refreshLogs(), refreshOpenShifts()]);
  }
});

el("manual-reset").addEventListener("click", resetManualForm);

el("correct-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  if (!state.correctingLogId) return;

  const result = await api(`/admin/attendance/${state.correctingLogId}/checkout-correction`, {
    method: "PATCH",
    body: {
      actualCheckOut: new Date(el("correct-time").value).toISOString(),
      deductHours: Number(el("correct-deduct").value || 0),
      reason: el("correct-reason").value.trim(),
    },
  });

  setAlert(
    el("correct-result"),
    result.ok ? result.message : (result.error ?? "تعذّر التصحيح"),
    result.ok ? "ok" : "error",
  );

  if (result.ok) {
    state.correctingLogId = null;
    el("correct-card").hidden = true;
    await refreshLogs();
  }
});

el("correct-cancel").addEventListener("click", () => {
  state.correctingLogId = null;
  el("correct-card").hidden = true;
});

el("close-stale").addEventListener("click", async (event) => {
  const node = event.currentTarget;
  setBusy(node, true);
  const result = await api("/admin/shifts/close-stale", { method: "POST" });
  setBusy(node, false);

  setAlert(
    el("admin-alert"),
    result.ok
      ? `تم إقفال ${result.closedCount} وردية متأخرة.`
      : (result.error ?? "تعذّر الإقفال"),
    result.ok ? "ok" : "error",
  );

  if (result.ok) await Promise.all([refreshOpenShifts(), refreshLogs()]);
});

el("filter-apply").addEventListener("click", refreshLogs);

el("forms-tabs").addEventListener("click", async (event) => {
  const tab = event.target.closest(".tab");
  if (!tab) return;

  for (const node of el("forms-tabs").querySelectorAll(".tab")) {
    node.classList.toggle("is-active", node === tab);
  }

  state.formsResource = tab.dataset.resource;
  setAlert(el("forms-result"), "");
  await renderFormsCreate();
});

el("forms-create").addEventListener("submit", async (event) => {
  event.preventDefault();
  const submit = el("forms-submit");
  setBusy(submit, true);

  const employeeId = el("forms-employee").value;
  const payload = {
    ...collectFormValues(el("forms-fields")),
    ...(employeeId ? { employeeId: Number(employeeId) } : {}),
  };

  const result = await api(`/forms/${state.formsResource}`, { method: "POST", body: payload });

  setBusy(submit, false);
  setAlert(
    el("forms-result"),
    result.ok ? result.message : (result.error ?? "تعذّر الحفظ"),
    result.ok ? "ok" : "error",
  );

  if (result.ok) await refreshFormsList();
});

el("forms-purge-scope").addEventListener("change", applyPurgeScope);
el("forms-purge-count").addEventListener("click", countPurgeTargets);
el("forms-purge-run").addEventListener("click", runPurge);

el("salary-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  const employeeId = el("salary-employee").value;
  if (!employeeId) return;

  const result = await api(`/forms/salary/${employeeId}`, {
    method: "PUT",
    body: {
      basicSalary: Number(el("salary-basic").value || 0),
      housingAllowance: Number(el("salary-housing").value || 0),
      transportAllowance: Number(el("salary-transport").value || 0),
      otherAllowances: Number(el("salary-other").value || 0),
      contractHoursPerMonth: Number(el("salary-hours").value || 240),
      overtimeMultiplier: Number(el("salary-multiplier").value || 1.5),
      hourlyRate: el("salary-hourly").value ? Number(el("salary-hourly").value) : null,
      reason: "تحديث تعريف الراتب من لوحة الموارد البشرية",
    },
  });

  setAlert(
    el("salary-result"),
    result.ok ? result.message : (result.error ?? "تعذّر حفظ التعريف"),
    result.ok ? "ok" : "error",
  );

  if (result.ok) await refreshSalaries();
});

el("payroll-preview").addEventListener("click", previewPayroll);
el("audit-refresh").addEventListener("click", refreshAudit);

el("face-enable-all").addEventListener("click", () => setFaceEnabledForAll(true));
el("face-disable-all").addEventListener("click", () => setFaceEnabledForAll(false));

el("reset-refresh").addEventListener("click", refreshResetRequests);
el("reset-show-all").addEventListener("change", refreshResetRequests);
el("reset-issue").addEventListener("click", () => issueResetCode());

el("admin-logout").addEventListener("click", async () => {
  stopIdleWatch();
  await api("/auth/logout", { method: "POST" });
  setToken(null);
  clearActivity();
  requireLogin();
});

/* ── الخروج التلقائي ───────────────────────────────────────── */

/** انتهاء الجلسة (خمول محلي أو رفض الخادم) يُعيد المستخدم لشاشة الدخول. */
onSessionExpired(() => requireLogin("idle"));

function watchIdle() {
  startIdleWatch({
    idleSeconds: state.idleSeconds,
    onWarn: (remaining) => {
      const note = el("admin-idle-note");
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
      setToken(null);
      clearActivity();
      requireLogin("idle");
    },
  });
}

/* ── الإقلاع ───────────────────────────────────────────────── */

/** الصلاحيات التي تفتح كل تبويب — التبويب يُخفى إن لم يملك المستخدم أياً منها. */
const TAB_PERMISSIONS = {
  attendance: ["attendance.read_all"],
  forms: ["forms.read_all", "forms.approve", "vouchers.manage", "custody.manage"],
  payroll: ["payroll.manage", "salary.manage"],
  people: ["employees.read"],
  branches: ["branches.read"],
  documents: ["documents.print", "documents.read_all", "disciplinary.manage", "forms.read_all"],
  cashier: ["cashier.submit", "cashier.review", "cashier.read_all", "sections.cashier"],
  inventory: ["inventory.read", "inventory.write", "sections.inventory"],
  reports: ["reports.view", "sections.reports"],
  settings: ["settings.manage", "branches.manage", "sections.settings"],
  audit: ["audit.read"],
};

async function boot() {
  if (!getToken()) {
    requireLogin();
    return;
  }

  const config = await loadRuntimeConfig();
  if (config.ok) state.idleSeconds = config.session?.idleSeconds ?? state.idleSeconds;

  // من غادر الصفحة أكثر من مدة الخمول يُخرج قبل أي نداء آخر
  if (idleExceeded(state.idleSeconds)) {
    setToken(null);
    clearActivity();
    requireLogin("idle");
    return;
  }

  const me = await api("/auth/me");
  if (!me.ok) {
    setToken(null);
    requireLogin(me.reason === "idle_timeout" ? "idle" : undefined);
    return;
  }

  markActivity();
  watchIdle();

  state.permissions = me.permissions ?? [];
  el("admin-who").textContent = [
    me.employee.fullName,
    me.employee.employeeCode,
    me.employee.role,
  ]
    .filter(Boolean)
    .join(" · ");

  // اللوحة تُفتح لمن يملك صلاحية أي تبويب — الكاشير مثلاً يدخل لشاشة
  // التقفيل فقط دون صلاحية الحضور، والخادم يفرض الصلاحية على كل مسار.
  const allowedTabs = Object.entries(TAB_PERMISSIONS)
    .filter(([, codes]) => codes.some((code) => can(code)))
    .map(([panel]) => panel);

  if (allowedTabs.length === 0) {
    setAlert(
      el("admin-alert"),
      "هذه اللوحة تحتاج صلاحية إدارية (الموارد البشرية أو مدير الفرع).",
      "error",
    );
    return;
  }

  el("manual-card").hidden = !can("attendance.manual_write");
  el("face-bulk").hidden = !can("employees.write");
  el("reset-queue-card").hidden = !can("employees.write");
  el("payroll-period").value = currentMonthKey();
  el("manual-time").value = toLocalInputValue();

  const branchesResult = await api("/branches");
  state.branches = branchesResult.ok ? (branchesResult.branches ?? []) : [];
  fillBranches(el("manual-branch"));
  fillNewPanelSelects();

  // إخفاء التبويبات التي لا يملك صلاحيتها
  for (const panel of Object.keys(TAB_PERMISSIONS)) {
    const tab = el("admin-tabs").querySelector(`[data-panel="${panel}"]`);
    if (tab) tab.hidden = !allowedTabs.includes(panel);
  }

  initPeopleModule({ state, can, refreshPeople });
  initReportsModule();
  initSettingsModule({ can, employees: state.employees });
  initCashierModule({ can });
  initInventoryModule({ can });
  initDocumentsModule({ can });
  await loadPeopleMeta();

  if (can("employees.read")) await refreshPeople();

  // نفتح أول تبويب مسموح به بدل افتراض تبويب الحضور دائماً
  const first = allowedTabs[0];
  for (const node of el("admin-tabs").querySelectorAll(".tab")) {
    node.classList.toggle("is-active", node.dataset.panel === first);
  }
  for (const panel of document.querySelectorAll(".panel")) {
    panel.hidden = panel.id !== `panel-${first}`;
  }

  await PANEL_LOADERS[first]?.();
}

boot();
