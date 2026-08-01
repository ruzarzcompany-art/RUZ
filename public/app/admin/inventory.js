/**
 * وحدة المخزون اليومي: تسجيل حركة إدخال/إخراج/جرد لكل فرع، مع ورقة جرد
 * يومية تعرض الرصيد الدفتري وحركات اليوم لكل صنف.
 *
 * الأرصدة وفروق الجرد تُحسب في الخادم (حركة الجرد تُثبّت الرصيد على الكمية
 * المعدودة)، وهذه الشاشة تعرضها فقط ولا تعيد حسابها.
 */

import {
  api,
  button,
  el,
  formatMoney,
  openDocument,
  row,
  setAlert,
  setBusy,
  todayIso,
} from "../api.js";
import { createPager } from "../pagination.js";
import {
  conversionFactor,
  fillWeightUnitPicker,
  setUnitTable,
  unitLabel,
} from "../units.js";

const MOVEMENT_LABELS = {
  in: "إدخال",
  out: "إخراج",
  count: "جرد",
  manufacture: "تصنيع",
};
const REASON_LABELS = {
  purchase: "شراء",
  consumption: "استهلاك",
  waste: "هدر",
  transfer: "تحويل بين الفروع",
  stocktake: "جرد",
  manufacture: "تصنيع",
  other: "أخرى",
};

/** قيمة خيار «بدون تصنيف» في قائمة التصنيفات (الحقل نصّي وقد يكون فارغاً). */
const NO_CATEGORY = "__none__";

const state = {
  can: () => false,
  access: {
    canRead: false,
    canWrite: false,
    canManageItems: false,
    canDeleteMovements: false,
    canDeleteItems: false,
  },
  items: [],
  movements: [],
  /** رقم آخر حركة سُجّلت في هذه الجلسة، لطباعة سندها فوراً بعد التسجيل */
  lastMovementId: null,
};

/** تقسيم صفحات كل جدول في الشاشة (العدد الافتراضي موحَّد في `pagination.js`). */
const itemsPager = createPager("inventory-items-table", { unit: "صنف" });
const dailyPager = createPager("inventory-daily-table", { unit: "صنف" });
const movementsPager = createPager("inventory-movements-table", { unit: "حركة" });

/* ── الطباعة ───────────────────────────────────────────────────── */

/** سند حركة واحدة (يُفتح في تبويب الطباعة). */
function printMovement(movementId) {
  openDocument("inventory_movement", { refId: movementId });
}

/** ورقة الجرد اليومي للفرع والتاريخ المعروضين. */
function printDailySheet() {
  const branchId = currentBranch();
  if (!branchId) {
    setAlert(el("inventory-daily-result"), "اختر الفرع لطباعة ورقة الجرد.", "warn");
    return;
  }
  openDocument("inventory_count_sheet", {
    branchId,
    date: el("inventory-daily-date").value || todayIso(),
  });
}

/** كشف الحركات بنفس فلاتر الشاشة حتى يطابق المطبوع المعروض. */
function printMovements() {
  const branchId = currentBranch();
  if (!branchId) {
    setAlert(el("inventory-movements-result"), "اختر الفرع لطباعة الكشف.", "warn");
    return;
  }

  const from = el("inventory-filter-from").value;
  const to = el("inventory-filter-to").value;
  if (from && to && to < from) {
    setAlert(el("inventory-movements-result"), "تاريخ النهاية قبل تاريخ البداية.", "error");
    return;
  }

  openDocument("inventory_movements_range", {
    branchId,
    itemId: el("inventory-filter-item").value,
    movementType: el("inventory-filter-type").value,
    from,
    to,
  });
}

/* ── الأصناف والأرصدة ──────────────────────────────────────────── */

function currentBranch() {
  return el("inventory-branch").value;
}

/** تصنيف الصنف كما يُعرض في القوائم (الفراغ يُعرض كـ«بدون تصنيف»). */
function categoryKey(item) {
  return item.category ? item.category : NO_CATEGORY;
}

