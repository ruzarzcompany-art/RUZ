/**
 * لوحة الموارد البشرية: الحضور اليدوي والتصحيحات، النماذج والاعتمادات،
 * تعريف الرواتب ومسيّراتها، بصمات الوجه، وسجل التدقيق.
 *
 * كل شاشة تُخفى إن لم يملك المستخدم صلاحيتها — والخادم يفرض الصلاحية أيضاً.
 */

import {
  api,
  button,
  currentMonthKey,
  el,
  formatDateTime,
  formatMoney,
  getToken,
  label,
  openPrint,
  requireLogin,
  row,
  setAlert,
  setBusy,
  setToken,
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

const state = {
  permissions: [],
  employees: [],
  branches: [],
  schema: null,
  formsResource: "advances",
  editingLogId: null,
  correctingLogId: null,
};

const can = (code) => state.permissions.includes(code);

/* ── تعبئة القوائم المنسدلة ───────────────────────────────── */

function fillEmployees(select, { includeAll = false, includeEmpty = false } = {}) {
  if (!select) return;
  select.textContent = "";

  if (includeAll) {
    const option = document.createElement("option");
    option.value = "";
    option.textContent = "الكل";
    select.append(option);
  } else if (includeEmpty) {
    const option = document.createElement("option");
    option.value = "";
    option.textContent = "بدون موظف";
    select.append(option);
  }

  for (const employee of state.employees) {
    const option = document.createElement("option");
    option.value = String(employee.id);
    option.textContent = `${employee.employeeCode} — ${employee.fullName}`;
    select.append(option);
  }
}

function fillBranches(select) {
  if (!select) return;
  select.textContent = "";
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
  await refreshFormsList();
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
        face ? `مسجّلة (${formatDateTime(face.enrolledAt)})` : "غير مسجّلة",
        actions,
      ]),
    );
  }

  fillEmployees(el("manual-employee"));
  fillEmployees(el("filter-employee"), { includeAll: true });
  fillEmployees(el("salary-employee"));
  fillPeopleSelects();
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
  },
  branches: refreshBranchesPanel,
  reports: async () => {
    fillPeopleSelects();
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

el("admin-logout").addEventListener("click", async () => {
  await api("/auth/logout", { method: "POST" });
  setToken(null);
  requireLogin();
});

/* ── الإقلاع ───────────────────────────────────────────────── */

async function boot() {
  if (!getToken()) {
    requireLogin();
    return;
  }

  const me = await api("/auth/me");
  if (!me.ok) {
    setToken(null);
    requireLogin();
    return;
  }

  state.permissions = me.permissions ?? [];
  el("admin-who").textContent = [
    me.employee.fullName,
    me.employee.employeeCode,
    me.employee.role,
  ]
    .filter(Boolean)
    .join(" · ");

  if (!can("attendance.read_all")) {
    setAlert(
      el("admin-alert"),
      "هذه اللوحة تحتاج صلاحية إدارية (الموارد البشرية أو مدير الفرع).",
      "error",
    );
    return;
  }

  el("manual-card").hidden = !can("attendance.manual_write");
  el("payroll-period").value = currentMonthKey();
  el("manual-time").value = toLocalInputValue();

  const branchesResult = await api("/branches");
  state.branches = branchesResult.ok ? (branchesResult.branches ?? []) : [];
  fillBranches(el("manual-branch"));

  // إخفاء التبويبات التي لا يملك صلاحيتها
  const tabPermissions = {
    forms: ["forms.read_all", "forms.approve", "vouchers.manage", "custody.manage"],
    payroll: ["payroll.manage", "salary.manage"],
    people: ["employees.read"],
    branches: ["branches.read"],
    reports: ["reports.view", "sections.reports"],
    audit: ["audit.read"],
  };

  for (const [panel, codes] of Object.entries(tabPermissions)) {
    const allowed = codes.some((code) => can(code));
    const tab = el("admin-tabs").querySelector(`[data-panel="${panel}"]`);
    if (tab) tab.hidden = !allowed;
  }

  initPeopleModule({ state, can, refreshPeople });
  initReportsModule();
  await loadPeopleMeta();

  await refreshPeople();
  await PANEL_LOADERS.attendance();
}

boot();
