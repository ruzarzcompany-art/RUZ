/**
 * شاشة «إدارة الصلاحيات»: تمنح درجات الوصول على بنود النظام لنطاق واحد من
 * ثلاثة — موظف محدّد، قسم كامل، أو مسمى وظيفي.
 *
 * كل بند يُعرض بأربع درجات متدرّجة (قراءة، تسجيل حركة، إضافة/تعديل/حذف،
 * إعطاء الموافقات) والدرجات تراكمية: تفعيل درجة يُفعّل ما تحتها، وإلغاء درجة
 * يُلغي ما فوقها. والدرجة الرابعة لا تظهر إلا في البنود التي تحتاج اعتماداً
 * فعلاً — القاموس القادم من الخادم هو من يحدّد المتاح لكل بند.
 *
 * الشاشة واجهة تحرير فقط؛ الفحص الحقيقي يجري في الخادم على كل طلب اعتماداً
 * على الجدول `access_rules`، فتعطيل خانة هنا لا يُغني عن ذلك ولا يُخالفه.
 */

import { api, button, el, formatDateTime, row, setAlert, setBusy } from "../api.js";

const SCOPE_LABELS = {
  employee: "موظف محدّد",
  department: "قسم كامل",
  job_title: "مسمى وظيفي",
};

const state = {
  can: () => false,
  /** القاموس القادم من `/access/catalog` */
  catalog: { scopes: [], levels: [], modules: [] },
  employees: [],
  departments: [],
  jobTitles: [],
  /** الدرجات المعروضة حالياً في الجدول: `moduleKey → level` */
  levels: {},
  /** النطاق المحمَّل حالياً (بعد نجاح التحميل) */
  loadedScope: null,
};

/* ── قراءة النطاق المختار ─────────────────────────────────────── */

function scopeType() {
  return el("access-scope-type").value || "employee";
}

function scopeKey() {
  const type = scopeType();
  if (type === "employee") return el("access-scope-employee").value;
  if (type === "department") return el("access-scope-department").value;
  return el("access-scope-job-title").value;
}

function scopeLabel() {
  const type = scopeType();
  if (type === "employee") {
    const employee = state.employees.find(
      (item) => String(item.id) === el("access-scope-employee").value,
    );
    return employee ? employee.fullName : "";
  }
  return scopeKey();
}

/** يُظهر حقل الجهة المناسب للنطاق المختار ويُخفي البقية. */
function syncScopeFields() {
  const type = scopeType();
  el("access-employee-field").hidden = type !== "employee";
  el("access-department-field").hidden = type !== "department";
  el("access-job-title-field").hidden = type !== "job_title";

  const scope = state.catalog.scopes.find((item) => item.type === type);
  el("access-scope-hint").textContent = scope?.hint ?? "";
}

/* ── تعبئة القوائم ────────────────────────────────────────────── */

function fillSelect(select, values, { placeholder } = {}) {
  if (!select) return;
  const previous = select.value;
  select.textContent = "";

  if (placeholder) {
    const option = document.createElement("option");
    option.value = "";
    option.textContent = placeholder;
    select.append(option);
  }

  for (const item of values) {
    const option = document.createElement("option");
    option.value = item.value;
    option.textContent = item.label;
    select.append(option);
  }

  if (previous && values.some((item) => item.value === previous)) select.value = previous;
}

function fillScopePickers() {
  fillSelect(
    el("access-scope-type"),
    state.catalog.scopes.map((scope) => ({ value: scope.type, label: scope.label })),
  );

  const employeeOptions = state.employees.map((employee) => ({
    value: String(employee.id),
    label: `${employee.employeeCode} — ${employee.fullName}`,
  }));
  fillSelect(el("access-scope-employee"), employeeOptions, { placeholder: "اختر موظفاً" });
  fillSelect(el("access-preview-employee"), employeeOptions, { placeholder: "اختر موظفاً" });
  fillSelect(
    el("access-scope-department"),
    state.departments.map((name) => ({ value: name, label: name })),
    { placeholder: "اختر قسماً" },
  );
  fillSelect(
    el("access-scope-job-title"),
    state.jobTitles.map((name) => ({ value: name, label: name })),
    { placeholder: "اختر مسمى" },
  );
}

