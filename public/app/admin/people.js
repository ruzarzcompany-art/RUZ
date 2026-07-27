/**
 * شاشات ملف الموظف: إضافة/تعديل بياناته الكاملة، جدول دوامه، تخصيص صلاحيات
 * العرض له بعينه، وتعيين المدير المسؤول عن كل فرع.
 *
 * الوحدة تُهيَّأ من `admin.js` عبر `initPeopleModule({ state, can, refreshPeople })`
 * فتشترك معه في نفس قوائم الموظفين والفروع بلا استعلامات مكرّرة.
 */

import { api, button, el, formatDate, formatDateTime, row, setAlert, setBusy } from "../api.js";

let ctx = null;

const meta = {
  roles: [],
  weekdays: [],
  allowedDaysOff: [2, 4],
};

/** الموظف المفتوح حالياً في نموذج التعديل (`null` = إضافة جديد). */
let editingEmployeeId = null;

const can = (code) => ctx?.can(code) ?? false;

/* ── قوائم مساعدة ─────────────────────────────────────────── */

function fillSelect(select, items, { placeholder } = {}) {
  if (!select) return;
  const previous = select.value;
  select.textContent = "";

  if (placeholder !== undefined) {
    const option = document.createElement("option");
    option.value = "";
    option.textContent = placeholder;
    select.append(option);
  }

  for (const item of items) {
    const option = document.createElement("option");
    option.value = String(item.value);
    option.textContent = item.label;
    select.append(option);
  }

  if (previous && [...select.options].some((option) => option.value === previous)) {
    select.value = previous;
  }
}

const employeeOptions = () =>
  ctx.state.employees.map((employee) => ({
    value: employee.id,
    label: `${employee.employeeCode} — ${employee.fullName}`,
  }));

const branchOptions = () =>
  ctx.state.branches.map((branch) => ({ value: branch.id, label: branch.name }));

/** تُستدعى بعد كل تحديث لقائمة الموظفين أو الفروع. */
export function fillPeopleSelects() {
  fillSelect(el("employee-branch"), branchOptions(), { placeholder: "بدون فرع" });
  fillSelect(
    el("employee-role"),
    meta.roles.map((role) => ({ value: role.id, label: role.nameAr || role.name })),
    { placeholder: "بدون دور" },
  );
  fillSelect(el("schedule-employee"), employeeOptions());
  fillSelect(el("perm-employee"), employeeOptions());
  fillSelect(el("report-branch"), branchOptions(), { placeholder: "الكل" });
  fillSelect(el("report-employee"), employeeOptions(), { placeholder: "الكل" });
}

/** يقرأ الأدوار وأيام الأسبوع مرة واحدة عند الإقلاع. */
export async function loadPeopleMeta() {
  const [rolesResult, scheduleMeta] = await Promise.all([
    can("employees.read") ? api("/roles") : Promise.resolve({ ok: false }),
    api("/schedules/meta"),
  ]);

  if (rolesResult.ok) meta.roles = rolesResult.roles ?? [];
  if (scheduleMeta.ok) {
    meta.weekdays = scheduleMeta.weekdays ?? [];
    meta.allowedDaysOff = scheduleMeta.allowedDaysOff ?? [2, 4];
  }

  renderOffDayChoices();
  fillPeopleSelects();
}

/* ── ملف الموظف: إضافة وتعديل ─────────────────────────────── */