/** التصنيفات الموجودة فعلاً في الأصناف، مرتّبة عربياً. */
function categoryList() {
  const keys = [...new Set(state.items.map(categoryKey))];
  return keys.sort((a, b) => {
    if (a === NO_CATEGORY) return 1;
    if (b === NO_CATEGORY) return -1;
    return a.localeCompare(b, "ar");
  });
}

/** أصناف التصنيف المختار في نموذج تسجيل الحركة («» تعني كل الأصناف). */
function itemsOfSelectedCategory() {
  const chosen = el("inventory-category").value;
  if (!chosen) return state.items;
  return state.items.filter((item) => categoryKey(item) === chosen);
}

function optionNode(value, text) {
  const option = document.createElement("option");
  option.value = value;
  option.textContent = text;
  return option;
}

/**
 * قائمة التصنيفات في نموذج الحركة: تُبنى من الأصناف المحمَّلة، ويبقى اختيار
 * المستخدم إن كان تصنيفه ما زال موجوداً.
 */
function fillCategoryPicker() {
  const picker = el("inventory-category");
  const previous = picker.value;
  picker.textContent = "";
  picker.append(optionNode("", "كل التصنيفات"));

  for (const key of categoryList()) {
    picker.append(optionNode(key, key === NO_CATEGORY ? "بدون تصنيف" : key));
  }

  picker.value = [...picker.options].some((option) => option.value === previous)
    ? previous
    : "";
}

/**
 * قائمة أصناف النموذج — مفلترة حسب التصنيف المختار. يبقى الصنف المختار إن
 * كان داخل التصنيف، وإلا يُختار أول صنف فيه حتى لا يبقى الحقل بلا قيمة.
 */
function fillFormItemPicker() {
  const picker = el("inventory-item");
  const previous = picker.value;
  picker.textContent = "";

  for (const item of itemsOfSelectedCategory()) {
    picker.append(optionNode(String(item.id), `${item.code} — ${item.name} (${item.unit})`));
  }

  const stillThere = [...picker.options].some((option) => option.value === previous);
  picker.value = stillThere ? previous : (picker.options[0]?.value ?? "");
}

/** قائمة أصناف فلتر الحركات — كل الأصناف كما كانت. */
function fillFilterItemPicker() {
  const picker = el("inventory-filter-item");
  const previous = picker.value;
  picker.textContent = "";
  picker.append(optionNode("", "كل الأصناف"));

  for (const item of state.items) {
    picker.append(optionNode(String(item.id), `${item.code} — ${item.name} (${item.unit})`));
  }

  picker.value = previous;
}

/** قائمة المنتج النهائي في التصنيع — كل الأصناف عدا المادة الخام المختارة. */
function fillProducedItemPicker() {
  const picker = el("inventory-produced-item");
  if (!picker) return;

  const previous = picker.value;
  const rawId = el("inventory-item").value;
  picker.textContent = "";
  picker.append(optionNode("", "اختر المنتج النهائي"));

  for (const item of state.items) {
    if (String(item.id) === rawId) continue;
    picker.append(optionNode(String(item.id), `${item.code} — ${item.name} (${item.unit})`));
  }

  const stillThere = [...picker.options].some((option) => option.value === previous);
  picker.value = stillThere ? previous : "";
}

function fillItemPickers() {
  fillCategoryPicker();
  fillFormItemPicker();
  fillFilterItemPicker();
  fillProducedItemPicker();
}

/** تكلفة الوحدة الافتراضية تتبع الصنف المختار في النموذج. */
function syncFormUnitCost() {
  const item = state.items.find((entry) => entry.id === Number(el("inventory-item").value));
  if (item) el("inventory-unitcost").value = item.unitCost;
  applyItemPriceMode();
}

/**
 * ينقل صنفاً من جدول الأرصدة إلى نموذج الحركة: التصنيف أولاً حتى تُبنى قائمة
 * الأصناف المفلترة، ثم الصنف نفسه.
 */
function selectItemInForm(item) {
  el("inventory-category").value = categoryKey(item);
  fillFormItemPicker();
  el("inventory-item").value = String(item.id);
  el("inventory-unitcost").value = item.unitCost;
  applyItemPriceMode();
}