/* ── جدول البنود × الدرجات ────────────────────────────────────── */

/** الدرجات المتاحة لبند (كما عرّفها الخادم) — قد تكون غير متتالية. */
function availableLevels(module) {
  return module.levels.map((entry) => entry.level);
}

/**
 * الدرجة التي تُحفظ عند تفعيل خانة: الدرجات تراكمية، فالمحفوظ هو أعلى خانة
 * مفعّلة. وتفعيل درجة غير متاحة في البند مستحيل لأن خانتها لا تُنشأ أصلاً.
 */
function applyLevel(moduleKey, level) {
  if (level <= 0) delete state.levels[moduleKey];
  else state.levels[moduleKey] = level;
  renderMatrix();
}

function renderMatrix() {
  const body = el("access-matrix").querySelector("tbody");
  body.textContent = "";

  const editable = state.can("permissions.manage");
  let currentGroup = null;

  for (const module of state.catalog.modules) {
    if (module.group !== currentGroup) {
      currentGroup = module.group;
      const groupRow = document.createElement("tr");
      groupRow.className = "table__group";
      const cell = document.createElement("th");
      cell.colSpan = 5;
      cell.textContent = module.group;
      groupRow.append(cell);
      body.append(groupRow);
    }

    const tr = document.createElement("tr");

    const nameCell = document.createElement("td");
    const name = document.createElement("span");
    name.className = "perm__label";
    name.textContent = module.label;
    const hint = document.createElement("span");
    hint.className = "perm__hint";
    hint.textContent = module.hint;
    nameCell.append(name, hint);
    tr.append(nameCell);

    const allowed = availableLevels(module);
    const current = state.levels[module.key] ?? 0;

    for (const level of [1, 2, 3, 4]) {
      const cell = document.createElement("td");
      cell.className = "matrix__cell";

      if (!allowed.includes(level)) {
        cell.textContent = "—";
        cell.classList.add("matrix__cell--off");
        cell.title = "هذه الدرجة لا تنطبق على هذا البند";
        tr.append(cell);
        continue;
      }

      const box = document.createElement("input");
      box.type = "checkbox";
      box.checked = current >= level;
      box.disabled = !editable;
      box.dataset.moduleKey = module.key;
      box.dataset.level = String(level);
      box.setAttribute(
        "aria-label",
        `${module.label} — الدرجة ${level}`,
      );

      box.addEventListener("change", () => {
        if (box.checked) {
          // تفعيل درجة يمنح ما تحتها تلقائياً (المحفوظ أعلى درجة)
          applyLevel(module.key, level);
        } else {
          // إلغاء درجة يُلغي ما فوقها: نهبط إلى أعلى درجة متاحة تحتها
          const below = allowed.filter((entry) => entry < level);
          applyLevel(module.key, below.length === 0 ? 0 : Math.max(...below));
        }
      });

      cell.append(box);
      tr.append(cell);
    }

    body.append(tr);
  }
}

/* ── القواعد المحفوظة ────────────────────────────────────────── */

async function refreshRules() {
  const result = await api("/access/rules");
  const body = el("access-rules-table").querySelector("tbody");
  body.textContent = "";

  if (!result.ok) {
    setAlert(el("access-result"), result.error ?? "تعذّر قراءة القواعد", "error");
    return;
  }

  const items = result.items ?? [];
  el("access-rules-empty").hidden = items.length > 0;

  const levelLabel = (level) =>
    state.catalog.levels.find((entry) => entry.level === level)?.short ?? String(level);

  for (const item of items) {
    body.append(
      row([
        SCOPE_LABELS[item.scopeType] ?? item.scopeType,
        item.employeeCode ? `${item.employeeCode} — ${item.label}` : item.label,
        `${item.modules} بنداً`,
        `${item.maxLevel} — ${levelLabel(item.maxLevel)}`,
        item.updatedAt ? formatDateTime(item.updatedAt) : "—",
        actionsFor(item),
      ]),
    );
  }
}

