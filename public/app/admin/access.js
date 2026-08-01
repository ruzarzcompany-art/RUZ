/**
 * شاشة «إدارة الصلاحيات»: تضبط درجات الوصول على بنود النظام لنطاق واحد من
 * ثلاثة — موظف محدّد، قسم كامل، أو مسمى وظيفي.
 *
 * الشاشة هي المصدر النهائي للصلاحيات: أي بند تُفعَّل له «قاعدة صريحة» تصبح
 * درجته المحفوظة هنا هي النافذة، تتجاوز ما يمنحه «الدور» رفعاً أو خفضاً أو
 * سحباً كاملاً (درجة صفر). والبنود بلا قاعدة صريحة تبقى على تصنيف الدور.
 *
 * كل بند يُعرض بثلاث درجات تراكمية (قراءة، تسجيل حركة، إضافة/تعديل) ودرجة
 * موافقات رابعة لا تظهر إلا حيث يوجد اعتماد فعلي، إضافة إلى درجة «حذف»
 * مستقلة تماماً تُمنح أو تُسحب وحدها. القاموس القادم من الخادم هو من يحدّد
 * المتاح لكل بند.
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
  catalog: { scopes: [], levels: [], modules: [], deleteGrade: null },
  employees: [],
  departments: [],
  jobTitles: [],
  /**
   * القواعد الصريحة المعروضة حالياً: `moduleKey → { level, canDelete }`.
   * وجود المفتاح يعني قاعدة صريحة تتجاوز الدور، وغيابه يعني «حسب الدور».
   */
  rules: {},
  /** ما يمنحه الدور وحده لهذا الموظف (نطاق الموظف فقط) — للعرض المقارن */
  baseline: null,
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

/** هل لهذا البند درجة حذف أصلاً؟ (بنود القراءة الصِرفة لا حذف فيها) */
function deleteAvailable(module) {
  return Boolean(module.delete?.available);
}

/** القاعدة الصريحة للبند إن وُجدت، وإلا `null` (أي: حسب الدور). */
function ruleFor(moduleKey) {
  return state.rules[moduleKey] ?? null;
}

function levelShort(level) {
  return state.catalog.levels.find((entry) => entry.level === level)?.short ?? String(level);
}

/** وصف مختصر لما يمنحه الدور وحده في هذا البند (نطاق الموظف فقط). */
function baselineText(moduleKey) {
  if (!state.baseline) return "";
  const level = state.baseline.levels?.[moduleKey] ?? 0;
  const canDelete = Boolean(state.baseline.deletes?.[moduleKey]);
  if (level <= 0 && !canDelete) return "الدور وحده: لا شيء";
  const parts = [];
  if (level > 0) parts.push(`${level} — ${levelShort(level)}`);
  if (canDelete) parts.push("حذف");
  return `الدور وحده: ${parts.join(" + ")}`;
}

/** يُنشئ قاعدة صريحة للبند مبدوءة بما يمنحه الدور حالياً (أو صفر). */
function enableRule(moduleKey) {
  state.rules[moduleKey] = {
    level: state.baseline?.levels?.[moduleKey] ?? 0,
    canDelete: Boolean(state.baseline?.deletes?.[moduleKey]),
  };
  renderMatrix();
}

function disableRule(moduleKey) {
  delete state.rules[moduleKey];
  renderMatrix();
}

/**
 * الدرجة التي تُحفظ عند تفعيل خانة: الدرجات 1–3 تراكمية، فالمحفوظ هو أعلى
 * خانة مفعّلة. والصفر هنا سحبٌ صريح لا إلغاءٌ للقاعدة — القاعدة تبقى قائمة.
 */
function applyLevel(moduleKey, level) {
  const rule = ruleFor(moduleKey);
  if (!rule) return;
  rule.level = Math.max(0, level);
  renderMatrix();
}

function applyDelete(moduleKey, canDelete) {
  const rule = ruleFor(moduleKey);
  if (!rule) return;
  rule.canDelete = canDelete;
  renderMatrix();
}

/** خانة اختيار داخل خلية جدول، مع خلية «—» حين لا تنطبق الدرجة. */
function checkboxCell({ checked, disabled, label, onChange, extraClass }) {
  const cell = document.createElement("td");
  cell.className = extraClass ? `matrix__cell ${extraClass}` : "matrix__cell";

  const box = document.createElement("input");
  box.type = "checkbox";
  box.checked = checked;
  box.disabled = disabled;
  box.setAttribute("aria-label", label);
  box.addEventListener("change", () => onChange(box.checked));

  cell.append(box);
  return cell;
}