function itemRow(item) {
  const balance = document.createElement("span");
  balance.textContent = `${item.balance} ${item.unit}`;
  if (item.belowMinimum) balance.classList.add("is-negative");

  const actions = state.access.canWrite
    ? button("حركة", {
        onClick: () => {
          selectItemInForm(item);
          el("inventory-form").scrollIntoView({ behavior: "smooth", block: "center" });
        },
      })
    : "—";

  return row([
    item.code,
    item.name,
    item.category || "—",
    balance,
    `${item.minQuantity} ${item.unit}`,
    formatMoney(item.unitCost),
    item.priceMode === "variable" ? "متغيّر" : "ثابت",
    formatMoney(item.stockValue),
    item.lastCountDate ?? "—",
    actions,
  ]);
}

function renderItems() {
  itemsPager.render(state.items, itemRow);

  el("inventory-items-empty").hidden = state.items.length > 0;

  const low = state.items.filter((item) => item.belowMinimum).length;
  const value = state.items.reduce((sum, item) => sum + Number(item.stockValue ?? 0), 0);

  const box = el("inventory-summary");
  box.textContent = "";
  for (const [labelText, text] of [
    ["عدد الأصناف", String(state.items.length)],
    ["أصناف تحت الحد الأدنى", String(low)],
    ["قيمة المخزون", formatMoney(value)],
  ]) {
    const chip = document.createElement("span");
    chip.className = "chip";
    const strong = document.createElement("strong");
    strong.textContent = text;
    chip.append(document.createTextNode(`${labelText}: `), strong);
    box.append(chip);
  }
}

async function loadItems() {
  const branchId = currentBranch();
  const result = await api(`/inventory/items${branchId ? `?branchId=${branchId}` : ""}`);

  if (!result.ok) {
    state.items = [];
    renderItems();
    setAlert(el("inventory-result"), result.error ?? "تعذّر تحميل الأصناف", "error");
    return;
  }

  state.items = result.items ?? [];
  // جدول الوحدات يأتي مع الأصناف كي يحسب المتصفح التحويل أثناء الكتابة
  setUnitTable(result.meta?.units);
  fillItemPickers();
  renderItems();
  applyItemPriceMode();
  applyManufacturingFields();
}

/* ── ورقة الجرد اليومي ─────────────────────────────────────────── */

/** يسجّل الكمية المعدودة لصنف مباشرة من ورقة الجرد. */
async function submitCount(itemId, input) {
  const quantity = Number(input.value);
  if (!Number.isFinite(quantity) || quantity < 0) {
    setAlert(el("inventory-daily-result"), "أدخل كمية صحيحة غير سالبة.", "error");
    return;
  }

  const result = await api("/inventory/movements", {
    method: "POST",
    body: {
      itemId,
      branchId: currentBranch() ? Number(currentBranch()) : undefined,
      movementType: "count",
      businessDate: el("inventory-daily-date").value,
      quantity,
      reason: "stocktake",
    },
  });

  setAlert(
    el("inventory-daily-result"),
    result.ok ? result.message : (result.error ?? "تعذّر تسجيل الجرد"),
    result.ok ? "ok" : "error",
  );

  if (result.ok) {
    await loadDaily();
    await loadItems();
  }
}

function dailyRow(line) {
  const balance = document.createElement("span");
  balance.textContent = String(line.balance);
  if (line.belowMinimum) balance.classList.add("is-negative");

  let action = "—";
  if (state.access.canWrite) {
    const input = document.createElement("input");
    input.type = "number";
    input.step = "any";
    input.min = "0";
    input.className = "input input--xs";
    input.value = line.countedToday === null ? "" : String(line.countedToday);
    input.setAttribute("aria-label", `الكمية المعدودة لـ${line.name}`);

    const save = button("حفظ الجرد", { onClick: () => submitCount(line.itemId, input) });
    action = document.createElement("span");
    action.className = "row-actions";
    action.append(input, save);
  }

  return row([
    line.code,
    line.name,
    line.unit,
    balance,
    line.todayIn,
    line.todayOut,
    line.countedToday === null ? "—" : line.countedToday,
    action,
  ]);
}