function actionsFor(item) {
  const wrap = document.createElement("div");
  wrap.className = "row row--wrap";

  wrap.append(
    button("تحرير", {
      onClick: () => {
        el("access-scope-type").value = item.scopeType;
        syncScopeFields();
        if (item.scopeType === "employee") {
          el("access-scope-employee").value = String(item.employeeId ?? "");
        } else if (item.scopeType === "department") {
          el("access-scope-department").value = item.scopeKey;
        } else {
          el("access-scope-job-title").value = item.scopeKey;
        }
        void loadScope();
      },
    }),
  );

  if (state.can("permissions.manage")) {
    wrap.append(
      button("حذف", {
        onClick: () => deleteScope(item.scopeType, item.scopeKey, item.label),
      }),
    );
  }

  return wrap;
}

/* ── التحميل والحفظ ──────────────────────────────────────────── */

async function loadScope() {
  const type = scopeType();
  const key = scopeKey();

  if (!key) {
    setAlert(el("access-result"), "اختر الجهة التي تريد تحرير صلاحياتها.", "warn");
    return;
  }

  setBusy(el("access-load"), true);
  const result = await api(
    `/access/rules/detail?scopeType=${encodeURIComponent(type)}&scopeKey=${encodeURIComponent(key)}`,
  );
  setBusy(el("access-load"), false);

  if (!result.ok) {
    setAlert(el("access-result"), result.error ?? "تعذّر قراءة القاعدة", "error");
    return;
  }

  state.levels = { ...(result.levels ?? {}) };
  state.loadedScope = { scopeType: type, scopeKey: key, label: result.scope?.label ?? key };
  renderMatrix();

  const notes = Object.values(result.notes ?? {});
  el("access-note").value = notes[0] ?? "";
  el("access-affected").textContent = `تنطبق على ${result.affected ?? 0} موظفاً`;

  const count = Object.keys(state.levels).length;
  setAlert(
    el("access-result"),
    count === 0
      ? `لا توجد قواعد محفوظة لـ«${state.loadedScope.label}» — يعمل أصحابه بصلاحيات أدوارهم.`
      : `حُمِّلت ${count} بنداً لـ«${state.loadedScope.label}».`,
    "ok",
  );
}

async function saveScope(event) {
  event.preventDefault();

  if (!state.can("permissions.manage")) {
    setAlert(el("access-result"), "لا تملك صلاحية تعديل قواعد الصلاحيات.", "error");
    return;
  }

  const type = scopeType();
  const key = scopeKey();
  if (!key) {
    setAlert(el("access-result"), "اختر الجهة أولاً.", "warn");
    return;
  }

  const submit = el("access-save");
  setBusy(submit, true);
  const result = await api("/access/rules", {
    method: "PUT",
    body: {
      scopeType: type,
      scopeKey: key,
      levels: state.levels,
      note: el("access-note").value.trim(),
    },
  });
  setBusy(submit, false);
  setAlert(
    el("access-result"),
    result.ok ? result.message : (result.error ?? "تعذّر حفظ القاعدة"),
    result.ok ? "ok" : "error",
  );

  if (result.ok) {
    el("access-affected").textContent = `تنطبق على ${result.affected ?? 0} موظفاً`;
    await refreshRules();
  }
}