function offCell(title) {
  const cell = document.createElement("td");
  cell.className = "matrix__cell matrix__cell--off";
  cell.textContent = "—";
  cell.title = title;
  return cell;
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
      cell.colSpan = 7;
      cell.textContent = module.group;
      groupRow.append(cell);
      body.append(groupRow);
    }

    const rule = ruleFor(module.key);
    const tr = document.createElement("tr");
    if (rule) tr.classList.add("matrix__row--ruled");

    const nameCell = document.createElement("td");
    const name = document.createElement("span");
    name.className = "perm__label";
    name.textContent = module.label;
    const hint = document.createElement("span");
    hint.className = "perm__hint";
    hint.textContent = module.hint;
    nameCell.append(name, hint);

    const baseline = baselineText(module.key);
    if (baseline) {
      const base = document.createElement("span");
      base.className = "perm__hint";
      base.textContent = baseline;
      nameCell.append(base);
    }

    if (rule && rule.level === 0 && !rule.canDelete) {
      const warn = document.createElement("span");
      warn.className = "perm__hint";
      warn.textContent = "مسحوب بالكامل — لا يُتاح هذا البند مهما منح الدور";
      nameCell.append(warn);
    }

    tr.append(nameCell);

    // عمود «قاعدة صريحة»: وجوده يعني أن هذا الصف يتجاوز الدور
    tr.append(
      checkboxCell({
        checked: Boolean(rule),
        disabled: !editable,
        label: `${module.label} — قاعدة صريحة تتجاوز الدور`,
        extraClass: "matrix__cell--rule",
        onChange: (checked) =>
          checked ? enableRule(module.key) : disableRule(module.key),
      }),
    );

    const allowed = availableLevels(module);
    const current = rule?.level ?? 0;

    const levelCell = (level) => {
      if (!allowed.includes(level)) {
        return offCell("هذه الدرجة لا تنطبق على هذا البند");
      }
      return checkboxCell({
        checked: Boolean(rule) && current >= level,
        disabled: !editable || !rule,
        label: `${module.label} — الدرجة ${level}`,
        onChange: (checked) => {
          if (checked) {
            // تفعيل درجة يمنح ما تحتها تلقائياً (المحفوظ أعلى درجة)
            applyLevel(module.key, level);
          } else {
            // إلغاء درجة يُلغي ما فوقها: نهبط إلى أعلى درجة متاحة تحتها
            const below = allowed.filter((entry) => entry < level);
            applyLevel(module.key, below.length === 0 ? 0 : Math.max(...below));
          }
        },
      });
    };

    for (const level of [1, 2, 3]) tr.append(levelCell(level));

    // درجة الحذف مستقلة تماماً: لا تتبع الدرجات ولا تتبع الموافقات
    if (deleteAvailable(module)) {
      tr.append(
        checkboxCell({
          checked: Boolean(rule?.canDelete),
          disabled: !editable || !rule,
          label: `${module.label} — ${module.delete.hint ?? "الحذف"}`,
          extraClass: "matrix__cell--delete",
          onChange: (checked) => applyDelete(module.key, checked),
        }),
      );
    } else {
      tr.append(offCell("لا يوجد حذف في هذا البند"));
    }

    tr.append(levelCell(4));

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
    const marks = [];
    if (item.withdrawn > 0) marks.push(`${item.withdrawn} مسحوب`);
    if (item.deletes > 0) marks.push(`${item.deletes} حذف`);

    body.append(
      row([
        SCOPE_LABELS[item.scopeType] ?? item.scopeType,
        item.employeeCode ? `${item.employeeCode} — ${item.label}` : item.label,
        `${item.modules} بنداً`,
        `${item.maxLevel} — ${levelLabel(item.maxLevel)}`,
        marks.length > 0 ? marks.join(" • ") : "—",
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

  state.rules = {};
  for (const [moduleKey, level] of Object.entries(result.levels ?? {})) {
    state.rules[moduleKey] = {
      level: Number(level) || 0,
      canDelete: Boolean(result.deletes?.[moduleKey]),
    };
  }
  state.baseline = result.baseline ?? null;
  state.loadedScope = { scopeType: type, scopeKey: key, label: result.scope?.label ?? key };
  renderMatrix();

  const notes = Object.values(result.notes ?? {});
  el("access-note").value = notes[0] ?? "";
  el("access-affected").textContent = `تنطبق على ${result.affected ?? 0} موظفاً`;

  const count = Object.keys(state.rules).length;
  const withdrawn = Object.values(state.rules).filter(
    (rule) => rule.level === 0 && !rule.canDelete,
  ).length;
  setAlert(
    el("access-result"),
    count === 0
      ? `لا توجد قواعد صريحة لـ«${state.loadedScope.label}» — يعمل أصحابه على تصنيف أدوارهم.`
      : `حُمِّلت ${count} قاعدة صريحة لـ«${state.loadedScope.label}»` +
          (withdrawn > 0 ? `، منها ${withdrawn} بنداً مسحوباً بالكامل.` : "."),
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

  const rules = {};
  for (const [moduleKey, rule] of Object.entries(state.rules)) {
    rules[moduleKey] = { level: rule.level, canDelete: Boolean(rule.canDelete) };
  }

  const submit = el("access-save");
  setBusy(submit, true);
  const result = await api("/access/rules", {
    method: "PUT",
    body: {
      scopeType: type,
      scopeKey: key,
      rules,
      note: el("access-note").value.trim(),
    },
  });
  setBusy(submit, false);

  if (!result.ok) {
    setAlert(el("access-result"), result.error ?? "تعذّر حفظ القاعدة", "error");
    return;
  }

  el("access-affected").textContent = `تنطبق على ${result.affected ?? 0} موظفاً`;
  await refreshRules();
  // إعادة التحميل تُظهر الخلفية والمحصّلة الفعلية بعد الحفظ فوراً
  if (type === "employee") await loadScope();
  await previewEffective();
  setAlert(el("access-result"), result.message, "ok");
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
      state.rules = {};
      renderMatrix();
      el("access-affected").textContent = "لا توجد قاعدة لهذا النطاق";
    }
    await refreshRules();
    await previewEffective();
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
  const deletes = result.moduleDelete ?? {};
  const baseLevels = result.baseline?.levels ?? {};
  const baseDeletes = result.baseline?.deletes ?? {};

  const rows = state.catalog.modules.filter(
    (module) =>
      (levels[module.key] ?? 0) > 0 ||
      deletes[module.key] ||
      (baseLevels[module.key] ?? 0) > 0,
  );
  el("access-preview-empty").hidden = rows.length > 0;

  if (rows.length === 0) {
    el("access-preview-empty").textContent =
      "لا يملك هذا الموظف أي درجة على بنود النظام.";
    return;
  }

  for (const module of rows) {
    const level = levels[module.key] ?? 0;
    const spec = state.catalog.levels.find((entry) => entry.level === level);
    const baseLevel = baseLevels[module.key] ?? 0;
    const baseDelete = Boolean(baseDeletes[module.key]);
    const changed = level !== baseLevel || Boolean(deletes[module.key]) !== baseDelete;

    // «المصدر» يفصل ما فرضته القاعدة عمّا ورثه من تصنيف الدور
    let source = "الدور";
    if (changed) {
      source =
        level > baseLevel || (deletes[module.key] && !baseDelete)
          ? "قاعدة صلاحيات — رفع"
          : "قاعدة صلاحيات — خفض / سحب";
    }

    body.append(
      row([
        module.label,
        level > 0 ? `${level} — ${spec?.label ?? ""}` : "٠ — لا وصول",
        module.delete?.available ? (deletes[module.key] ? "نعم" : "لا") : "—",
        source,
        level > 0 ? (spec?.hint ?? "—") : "البند محجوب عن هذا الموظف",
      ]),
    );
  }
}

/* ── التهيئة ─────────────────────────────────────────────────── */

export function initAccessModule({ can }) {
  state.can = can;

  el("access-scope-type").addEventListener("change", () => {
    syncScopeFields();
    state.rules = {};
    state.baseline = null;
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
    state.rules = {};
    renderMatrix();
    setAlert(
      el("access-result"),
      "أُلغيت كل القواعد الصريحة — اضغط «حفظ القاعدة» ليعود أصحاب النطاق إلى تصنيف أدوارهم.",
      "warn",
    );
  });

  el("access-withdraw").addEventListener("click", () => {
    // سحب كامل: قاعدة صريحة بدرجة صفر على كل بند، تتجاوز أي دور
    state.rules = {};
    for (const module of state.catalog.modules) {
      state.rules[module.key] = { level: 0, canDelete: false };
    }
    renderMatrix();
    setAlert(
      el("access-result"),
      "ضُبطت كل البنود على السحب الكامل — اضغط «حفظ القاعدة» لتطبيقها مهما كان الدور.",
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
  for (const id of ["access-save", "access-clear", "access-withdraw", "access-delete"]) {
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
    deleteGrade: result.deleteGrade ?? null,
  };
  state.employees = result.employees ?? [];
  state.departments = result.departments ?? [];
  state.jobTitles = result.jobTitles ?? [];

  fillScopePickers();
  syncScopeFields();
  renderMatrix();
  await refreshRules();
}
