/**
 * تسجيل حركة المخزون من تطبيق الموظف.
 *
 * الحركة تُسجَّل على فرع الموظف نفسه (الخادم يستنتجه من الحساب)، والتحقّق
 * والأرصدة كلها في الخادم (`POST /api/inventory/movements` بدرجة 2 في بند
 * «حركة المخزون»). حقول التصنيع هنا تُكمل بعضها بالمعادلة نفسها المستخدمة في
 * اللوحة: وزن الوحدة المنتجة (جرام مثلاً) × عدد الوحدات = الكمية الخام (كجم).
 *
 * ترتيب الحقول كما في اللوحة: التصنيف أولاً فيُفلتر الأصناف، ثم الصنف، ثم
 * «الحركة وسببها» خياراً واحداً يُستنتج منه السبب.
 */

import { api, el, formatDate, row, setAlert, setBusy, todayIso } from "./api.js";
import { fillActionPicker, parseAction } from "./inventory-actions.js";
import { conversionFactor, fillWeightUnitPicker, setUnitTable } from "./units.js";

const MOVEMENT_LABELS = {
  in: "إدخال",
  out: "صرف",
  count: "جرد",
  manufacture: "تصنيع",
};

const MANUFACTURE_INPUTS = {
  raw: "self-inv-quantity",
  units: "self-inv-units",
  weight: "self-inv-weight",
};

/** قائمة وحدة قياس وزن الوحدة المنتجة (جرام مقابل كيلوجرام للخام). */
const WEIGHT_UNIT_SELECT = "self-inv-weight-unit";

/** قيمة خيار «بدون تصنيف» — حقل التصنيف نصّي وقد يكون فارغاً. */
const NO_CATEGORY = "__none__";

const state = {
  ready: false,
  items: [],
  movements: [],
  /** آخر ما حرّره المستخدم من حقول التصنيع؛ الأقدم هو المحسوب تلقائياً. */
  order: ["weight", "units", "raw"],
};

/* ── أدوات ─────────────────────────────────────────────────── */

/** النوع والسبب معاً من قائمة «الحركة وسببها» الواحدة. */
function currentAction() {
  return parseAction(el("self-inv-action").value);
}

function isManufacture() {
  return currentAction().movementType === "manufacture";
}

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

function selectedItem(id) {
  const value = el(id).value;
  if (!value) return null;
  return state.items.find((entry) => entry.id === Number(value)) ?? null;
}

/** الوحدة المختارة لوزن الوحدة المنتجة، أو الافتراضية لوحدة الخام. */
function selectedWeightUnit() {
  const value = el(WEIGHT_UNIT_SELECT)?.value ?? "";
  if (value !== "") return value;
  const item = selectedItem("self-inv-item");
  return item?.defaultWeightUnit ?? item?.unit ?? "";
}

/** كم من وحدة الخام في وحدة وزن واحدة (جرام ← كجم = 0.001). */
function weightToRawFactor() {
  return conversionFactor(selectedWeightUnit(), selectedItem("self-inv-item")?.unit ?? "");
}

/* ── تعبئة القوائم ─────────────────────────────────────────── */

function optionNode(value, text) {
  const option = document.createElement("option");
  option.value = value;
  option.textContent = text;
  return option;
}

/** تصنيف الصنف كما يُعرض في القائمة (الفراغ يُعرض «بدون تصنيف»). */
function categoryKey(item) {
  return item.category ? item.category : NO_CATEGORY;
}

/** التصنيفات الموجودة فعلاً في أصناف الفرع، مرتّبة عربياً. */
function categoryList() {
  return [...new Set(state.items.map(categoryKey))].sort((a, b) => {
    if (a === NO_CATEGORY) return 1;
    if (b === NO_CATEGORY) return -1;
    return a.localeCompare(b, "ar");
  });
}

/** أصناف التصنيف المختار («» تعني كل الأصناف). */
function itemsOfSelectedCategory() {
  const chosen = el("self-inv-category").value;
  if (!chosen) return state.items;
  return state.items.filter((item) => categoryKey(item) === chosen);
}

/** قائمة التصنيفات: تُبنى من الأصناف، ويبقى اختيار المستخدم إن ظلّ موجوداً. */
function fillCategoryPicker() {
  const picker = el("self-inv-category");
  const previous = picker.value;
  picker.replaceChildren(optionNode("", "كل التصنيفات"));

  for (const key of categoryList()) {
    picker.append(optionNode(key, key === NO_CATEGORY ? "بدون تصنيف" : key));
  }

  picker.value = [...picker.options].some((option) => option.value === previous) ? previous : "";
}

/**
 * قائمة الأصناف — مفلترة على التصنيف المختار. يبقى الصنف المختار إن كان داخل
 * التصنيف، وإلا يُختار أوله كي لا يبقى الحقل بلا قيمة.
 */