function renderDaily(payload) {
  const rows = payload.rows ?? [];
  dailyPager.render(rows, dailyRow);
  el("inventory-daily-empty").hidden = rows.length > 0;
}

async function loadDaily() {
  const branchId = currentBranch();
  if (!branchId) {
    setAlert(el("inventory-daily-result"), "اختر الفرع لعرض ورقة الجرد.", "warn");
    return;
  }

  const date = el("inventory-daily-date").value || todayIso();
  const result = await api(`/inventory/daily?branchId=${branchId}&date=${date}`);

  if (!result.ok) {
    setAlert(el("inventory-daily-result"), result.error ?? "تعذّر تحميل ورقة الجرد", "error");
    return;
  }

  el("inventory-daily-date").value = result.businessDate;
  setAlert(el("inventory-daily-result"), "");
  renderDaily(result);
}

/* ── الحركات ───────────────────────────────────────────────────── */

/**
 * الصنف ذو السعر المتغيّر يأخذ سعره من فاتورة الشراء، فحقل سعر الوحدة
 * يصبح إلزامياً في حركة الشراء ويُشار إلى ذلك للمستخدم قبل الإرسال.
 */
function applyItemPriceMode() {
  const item = state.items.find((entry) => entry.id === Number(el("inventory-item").value));
  const isPurchase =
    el("inventory-type").value === "in" && el("inventory-reason").value === "purchase";
  const variable = item?.priceMode === "variable";
  const required = Boolean(variable && isPurchase);

  const costNode = el("inventory-unitcost");
  costNode.required = required;
  costNode.placeholder = required ? "سعر الوحدة من الفاتورة" : "";

  el("inventory-price-hint").textContent = !item
    ? ""
    : required
      ? "سعر هذا الصنف متغيّر: أدخل سعر الوحدة كما في فاتورة الشراء، وسيصبح سعر الصنف المحتسب."
      : variable
        ? "سعر هذا الصنف متغيّر ويُؤخذ من آخر فاتورة شراء."
        : "سعر هذا الصنف ثابت كما هو مُعرَّف في الإعدادات.";
}

/* ── التصنيع: وزن الوحدة × عدد الوحدات = الكمية الخام ──────────── */

const MANUFACTURE_INPUTS = {
  raw: "inventory-quantity",
  units: "inventory-produced-units",
  weight: "inventory-unit-weight",
};

/** قائمة وحدة قياس وزن الوحدة المنتجة (جرام مقابل كيلوجرام للخام). */
const WEIGHT_UNIT_SELECT = "inventory-weight-unit";

/**
 * ترتيب آخر ما حرّره المستخدم من الحقول الثلاثة. الحقل الأقدم في الترتيب هو
 * الذي يُحسب تلقائياً من الحقلين الأحدث، فيبقى ما كتبه المستخدم كما كتبه.
 */
let manufactureOrder = ["weight", "units", "raw"];

function isManufacture() {
  return el("inventory-type").value === "manufacture";
}

/** قيمة رقمية موجبة من حقل، أو `null` إن كان فارغاً أو غير صالح. */
function positiveValue(id) {
  const raw = el(id).value.trim();
  if (raw === "") return null;
  const value = Number(raw);
  return Number.isFinite(value) && value > 0 ? value : null;
}

function roundTo(value, digits) {
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}

function selectedRawItem() {
  return state.items.find((entry) => entry.id === Number(el("inventory-item").value)) ?? null;
}

function selectedProducedItem() {
  const value = el("inventory-produced-item")?.value;
  if (!value) return null;
  return state.items.find((entry) => entry.id === Number(value)) ?? null;
}

/** الوحدة المختارة لوزن الوحدة المنتجة، أو الافتراضية إن لم تُملأ القائمة. */
function selectedWeightUnit() {
  const value = el(WEIGHT_UNIT_SELECT)?.value ?? "";
  if (value !== "") return value;
  const rawItem = selectedRawItem();
  return rawItem?.defaultWeightUnit ?? rawItem?.unit ?? "";
}