/** يملأ النموذج ببيانات موظف قائم، أو يُفرغه لموظف جديد. */
export function editEmployee(employee) {
  editingEmployeeId = employee?.id ?? null;

  el("employee-target").textContent = employee
    ? `تعديل: ${employee.employeeCode} — ${employee.fullName}`
    : "موظف جديد";
  el("employee-code").value = employee?.employeeCode ?? "";
  el("employee-name").value = employee?.fullName ?? "";
  el("employee-nationality").value = employee?.nationality ?? "";
  el("employee-national-id").value = employee?.nationalId ?? "";
  el("employee-phone").value = employee?.phone ?? "";
  el("employee-email").value = employee?.email ?? "";
  el("employee-join").value = employee?.joinDate ?? "";
  el("employee-title").value = employee?.jobTitle ?? "";
  el("employee-department").value = employee?.department ?? "";
  el("employee-branch").value = employee?.branchId ? String(employee.branchId) : "";
  el("employee-role").value = employee?.roleId ? String(employee.roleId) : "";
  el("employee-active").value = employee ? String(employee.isActive !== false) : "true";
  el("employee-password").value = "";
  el("employee-reason").value = "";
  el("employee-submit").textContent = employee ? "حفظ التعديل" : "إضافة الموظف";

  setAlert(el("employee-result"), "");
  el("employee-card").scrollIntoView({ behavior: "smooth", block: "nearest" });
}

function readEmployeeForm() {
  return {
    employeeCode: el("employee-code").value.trim(),
    fullName: el("employee-name").value.trim(),
    nationality: el("employee-nationality").value.trim(),
    nationalId: el("employee-national-id").value.trim(),
    phone: el("employee-phone").value.trim(),
    email: el("employee-email").value.trim(),
    joinDate: el("employee-join").value || null,
    jobTitle: el("employee-title").value.trim(),
    department: el("employee-department").value.trim(),
    branchId: el("employee-branch").value ? Number(el("employee-branch").value) : null,
    roleId: el("employee-role").value ? Number(el("employee-role").value) : null,
    isActive: el("employee-active").value === "true",
    password: el("employee-password").value,
    reason: el("employee-reason").value.trim(),
  };
}

/** يعرض ملف الموظف الكامل (بما فيه مدير فرعه وجدوله) كتنبيه مقروء. */
async function showEmployeeFile(employeeId) {
  const result = await api(`/employees/${employeeId}/file`);
  if (!result.ok) {
    setAlert(el("people-result"), result.error ?? "تعذّر قراءة الملف", "error");
    return;
  }

  const employee = result.employee;
  const schedule = result.schedule;
  const lines = [
    `${employee.employeeCode} — ${employee.fullName}`,
    `الجنسية: ${employee.nationality || "—"} · الهوية/الإقامة: ${employee.nationalId || "—"}`,
    `الجوال: ${employee.phone || "—"} · البريد: ${employee.email || "—"}`,
    `القسم: ${employee.department || "—"} · المسمى: ${employee.jobTitle || "—"}`,
    `تاريخ الانضمام: ${formatDate(employee.joinDate)}`,
    `الفرع: ${employee.branchName ?? "—"} · مدير الفرع: ${employee.branchManagerName ?? "غير محدّد"}`,
    `الدور: ${employee.roleNameAr ?? employee.roleName ?? "—"}`,
    schedule
      ? `الدوام: ${schedule.shiftStart}–${schedule.shiftEnd} (${schedule.dailyHours} ساعات) · إجازات: ${schedule.daysOffPerMonth}/شهر (${schedule.offDaysLabel})`
      : "الدوام: لا يوجد جدول مُعرَّف",
    `بصمة الوجه: ${result.faceEnrolledAt ? formatDateTime(result.faceEnrolledAt) : "غير مسجّلة"}`,
  ];

  setAlert(el("people-result"), lines.join(" | "), "ok");
}