function fillItemPickers() {
  const picker = el("self-inv-item");
  const previous = picker.value;

  picker.replaceChildren(
    ...itemsOfSelectedCategory().map((item) =>
      optionNode(String(item.id), `${item.name} (${item.unit}) — الرصيد ${item.balance}`),
    ),
  );

  const stillThere = [...picker.options].some((option) => option.value === previous);
  picker.value = stillThere ? previous : (picker.options[0]?.value ?? "");

  fillProducedPicker();
}

/** المنتج النهائي: كل الأصناف عدا المادة الخام المختارة. */
function fillProducedPicker() {
  const picker = el("self-inv-produced-item");
  const rawId = Number(el("self-inv-item").value);
  const previous = picker.value;

  const placeholder = document.createElement("option");
  placeholder.value = "";
  placeholder.textContent = "اختر المنتج النهائي";

  picker.replaceChildren(
    placeholder,
    ...state.items
      .filter((item) => item.id !== rawId)
      .map((item) => {
        const option = document.createElement("option");
        option.value = String(item.id);
        option.textContent = `${item.name} (${item.unit})`;
        return option;
      }),
  );

  if (previous && picker.querySelector(`option[value="${previous}"]`)) picker.value = previous;
}

/* ── التصنيع ───────────────────────────────────────────────── */

function renderHint() {
  const hint = el("self-inv-hint");
  const item = selectedItem("self-inv-item");

  if (!isManufacture()) {
    hint.textContent = item
      ? `الرصيد الحالي لـ«${item.name}»: ${item.balance} ${item.unit}.`
      : "اختر الصنف لعرض رصيده الحالي.";
    return;
  }

  const raw = positiveValue(MANUFACTURE_INPUTS.raw);
  const units = positiveValue(MANUFACTURE_INPUTS.units);
  const weight = positiveValue(MANUFACTURE_INPUTS.weight);
  const produced = selectedItem("self-inv-produced-item");
  const rawUnit = item?.unit ?? "";
  const weightUnit = selectedWeightUnit();

  if (raw === null && units === null && weight === null) {
    hint.textContent =
      `المعادلة: وزن الوحدة (${weightUnit || "وحدة الوزن"}) × عدد الوحدات = الكمية الخام` +
      `${rawUnit ? ` (${rawUnit})` : ""}. أدخل أي رقمين ويُحسب الثالث، أو اكتفِ بالكمية` +
      " الخام وسجّل العدد لاحقاً من اللوحة.";
    return;
  }

  const parts = [];
  if (raw !== null) parts.push(`يُخصم ${raw} ${rawUnit} من «${item?.name ?? "الخام"}»`);
  if (units !== null) {
    parts.push(
      `ويُضاف ${units} ${produced?.unit ?? "وحدة"} إلى «${produced?.name ?? "المنتج النهائي"}»`,
    );
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

  hint.textContent = `${parts.join(" ")}.`;
}

/** يُكمل الحقل الثالث من الحقلين المُحرَّرين أخيراً، ولا يمنع الحفظ أبداً. */
function recompute(edited) {
  if (!isManufacture()) return;
  if (edited) state.order = [edited, ...state.order.filter((key) => key !== edited)];

  const [first, second, target] = state.order;
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

    if (Number.isFinite(next) && next > 0) el(MANUFACTURE_INPUTS[target]).value = String(next);
  }

  renderHint();
}

/** يُظهر حقول التصنيع ويضبط عناوينها ووحدة وزن الوحدة المنتجة. */
function applyType() {
  const manufacture = isManufacture();
  const { movementType } = currentAction();
  const item = selectedItem("self-inv-item");

  el("self-inv-produced-field").hidden = !manufacture;
  el("self-inv-units-field").hidden = !manufacture;
  el("self-inv-weight-field").hidden = !manufacture;
  el("self-inv-weight-unit-field").hidden = !manufacture;
  el("self-inv-produced-item").required = manufacture;

  el("self-inv-quantity-label").textContent = manufacture
    ? `الكمية الخام${item ? ` (${item.unit})` : ""}`
    : movementType === "count"
      ? "الكمية المعدودة"
      : "الكمية";

  // وزن الوحدة يُقاس بوحدة المنتج النهائي (جرام) لا بوحدة الخام (كجم)
  const weightUnit = fillWeightUnitPicker(el(WEIGHT_UNIT_SELECT), item);
  el("self-inv-weight-label").textContent = weightUnit
    ? `وزن الوحدة المنتجة (${weightUnit})`
    : "وزن الوحدة المنتجة";

  // سعر الفاتورة يلزم الإدخال الشرائي فقط
  el("self-inv-cost-field").hidden = movementType !== "in";

  if (manufacture) fillProducedPicker();
  // تغيير الصنف قد يغيّر وحدة الوزن ومعامل التحويل، فيُعاد الحساب لا العرض فقط
  recompute(null);
}