/** كم من وحدة الخام في وحدة وزن واحدة (جرام ← كجم = 0.001). */
function weightToRawFactor() {
  return conversionFactor(selectedWeightUnit(), selectedRawItem()?.unit ?? "");
}

/** سطر يشرح العلاقة الحالية بين الأرقام الثلاثة كما ستُحفظ. */
function renderManufactureHint() {
  const hint = el("inventory-manufacture-hint");
  if (!hint) return;

  if (!isManufacture()) {
    hint.hidden = true;
    hint.textContent = "";
    return;
  }

  const raw = positiveValue(MANUFACTURE_INPUTS.raw);
  const units = positiveValue(MANUFACTURE_INPUTS.units);
  const weight = positiveValue(MANUFACTURE_INPUTS.weight);
  const rawItem = selectedRawItem();
  const producedItem = selectedProducedItem();
  const rawUnit = rawItem?.unit ?? "";
  const producedUnit = producedItem?.unit ?? "وحدة";
  const weightUnit = selectedWeightUnit();

  if (raw === null && units === null && weight === null) {
    hint.hidden = false;
    hint.textContent =
      `المعادلة: وزن الوحدة (${weightUnit || "وحدة الوزن"}) × عدد الوحدات = الكمية الخام` +
      `${rawUnit ? ` (${rawUnit})` : ""}. أدخل أي رقمين من الثلاثة ويُحسب الثالث،` +
      " أو اكتفِ بالكمية الخام وسجّل العدد لاحقاً.";
    return;
  }

  const parts = [];
  if (raw !== null) parts.push(`يُخصم ${raw} ${rawUnit} من «${rawItem?.name ?? "الخام"}»`);
  if (units !== null) {
    parts.push(`ويُضاف ${units} ${producedUnit} إلى «${producedItem?.name ?? "المنتج النهائي"}»`);
  } else if (raw !== null) {
    parts.push("ولم يُسجَّل عدد الوحدات بعد — يمكن تسجيله لاحقاً");
  }
  if (weight !== null) {
    // ما يعادله بوحدة الخام يُعرض صريحاً كي تظهر صحة التحويل بين الوحدتين
    const factor = weightToRawFactor();
    const converted =
      factor !== 1 && rawUnit !== "" ? ` (= ${roundTo(weight * factor, 4)} ${rawUnit})` : "";
    parts.push(`بوزن ${weight} ${weightUnit} للوحدة${converted}`);
  }

  hint.hidden = false;
  hint.textContent = `${parts.join(" ")}.`;
}

/**
 * يُكمل الحقل الثالث من الحقلين اللذين حُرِّرا أخيراً، بعد تحويل وزن الوحدة
 * من وحدته إلى وحدة الخام. لا يمنع الحفظ في أي حالة: الكمية الخام وحدها
 * كافية لتسجيل العملية.
 */
function recomputeManufacturing(edited) {
  if (!isManufacture()) return;

  if (edited) {
    manufactureOrder = [edited, ...manufactureOrder.filter((key) => key !== edited)];
  }

  const [first, second, target] = manufactureOrder;
  const values = {
    raw: positiveValue(MANUFACTURE_INPUTS.raw),
    units: positiveValue(MANUFACTURE_INPUTS.units),
    weight: positiveValue(MANUFACTURE_INPUTS.weight),
  };
  const factor = weightToRawFactor();

  if (values[first] !== null && values[second] !== null) {
    let next = null;
    if (target === "raw") next = roundTo(values.units * values.weight * factor, 2);
    else if (target === "units") next = roundTo(values.raw / (values.weight * factor), 2);
    else next = roundTo(values.raw / values.units / factor, 4);

    if (Number.isFinite(next) && next > 0) {
      el(MANUFACTURE_INPUTS[target]).value = String(next);
    }
  }

  renderManufactureHint();
}

/**
 * يُظهر حقول التصنيع ويضبط عناوينها: وزن الوحدة يُقاس بوحدة المنتج المختارة
 * من القائمة (جرام افتراضياً لخام بالكيلوجرام) لا بوحدة الخام.
 */