/** يضيف أزرار «الملف» و«تعديل» و«الدوام» لصف الموظف في الجدول. */
export function employeeRowActions(employee) {
  const actions = document.createElement("div");
  actions.className = "row row--tight";

  actions.append(
    button("الملف", {
      className: "btn btn--ghost btn--xs",
      onClick: () => showEmployeeFile(employee.id),
    }),
  );

  if (can("employees.write")) {
    actions.append(
      button("تعديل", {
        className: "btn btn--ghost btn--xs",
        onClick: () => editEmployee(employee),
      }),
    );
  }

  if (can("schedules.manage") || can("employees.write")) {
    actions.append(
      button("الدوام", {
        className: "btn btn--ghost btn--xs",
        onClick: () => loadScheduleInto(employee.id),
      }),
    );
  }

  if (can("permissions.manage")) {
    actions.append(
      button("الصلاحيات", {
        className: "btn btn--ghost btn--xs",
        onClick: () => {
          el("perm-employee").value = String(employee.id);
          loadPermissions();
        },
      }),
    );
  }

  return actions;
}

/* ── جدول الدوام ──────────────────────────────────────────── */

function renderOffDayChoices() {
  const host = el("schedule-off-days");
  if (!host) return;
  host.textContent = "";

  for (const day of meta.weekdays) {
    const wrap = document.createElement("label");
    wrap.className = "row row--tight";

    const input = document.createElement("input");
    input.type = "checkbox";
    input.value = String(day.value);
    input.dataset.offDay = "1";

    const text = document.createElement("span");
    text.textContent = day.label;

    wrap.append(input, text);
    host.append(wrap);
  }
}

const selectedOffDays = () =>
  [...document.querySelectorAll("[data-off-day]")]
    .filter((input) => input.checked)
    .map((input) => Number(input.value));

function setOffDays(days) {
  const wanted = new Set((days ?? []).map(Number));
  for (const input of document.querySelectorAll("[data-off-day]")) {
    input.checked = wanted.has(Number(input.value));
  }
}

/** يحمّل جدول موظف في النموذج للتعديل. */
async function loadScheduleInto(employeeId) {
  el("schedule-employee").value = String(employeeId);
  const result = await api(`/employees/${employeeId}/schedule`);
  const schedule = result.ok ? result.schedule : null;

  el("schedule-start").value = schedule?.shiftStart ?? "09:00";
  el("schedule-end").value = schedule?.shiftEnd ?? "17:00";
  el("schedule-hours").value = String(schedule?.dailyHours ?? 8);
  el("schedule-break").value = String(schedule?.breakMinutes ?? 0);
  el("schedule-grace").value = String(schedule?.graceMinutes ?? 10);
  el("schedule-days-off").value = String(schedule?.daysOffPerMonth ?? 4);
  el("schedule-note").value = schedule?.note ?? "";
  setOffDays(
    schedule?.offDays
      ? String(schedule.offDays)
          .split(",")
          .filter(Boolean)
          .map(Number)
      : [],
  );

  setAlert(
    el("schedule-result"),
    schedule ? "تم تحميل الجدول الحالي للتعديل." : "لا يوجد جدول لهذا الموظف — سيُنشأ جديد.",
    "ok",
  );
  el("schedule-card").scrollIntoView({ behavior: "smooth", block: "nearest" });
}

export async function refreshSchedules() {
  const result = await api("/schedules");
  const table = el("schedules-table");
  if (!table || !result.ok) return;

  const body = table.querySelector("tbody");
  body.textContent = "";

  for (const item of result.items ?? []) {
    body.append(
      row([
        item.employeeCode ?? "—",
        item.fullName ?? "—",
        item.shiftStart,
        item.shiftEnd,
        item.dailyHours,
        `${item.graceMinutes} د`,
        item.daysOffPerMonth,
        item.offDaysLabel,
        button("تعديل", {
          className: "btn btn--ghost btn--xs",
          onClick: () => loadScheduleInto(item.employeeId),
        }),
      ]),
    );
  }
}

/* ── تخصيص الصلاحيات ──────────────────────────────────────── */

