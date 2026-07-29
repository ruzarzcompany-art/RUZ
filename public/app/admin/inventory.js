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

const MOVEMENT_LABELS = { in: "إدخال", out: "إخراج", count: "جرد" };
const REASON_LABELS = {
  purchase: "شراء",
  consumption: "استهلاك",
  waste: "هدر",
  transfer: "تحويل بين الفروع",
  stocktake: "جرد",
  other: "أخرى",
};

const state = {
  can: () => false,
  access: { canRead: false, canWrite: false, canManageItems: false },
  items: [],
  movements: [],
  /** رقم آخر حركة سُجّلت في هذه الجلسة، لطباعة سندها فوراً بعد التسجيل */
  lastMovementId: null,
};

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

function fillItemPickers() {
  for (const id of ["inventory-item", "inventory-filter-item"]) {
    const picker = el(id);
    const previous = picker.value;
    picker.textContent = "";

    if (id === "inventory-filter-item") {
      const all = document.createElement("option");
      all.value = "";
      all.textContent = "كل الأصناف";
      picker.append(all);
    }

    for (const item of state.items) {
      const option = document.createElement("option");
      option.value = String(item.id);
      option.textContent = `${item.code} — ${item.name} (${item.unit})`;
      picker.append(option);
    }

    picker.value = previous;
  }
}

function renderItems() {
  const body = el("inventory-items-table").querySelector("tbody");
  body.textContent = "";

  for (const item of state.items) {
    const balance = document.createElement("span");
    balance.textContent = `${item.balance} ${item.unit}`;
    if (item.belowMinimum) balance.classList.add("is-negative");

    const actions = state.access.canWrite
      ? button("حركة", {
          onClick: () => {
            el("inventory-item").value = String(item.id);
            el("inventory-unitcost").value = item.unitCost;
            applyItemPriceMode();
            el("inventory-form").scrollIntoView({ behavior: "smooth", block: "center" });
          },
        })
      : "—";

    body.append(
      row([
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
      ]),
    );
  }

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
  fillItemPickers();
  renderItems();
  applyItemPriceMode();
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

function renderDaily(payload) {
  const body = el("inventory-daily-table").querySelector("tbody");
  body.textContent = "";

  for (const line of payload.rows ?? []) {
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

    body.append(
      row([
        line.code,
        line.name,
        line.unit,
        balance,
        line.todayIn,
        line.todayOut,
        line.countedToday === null ? "—" : line.countedToday,
        action,
      ]),
    );
  }

  el("inventory-daily-empty").hidden = (payload.rows ?? []).length > 0;
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

async function submitMovement(event) {
  event.preventDefault();
  const submit = el("inventory-submit");
  setBusy(submit, true);

  const branchId = currentBranch();
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
    el("inventory-reference").value = "";
    el("inventory-notes").value = "";

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

function renderMovements() {
  const body = el("inventory-movements-table").querySelector("tbody");
  body.textContent = "";

  for (const movement of state.movements) {
    const variance = document.createElement("span");
    variance.textContent = movement.movementType === "count" ? String(movement.variance) : "—";
    if (movement.variance < 0) variance.classList.add("is-negative");
    if (movement.variance > 0) variance.classList.add("is-positive");

    const actions = document.createElement("span");
    actions.className = "row-actions";
    actions.append(button("طباعة", { onClick: () => printMovement(movement.id) }));
    if (state.access.canManageItems) {
      actions.append(
        button("حذف", {
          className: "btn btn--danger btn--xs",
          onClick: () => removeMovement(movement),
        }),
      );
    }

    body.append(
      row([
        movement.businessDate,
        movement.branchName ?? "—",
        `${movement.itemCode ?? ""} — ${movement.itemName ?? ""}`,
        MOVEMENT_LABELS[movement.movementType] ?? movement.movementType,
        `${movement.quantity} ${movement.unit ?? ""}`,
        formatMoney(movement.unitCost),
        formatMoney(movement.totalCost),
        REASON_LABELS[movement.reason] ?? movement.reason,
        variance,
        movement.createdByName ?? "—",
        actions,
      ]),
    );
  }

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

  // تكلفة الوحدة الافتراضية تتبع الصنف المختار
  el("inventory-item").addEventListener("change", () => {
    const item = state.items.find((entry) => entry.id === Number(el("inventory-item").value));
    if (item) el("inventory-unitcost").value = item.unitCost;
    applyItemPriceMode();
  });

  // الجرد يُثبّت الرصيد، فالسبب يُضبط تلقائياً ويُخفى حقل التكلفة
  el("inventory-type").addEventListener("change", () => {
    const type = el("inventory-type").value;
    el("inventory-reason").value =
      type === "count" ? "stocktake" : type === "in" ? "purchase" : "consumption";
    el("inventory-quantity-label").textContent =
      type === "count" ? "الكمية المعدودة" : "الكمية";
    applyItemPriceMode();
  });

  el("inventory-reason").addEventListener("change", applyItemPriceMode);
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