function applyManufacturingFields() {
  const manufacture = isManufacture();
  const rawItem = selectedRawItem();

  el("inventory-produced-field").hidden = !manufacture;
  el("inventory-units-field").hidden = !manufacture;
  el("inventory-weight-field").hidden = !manufacture;
  el("inventory-weight-unit-field").hidden = !manufacture;
  el("inventory-produced-item").required = manufacture;

  el("inventory-quantity-label").textContent = manufacture
    ? `الكمية الخام${rawItem ? ` (${rawItem.unit})` : ""}`
    : el("inventory-type").value === "count"
      ? "الكمية المعدودة"
      : "الكمية";

  const weightUnit = fillWeightUnitPicker(el(WEIGHT_UNIT_SELECT), rawItem);
  el("inventory-weight-label").textContent = weightUnit
    ? `وزن الوحدة المنتجة (${weightUnit})`
    : "وزن الوحدة المنتجة";

  if (manufacture) fillProducedItemPicker();
  // تغيير الصنف قد يغيّر وحدة الوزن ومعامل التحويل، فيُعاد الحساب لا العرض فقط
  recomputeManufacturing(null);
}

async function submitMovement(event) {
  event.preventDefault();
  const submit = el("inventory-submit");
  setBusy(submit, true);

  const branchId = currentBranch();
  const manufacture = isManufacture();

  const result = await api("/inventory/movements", {
    method: "POST",
    body: {
      itemId: Number(el("inventory-item").value),
      branchId: branchId ? Number(branchId) : undefined,
      movementType: el("inventory-type").value,
      businessDate: el("inventory-date").value,
      quantity: Number(el("inventory-quantity").value || 0),
      unitCost: el("inventory-unitcost").value === "" ? undefined : Number(el("inventory-unitcost").value),
      reason: el("inventory-reason").value,
      reference: el("inventory-reference").value.trim(),
      notes: el("inventory-notes").value.trim(),
      // حقول التصنيع — الخادم يُكمل الناقص منها بالمعادلة والوحدة نفسها
      producedItemId: manufacture ? Number(el("inventory-produced-item").value) || undefined : undefined,
      producedUnits: manufacture ? positiveValue(MANUFACTURE_INPUTS.units) ?? undefined : undefined,
      unitWeight: manufacture ? positiveValue(MANUFACTURE_INPUTS.weight) ?? undefined : undefined,
      unitWeightUnit: manufacture ? selectedWeightUnit() || undefined : undefined,
    },
  });

  setBusy(submit, false);
  setAlert(
    el("inventory-result"),
    result.ok ? result.message : (result.error ?? "تعذّر تسجيل الحركة"),
    result.ok ? "ok" : "error",
  );

  if (result.ok) {
    el("inventory-quantity").value = "";
    el("inventory-produced-units").value = "";
    el("inventory-unit-weight").value = "";
    el("inventory-reference").value = "";
    el("inventory-notes").value = "";
    renderManufactureHint();

    // زر طباعة سند الحركة المسجَّلة يظهر بعد نجاح التسجيل
    state.lastMovementId = result.movement?.id ?? null;
    el("inventory-print-last").hidden = state.lastMovementId === null;

    await Promise.all([loadItems(), loadMovements(), loadDaily()]);
  }
}

async function removeMovement(movement) {
  if (!window.confirm(`حذف حركة ${MOVEMENT_LABELS[movement.movementType]} بتاريخ ${movement.businessDate}؟`)) {
    return;
  }

  const result = await api(`/inventory/movements/${movement.id}`, { method: "DELETE" });
  setAlert(
    el("inventory-movements-result"),
    result.ok ? result.message : (result.error ?? "تعذّر الحذف"),
    result.ok ? "ok" : "error",
  );

  if (result.ok) await Promise.all([loadItems(), loadMovements(), loadDaily()]);
}

/**
 * إكمال عملية تصنيع سُجِّل خامها دون عدد وحداتها: يكفي إدخال العدد أو وزن
 * الوحدة، فيحسب الخادم الآخر من الكمية الخام المسجَّلة ويُضيف المنتج للمخزون.
 */