async function deleteScope(type, key, label) {
  const name = label ?? key;
  if (!window.confirm(`حذف كل قواعد «${name}»؟ يعود أصحابه إلى صلاحيات أدوارهم فقط.`)) {
    return;
  }

  const result = await api(
    `/access/rules?scopeType=${encodeURIComponent(type)}&scopeKey=${encodeURIComponent(key)}`,
    { method: "DELETE" },
  );

  setAlert(
    el("access-result"),
    result.ok ? result.message : (result.error ?? "تعذّر حذف القاعدة"),
    result.ok ? "ok" : "error",
  );

  if (result.ok) {
    if (
      state.loadedScope?.scopeType === type &&
      state.loadedScope?.scopeKey === String(key)
    ) {
      state.levels = {};
      renderMatrix();
      el("access-affected").textContent = "لا توجد قاعدة لهذا النطاق";
    }
    await refreshRules();
  }
}

/* ── المحصّلة الفعلية ────────────────────────────────────────── */

async function previewEffective() {
  const employeeId = el("access-preview-employee").value;
  const body = el("access-preview-table").querySelector("tbody");
  body.textContent = "";

  if (!employeeId) {
    el("access-preview-empty").hidden = false;
    return;
  }

  const result = await api(`/access/effective/${employeeId}`);
  if (!result.ok) {
    el("access-preview-empty").hidden = false;
    setAlert(el("access-result"), result.error ?? "تعذّر حساب المحصّلة", "error");
    return;
  }

  const levels = result.moduleLevels ?? {};
  const rows = state.catalog.modules.filter((module) => (levels[module.key] ?? 0) > 0);
  el("access-preview-empty").hidden = rows.length > 0;

  if (rows.length === 0) {
    el("access-preview-empty").textContent =
      "لا يملك هذا الموظف أي درجة على بنود النظام.";
    return;
  }

  for (const module of rows) {
    const level = levels[module.key];
    const spec = state.catalog.levels.find((entry) => entry.level === level);
    body.append(
      row([module.label, `${level} — ${spec?.label ?? ""}`, spec?.hint ?? "—"]),
    );
  }
}

/* ── التهيئة ─────────────────────────────────────────────────── */

export function initAccessModule({ can }) {
  state.can = can;

  el("access-scope-type").addEventListener("change", () => {
    syncScopeFields();
    state.levels = {};
    state.loadedScope = null;
    el("access-affected").textContent = "لم يُحمَّل نطاق بعد";
    renderMatrix();
  });

  el("access-load").addEventListener("click", loadScope);
  el("access-rules-refresh").addEventListener("click", refreshRules);
  el("access-form").addEventListener("submit", saveScope);
  el("access-preview-run").addEventListener("click", previewEffective);
  el("access-preview-employee").addEventListener("change", previewEffective);

  el("access-clear").addEventListener("click", () => {
    state.levels = {};
    renderMatrix();
    setAlert(
      el("access-result"),
      "أُفرغت الخانات — اضغط «حفظ القاعدة» لإلغاء صلاحيات هذا النطاق فعلياً.",
      "warn",
    );
  });

  el("access-delete").addEventListener("click", () => {
    const key = scopeKey();
    if (!key) {
      setAlert(el("access-result"), "اختر الجهة أولاً.", "warn");
      return;
    }
    void deleteScope(scopeType(), key, scopeLabel() || key);
  });

  // من لا يملك «إدارة الصلاحيات» يقرأ الشاشة فقط
  const editable = can("permissions.manage");
  for (const id of ["access-save", "access-clear", "access-delete"]) {
    el(id).disabled = !editable;
  }
}

export async function refreshAccessPanel() {
  const result = await api("/access/catalog");
  if (!result.ok) {
    setAlert(el("access-result"), result.error ?? "تعذّر قراءة قاموس الصلاحيات", "error");
    return;
  }

  state.catalog = {
    scopes: result.scopes ?? [],
    levels: result.levels ?? [],
    modules: result.modules ?? [],
  };
  state.employees = result.employees ?? [];
  state.departments = result.departments ?? [];
  state.jobTitles = result.jobTitles ?? [];

  fillScopePickers();
  syncScopeFields();
  renderMatrix();
  await refreshRules();
}
