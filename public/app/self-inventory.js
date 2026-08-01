/**
 * تسجيل حركة المخزون من تطبيق الموظف.
 *
 * الحركة تُسجَّل على فرع الموظف نفسه (الخادم يستنتجه من الحساب)، والتحقّق
 * والأرصدة كلها في الخادم (`POST /api/inventory/movements` بدرجة 2 في بند
 * «حركة المخزون»). حقول التصنيع الثلاثة هنا تُكمل بعضها بالعلاقة نفسها
 * المستخدمة في اللوحة: الكمية الخام ÷ عدد الوحدات = وزن الوحدة.
 */

import { api, el, formatDate, row, setAlert, setBusy, todayIso } from "./api.js";

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

const state = {
  ready: false,
  items: [],
  movements: [],
  /** آخر ما حرّره المستخدم من حقول التصنيع؛ الأقدم هو المحسوب تلقائياً. */
  order: ["weight", "units", "raw"],
};

/* ── أدوات ─────────────────────────────────────────────────── */

function isManufacture() {
  return el("self-inv-type").value === "manufacture";
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

/* ── تعبئة القوائم ─────────────────────────────────────────── */

function fillItemPickers() {
  const options = state.items.map((item) => {
    const option = document.createElement("option");
    option.value = String(item.id);
    option.textContent = `${item.name} (${item.unit}) — الرصيد ${item.balance}`;
    return option;
  });

  const raw = el("self-inv-item");
  const rawValue = raw.value;
  raw.replaceChildren(...options);
  if (rawValue) raw.value = rawValue;

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

  if (raw === null && units === null && weight === null) {
    hint.textContent =
      "أدخل أي رقمين من الثلاثة ويُحسب الثالث، أو اكتفِ بالكمية الخام وسجّل العدد لاحقاً من اللوحة.";
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
    const grams = /كجم|كيلو|kg/i.test(rawUnit) ? ` (≈ ${roundTo(weight * 1000, 1)} جرام)` : "";
    parts.push(`بوزن ${weight} ${rawUnit} للوحدة${grams}`);
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

  if (values[first] !== null && values[second] !== null) {
    let next = null;
    if (target === "raw") next = roundTo(values.units * values.weight, 2);
    else if (target === "units") next = roundTo(values.raw / values.weight, 2);
    else next = roundTo(values.raw / values.units, 4);

    if (Number.isFinite(next) && next > 0) el(MANUFACTURE_INPUTS[target]).value = String(next);
  }

  renderHint();
}

/** يُظهر حقول التصنيع ويضبط عناوينها على وحدة المادة الخام. */
function applyType() {
  const manufacture = isManufacture();
  const type = el("self-inv-type").value;
  const item = selectedItem("self-inv-item");

  el("self-inv-produced-field").hidden = !manufacture;
  el("self-inv-units-field").hidden = !manufacture;
  el("self-inv-weight-field").hidden = !manufacture;
  el("self-inv-produced-item").required = manufacture;

  el("self-inv-quantity-label").textContent = manufacture
    ? "الكمية الخام"
    : type === "count"
      ? "الكمية المعدودة"
      : "الكمية";

  // وزن الوحدة يُقاس بوحدة المادة الخام لكل وحدة منتجة (كجم لكل سيخ مثلاً)
  el("self-inv-weight-label").textContent = item
    ? `وزن الوحدة (${item.unit} لكل وحدة)`
    : "وزن الوحدة";

  // سعر الفاتورة يلزم الإدخال الشرائي فقط
  el("self-inv-cost-field").hidden = type !== "in";

  const reason = el("self-inv-reason");
  if (manufacture) reason.value = "manufacture";
  else if (type === "count") reason.value = "stocktake";
  else if (type === "in" && reason.value === "manufacture") reason.value = "purchase";
  else if (type === "out" && reason.value === "manufacture") reason.value = "consumption";

  if (manufacture) fillProducedPicker();
  renderHint();
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
      const quantity =
        movement.movementType === "manufacture" && movement.producedUnits > 0
          ? `${movement.quantity} ${unit} ← ${movement.producedUnits} وحدة`
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
  const cost = el("self-inv-cost").value;

  const result = await api("/inventory/movements", {
    method: "POST",
    body: {
      itemId: Number(el("self-inv-item").value),
      movementType: el("self-inv-type").value,
      businessDate: el("self-inv-date").value,
      quantity: Number(el("self-inv-quantity").value || 0),
      unitCost: cost === "" ? undefined : Number(cost),
      reason: el("self-inv-reason").value,
      reference: el("self-inv-reference").value.trim(),
      notes: el("self-inv-notes").value.trim(),
      producedItemId: manufacture ? Number(el("self-inv-produced-item").value) || undefined : undefined,
      producedUnits: manufacture ? (positiveValue(MANUFACTURE_INPUTS.units) ?? undefined) : undefined,
      unitWeight: manufacture ? (positiveValue(MANUFACTURE_INPUTS.weight) ?? undefined) : undefined,
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
  el("self-inv-type").addEventListener("change", applyType);
  el("self-inv-item").addEventListener("change", () => {
    fillProducedPicker();
    applyType();
  });
  el("self-inv-produced-item").addEventListener("change", renderHint);

  for (const [key, id] of Object.entries(MANUFACTURE_INPUTS)) {
    el(id).addEventListener("input", () => recompute(key));
  }
}