async function completeProduction(movement) {
  const answer = window.prompt(
    `عدد الوحدات المنتجة من ${movement.quantity} ${movement.unit ?? ""}` +
      " (اتركه فارغاً لإدخال وزن الوحدة بدلاً منه):",
    "",
  );
  if (answer === null) return;

  const producedUnits = Number(answer);
  let unitWeight = null;

  // وزن الوحدة يُدخل بوحدة المنتج (جرام عادةً) ويُحوّله الخادم إلى وحدة الخام
  const rawItem = state.items.find((entry) => entry.id === movement.itemId);
  const weightUnit =
    movement.unitWeightUnit || rawItem?.defaultWeightUnit || unitLabel(movement.unit ?? "");

  if (!(Number.isFinite(producedUnits) && producedUnits > 0)) {
    const weightAnswer = window.prompt(
      `وزن الوحدة المنتجة الواحدة (${weightUnit}):`,
      "",
    );
    if (weightAnswer === null) return;
    unitWeight = Number(weightAnswer);
    if (!(Number.isFinite(unitWeight) && unitWeight > 0)) {
      setAlert(el("inventory-movements-result"), "أدخل عدد الوحدات أو وزن الوحدة.", "warn");
      return;
    }
  }

  const result = await api(`/inventory/movements/${movement.id}/production`, {
    method: "PATCH",
    body: {
      producedUnits: unitWeight === null ? producedUnits : undefined,
      unitWeight: unitWeight ?? undefined,
      unitWeightUnit: weightUnit || undefined,
    },
  });

  setAlert(
    el("inventory-movements-result"),
    result.ok ? result.message : (result.error ?? "تعذّر تسجيل عدد الوحدات"),
    result.ok ? "ok" : "error",
  );

  if (result.ok) await Promise.all([loadItems(), loadMovements(), loadDaily()]);
}

/** نص عمود الكمية: التصنيع يُظهر الخام المخصوم وما نتج عنه ووزن وحدته. */
function manufactureQuantityText(movement) {
  const base = `${movement.quantity} ${movement.unit ?? ""}`;
  if (movement.movementType !== "manufacture") return base;

  const produced = state.items.find((entry) => entry.id === movement.producedItemId);
  if (!(movement.producedUnits > 0)) return `${base} ← بانتظار العدد`;

  const weight =
    movement.unitWeight > 0
      ? ` (${movement.unitWeight} ${movement.unitWeightUnit || movement.unit || ""} للوحدة)`
      : "";
  return `${base} ← ${movement.producedUnits} ${produced?.unit ?? "وحدة"}${weight}`;
}

function movementRow(movement) {
  const variance = document.createElement("span");
  variance.textContent = movement.movementType === "count" ? String(movement.variance) : "—";
  if (movement.variance < 0) variance.classList.add("is-negative");
  if (movement.variance > 0) variance.classList.add("is-positive");

  const actions = document.createElement("span");
  actions.className = "row-actions";
  actions.append(button("طباعة", { onClick: () => printMovement(movement.id) }));

  // تصنيع بلا عدد وحدات — يُكمَّل من هنا دون إعادة تسجيل العملية
  const pendingProduction =
    movement.movementType === "manufacture" && !(movement.producedUnits > 0);
  if (pendingProduction && state.access.canWrite) {
    actions.append(button("تسجيل العدد", { onClick: () => completeProduction(movement) }));
  }
  // الحذف درجة مستقلة: إدارة الأصناف وحدها لا تكفي لحذف حركة
  if (state.access.canDeleteMovements) {
    actions.append(
      button("حذف", {
        className: "btn btn--danger btn--xs",
        onClick: () => removeMovement(movement),
      }),
    );
  }

  return row([
    movement.businessDate,
    movement.branchName ?? "—",
    `${movement.itemCode ?? ""} — ${movement.itemName ?? ""}`,
    MOVEMENT_LABELS[movement.movementType] ?? movement.movementType,
    manufactureQuantityText(movement),
    formatMoney(movement.unitCost),
    formatMoney(movement.totalCost),
    REASON_LABELS[movement.reason] ?? movement.reason,
    variance,
    movement.createdByName ?? "—",
    actions,
  ]);
}