async function loadPermissions() {
  const employeeId = el("perm-employee").value;
  if (!employeeId) return;

  const result = await api(`/employees/${employeeId}/permissions`);
  const host = el("perm-sections");
  host.textContent = "";

  if (!result.ok) {
    setAlert(el("perm-result"), result.error ?? "تعذّر قراءة الصلاحيات", "error");
    return;
  }

  const roleCodes = new Set(result.roleCodes ?? []);
  const overrideByCode = new Map(
    (result.overrides ?? []).map((item) => [item.permissionCode, item.effect]),
  );

  for (const section of result.sections ?? []) {
    const wrap = document.createElement("div");
    wrap.className = "perm";

    const text = document.createElement("div");
    const title = document.createElement("span");
    title.className = "perm__label";
    title.textContent = section.label;
    const hint = document.createElement("span");
    hint.className = "perm__hint";
    hint.textContent = `${section.hint} — دوره ${roleCodes.has(section.code) ? "يمنحه" : "لا يمنحه"} هذا القسم`;
    text.append(title, hint);

    const select = document.createElement("select");
    select.dataset.permissionCode = section.code;
    for (const [value, optionLabel] of [
      ["", "افتراضي الدور"],
      ["allow", "مسموح"],
      ["deny", "ممنوع"],
    ]) {
      const option = document.createElement("option");
      option.value = value;
      option.textContent = optionLabel;
      select.append(option);
    }
    select.value = overrideByCode.get(section.code) ?? "";

    wrap.append(text, select);
    host.append(wrap);
  }

  setAlert(
    el("perm-result"),
    `الصلاحيات الفعلية الحالية: ${(result.effective ?? []).length} صلاحية.`,
    "ok",
  );
}

/* ── الفروع ومديروها ──────────────────────────────────────── */

export async function refreshBranchesPanel() {
  const [branchesResult, candidatesResult] = await Promise.all([
    api("/branches"),
    can("branches.read") ? api("/branches/manager-candidates") : Promise.resolve({ ok: false }),
  ]);

  if (branchesResult.ok) {
    ctx.state.branches = branchesResult.branches ?? [];
    fillPeopleSelects();
  }

  const candidates = candidatesResult.ok ? (candidatesResult.candidates ?? []) : [];
  const body = el("branches-table").querySelector("tbody");
  body.textContent = "";

  for (const branch of ctx.state.branches) {
    const select = document.createElement("select");
    fillSelect(
      select,
      candidates.map((candidate) => ({
        value: candidate.id,
        label: `${candidate.employeeCode} — ${candidate.fullName}`,
      })),
      { placeholder: "بدون مدير" },
    );
    select.value = branch.managerEmployeeId ? String(branch.managerEmployeeId) : "";
    select.disabled = !can("branches.write");

    const save = button("حفظ", {
      className: "btn btn--primary btn--xs",
      onClick: async () => {
        setBusy(save, true);
        const result = await api(`/branches/${branch.id}/manager`, {
          method: "PATCH",
          body: {
            managerEmployeeId: select.value ? Number(select.value) : null,
            reason: "تعيين المدير المسؤول عن الفرع من لوحة الموارد البشرية",
          },
        });
        setBusy(save, false);
        setAlert(
          el("branches-result"),
          result.ok ? result.message : (result.error ?? "تعذّر الحفظ"),
          result.ok ? "ok" : "error",
        );
        if (result.ok) {
          await refreshBranchesPanel();
          await ctx.refreshPeople();
        }
      },
    });
    save.hidden = !can("branches.write");

    body.append(
      row([
        branch.code,
        branch.name,
        `${branch.radiusMeters} م`,
        branch.timezone,
        branch.managerName ?? "غير محدّد",
        save,
      ]),
    );

    // نضع القائمة المنسدلة مكان اسم المدير في نفس الصف
    const lastRow = body.lastElementChild;
    const managerCell = lastRow.children[4];
    if (can("branches.write")) {
      managerCell.textContent = "";
      managerCell.append(select);
    }
  }

  if (candidates.length === 0 && can("branches.write")) {
    setAlert(
      el("branches-result"),
      "لا يوجد موظفون بدور «مدير فرع» بعد — أضِف موظفاً بهذا الدور أولاً.",
      "warn",
    );
  }
}