/* ── التحميل والحفظ ────────────────────────────────────────── */

/** يقرأ أصناف فرع الموظف وآخر حركاته. */
export async function refreshSelfInventory() {
  const [items, movements] = await Promise.all([
    api("/inventory/items"),
    api("/inventory/movements"),
  ]);

  if (!items.ok) {
    setAlert(el("self-inv-result"), items.error ?? "تعذّر تحميل الأصناف", "error");
    return;
  }

  state.items = items.items ?? [];
  // جدول الوحدات يأتي مع الأصناف كي يحسب المتصفح التحويل أثناء الكتابة
  setUnitTable(items.meta?.units);
  fillCategoryPicker();
  fillItemPickers();
  applyType();

  // آخر عشرين حركة تكفي للمراجعة السريعة على شاشة الجوال
  state.movements = movements.ok ? (movements.movements ?? []).slice(0, 20) : [];
  renderMovements();
}

function renderMovements() {
  const body = el("self-inv-table").querySelector("tbody");

  body.replaceChildren(
    ...state.movements.map((movement) => {
      const unit = movement.unit ?? "";
      const weight =
        movement.unitWeight > 0
          ? ` (${movement.unitWeight} ${movement.unitWeightUnit || unit} للوحدة)`
          : "";
      const quantity =
        movement.movementType === "manufacture" && movement.producedUnits > 0
          ? `${movement.quantity} ${unit} ← ${movement.producedUnits} وحدة${weight}`
          : `${movement.quantity} ${unit}`;

      return row([
        formatDate(movement.businessDate),
        movement.itemName ?? movement.itemId,
        MOVEMENT_LABELS[movement.movementType] ?? movement.movementType,
        quantity,
      ]);
    }),
  );

  el("self-inv-empty").hidden = state.movements.length > 0;
}

async function submitMovement(event) {
  event.preventDefault();
  const submit = el("self-inv-submit");
  setBusy(submit, true);

  const manufacture = isManufacture();
  const { movementType, reason } = currentAction();
  const cost = el("self-inv-cost").value;

  const result = await api("/inventory/movements", {
    method: "POST",
    body: {
      itemId: Number(el("self-inv-item").value),
      movementType,
      businessDate: el("self-inv-date").value,
      quantity: Number(el("self-inv-quantity").value || 0),
      unitCost: cost === "" ? undefined : Number(cost),
      reason,
      reference: el("self-inv-reference").value.trim(),
      notes: el("self-inv-notes").value.trim(),
      producedItemId: manufacture ? Number(el("self-inv-produced-item").value) || undefined : undefined,
      producedUnits: manufacture ? (positiveValue(MANUFACTURE_INPUTS.units) ?? undefined) : undefined,
      unitWeight: manufacture ? (positiveValue(MANUFACTURE_INPUTS.weight) ?? undefined) : undefined,
      unitWeightUnit: manufacture ? selectedWeightUnit() || undefined : undefined,
    },
  });

  setBusy(submit, false);
  setAlert(
    el("self-inv-result"),
    result.ok ? result.message : (result.error ?? "تعذّر تسجيل الحركة"),
    result.ok ? "ok" : "error",
  );

  if (!result.ok) return;

  el("self-inv-quantity").value = "";
  el("self-inv-units").value = "";
  el("self-inv-weight").value = "";
  el("self-inv-reference").value = "";
  el("self-inv-notes").value = "";
  await refreshSelfInventory();
}

/** يربط أحداث الشاشة مرة واحدة عند أول فتح. */
export function initSelfInventory() {
  if (state.ready) return;
  state.ready = true;

  el("self-inv-date").value = todayIso();
  el("self-inv-form").addEventListener("submit", submitMovement);
  el("self-inv-refresh").addEventListener("click", () => void refreshSelfInventory());

  // الحركة وسببها خيار واحد: السبب يُستنتج منه فلا حقل ثانٍ يُختار
  fillActionPicker(el("self-inv-action"));
  el("self-inv-action").addEventListener("change", applyType);

  // التصنيف يُختار أولاً فتُفلتر قائمة الأصناف عليه، ثم يُختار الصنف
  el("self-inv-category").addEventListener("change", () => {
    fillItemPickers();
    applyType();
  });

  el("self-inv-item").addEventListener("change", () => {
    fillProducedPicker();
    applyType();
  });
  el("self-inv-produced-item").addEventListener("change", renderHint);

  for (const [key, id] of Object.entries(MANUFACTURE_INPUTS)) {
    el(id).addEventListener("input", () => recompute(key));
  }

  // تغيير وحدة وزن الوحدة يُعيد الحساب بمعامل التحويل الجديد
  el(WEIGHT_UNIT_SELECT).addEventListener("change", () => {
    el("self-inv-weight-label").textContent = `وزن الوحدة المنتجة (${selectedWeightUnit()})`;
    recompute(null);
  });
}