function renderMovements() {
  movementsPager.render(state.movements, movementRow);
  el("inventory-movements-empty").hidden = state.movements.length > 0;
}

export async function loadMovements() {
  const params = new URLSearchParams();
  const branchId = currentBranch();
  const itemId = el("inventory-filter-item").value;
  const type = el("inventory-filter-type").value;
  const from = el("inventory-filter-from").value;
  const to = el("inventory-filter-to").value;

  if (branchId) params.set("branchId", branchId);
  if (itemId) params.set("itemId", itemId);
  if (type) params.set("movementType", type);
  if (from) params.set("from", from);
  if (to) params.set("to", to);

  const query = params.toString();
  const result = await api(`/inventory/movements${query ? `?${query}` : ""}`);

  if (!result.ok) {
    state.movements = [];
    renderMovements();
    setAlert(el("inventory-movements-result"), result.error ?? "تعذّر تحميل الحركات", "error");
    return;
  }

  state.movements = result.movements ?? [];
  setAlert(el("inventory-movements-result"), "");
  renderMovements();
}

/* ── التهيئة ───────────────────────────────────────────────────── */

export function initInventoryModule({ can }) {
  state.can = can;

  el("inventory-form").addEventListener("submit", submitMovement);
  el("inventory-branch").addEventListener("change", async () => {
    await Promise.all([loadItems(), loadMovements(), loadDaily()]);
  });
  el("inventory-filter-run").addEventListener("click", loadMovements);
  el("inventory-daily-run").addEventListener("click", loadDaily);
  el("inventory-daily-print").addEventListener("click", printDailySheet);
  el("inventory-movements-print").addEventListener("click", printMovements);
  el("inventory-print-last").addEventListener("click", () => {
    if (state.lastMovementId !== null) printMovement(state.lastMovementId);
  });

  el("inventory-date").value = todayIso();
  el("inventory-daily-date").value = todayIso();

  // التصنيف يُختار أولاً فتُفلتر قائمة الأصناف عليه، ثم يُختار الصنف
  el("inventory-category").addEventListener("change", () => {
    fillFormItemPicker();
    syncFormUnitCost();
  });

  // تكلفة الوحدة الافتراضية تتبع الصنف المختار
  el("inventory-item").addEventListener("change", () => {
    syncFormUnitCost();
    applyManufacturingFields();
  });

  // الجرد يُثبّت الرصيد، فالسبب يُضبط تلقائياً ويُخفى حقل التكلفة
  el("inventory-type").addEventListener("change", () => {
    const type = el("inventory-type").value;
    el("inventory-reason").value =
      type === "count"
        ? "stocktake"
        : type === "in"
          ? "purchase"
          : type === "manufacture"
            ? "manufacture"
            : "consumption";
    applyManufacturingFields();
    applyItemPriceMode();
  });

  el("inventory-reason").addEventListener("change", applyItemPriceMode);
  el("inventory-produced-item").addEventListener("change", renderManufactureHint);

  // إدخال أي رقمين من الثلاثة يُكمل الثالث
  for (const [key, id] of Object.entries(MANUFACTURE_INPUTS)) {
    el(id).addEventListener("input", () => recomputeManufacturing(key));
  }

  // تغيير وحدة وزن الوحدة يُعيد الحساب بمعامل التحويل الجديد
  el(WEIGHT_UNIT_SELECT).addEventListener("change", () => {
    el("inventory-weight-label").textContent = `وزن الوحدة المنتجة (${selectedWeightUnit()})`;
    recomputeManufacturing(null);
  });
}

export async function refreshInventoryPanel() {
  const access = await api("/inventory/access");
  if (access.ok) state.access = access;

  el("inventory-form").hidden = !state.access.canWrite;

  if (!state.access.canRead) {
    setAlert(el("inventory-result"), "لا تملك صلاحية عرض المخزون.", "error");
    return;
  }

  await Promise.all([loadItems(), loadMovements()]);
  if (currentBranch()) await loadDaily();
}