/* ── ربط الأحداث ──────────────────────────────────────────── */

export function initPeopleModule(context) {
  ctx = context;

  el("employee-card").hidden = !can("employees.write");
  el("schedule-card").hidden = !(can("schedules.manage") || can("employees.write"));
  el("perm-card").hidden = !can("permissions.manage");

  el("employee-reset").addEventListener("click", () => editEmployee(null));

  el("employee-form").addEventListener("submit", async (event) => {
    event.preventDefault();
    const submit = el("employee-submit");
    const values = readEmployeeForm();

    if (!values.employeeCode || !values.fullName) {
      setAlert(el("employee-result"), "الرقم الوظيفي والاسم الكامل مطلوبان.", "error");
      return;
    }

    setBusy(submit, true);
    const result = editingEmployeeId
      ? await api(`/employees/${editingEmployeeId}`, { method: "PATCH", body: values })
      : await api("/employees", { method: "POST", body: values });
    setBusy(submit, false);

    setAlert(
      el("employee-result"),
      result.ok ? result.message : (result.error ?? "تعذّر الحفظ"),
      result.ok ? "ok" : "error",
    );

    if (result.ok) {
      editingEmployeeId = null;
      editEmployee(null);
      await ctx.refreshPeople();
    }
  });

  el("schedule-employee").addEventListener("change", (event) => {
    if (event.target.value) loadScheduleInto(Number(event.target.value));
  });

  el("schedule-form").addEventListener("submit", async (event) => {
    event.preventDefault();
    const employeeId = el("schedule-employee").value;
    if (!employeeId) return;

    const daysOffPerMonth = Number(el("schedule-days-off").value);
    const offDays = selectedOffDays();
    const expectedWeekly = daysOffPerMonth === 2 ? 1 : 2;

    if (offDays.length > 0 && offDays.length !== expectedWeekly) {
      setAlert(
        el("schedule-result"),
        `اختيار ${daysOffPerMonth} أيام شهرياً يعني تحديد ${expectedWeekly} يوم أسبوعياً بالضبط.`,
        "error",
      );
      return;
    }

    const result = await api(`/employees/${employeeId}/schedule`, {
      method: "PUT",
      body: {
        shiftStart: el("schedule-start").value,
        shiftEnd: el("schedule-end").value,
        dailyHours: Number(el("schedule-hours").value || 8),
        breakMinutes: Number(el("schedule-break").value || 0),
        graceMinutes: Number(el("schedule-grace").value || 0),
        daysOffPerMonth,
        offDays,
        note: el("schedule-note").value.trim(),
        reason: "تعريف جدول دوام من لوحة الموارد البشرية",
      },
    });

    setAlert(
      el("schedule-result"),
      result.ok ? result.message : (result.error ?? "تعذّر حفظ الجدول"),
      result.ok ? "ok" : "error",
    );

    if (result.ok) await refreshSchedules();
  });

  el("perm-load").addEventListener("click", loadPermissions);
  el("perm-employee").addEventListener("change", loadPermissions);

  el("perm-form").addEventListener("submit", async (event) => {
    event.preventDefault();
    const employeeId = el("perm-employee").value;
    if (!employeeId) return;

    const overrides = [...document.querySelectorAll("[data-permission-code]")]
      .filter((select) => select.value)
      .map((select) => ({
        permissionCode: select.dataset.permissionCode,
        effect: select.value,
      }));

    const result = await api(`/employees/${employeeId}/permissions`, {
      method: "PUT",
      body: { overrides, reason: el("perm-reason").value.trim() },
    });

    setAlert(
      el("perm-result"),
      result.ok ? result.message : (result.error ?? "تعذّر حفظ التخصيص"),
      result.ok ? "ok" : "error",
    );
  });

  el("branches-refresh").addEventListener("click", refreshBranchesPanel);
}
