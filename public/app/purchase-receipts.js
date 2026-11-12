/**
 * استلام المشتريات — شاشة واحدة تُركَّب في تطبيق الموظف وفي لوحة الإدارة.
 *
 * الموظف يؤكد ما وصل فعلاً: المورد ورقم الفاتورة، الكمية وسعر الوحدة لكل
 * صنف، إجمالي الفاتورة والمدفوع، وصورة الفاتورة. الخادم ينشئ حركات الإدخال
 * وقيد الخزينة ويعلّم الفروق (`POST /api/purchases/receipts`) — هذه الشاشة
 * تعرض المجاميع للمساعدة فقط ولا يُعتمد على حسابها.
 */

import { api, button, formatMoney, row, setAlert, setBusy, todayIso } from "./api.js";

const PAYMENT_LABELS = { cash: "نقداً من الصندوق", transfer: "تحويل / شبكة", credit: "آجل على المورد" };
const STATUS_LABELS = {
  ok: "سليم",
  needs_review: "يحتاج مراجعة",
  approved: "معتمد",
  disputed: "عليه خلاف",
};
const STATUS_BADGES = { ok: "badge--ok", approved: "badge--ok", needs_review: "badge--warn", disputed: "badge--warn" };

/** أقصى بُعد لصورة الفاتورة وجودتها — تكفي للقراءة وتبقى صغيرة على الجوال. */
const PHOTO_MAX_SIDE = 1600;
const PHOTO_QUALITY = 0.72;

function node(tag, props = {}, children = []) {
  const element = document.createElement(tag);
  for (const [key, value] of Object.entries(props)) {
    if (value === undefined || value === null) continue;
    if (key === "class") element.className = value;
    else if (key === "text") element.textContent = value;
    else if (key in element) element[key] = value;
    else element.setAttribute(key, value);
  }
  element.append(...children);
  return element;
}

function field(labelText, control, extraClass = "") {
  return node("label", { class: `field field--sm ${extraClass}`.trim() }, [
    node("span", { class: "field__label", text: labelText }),
    control,
  ]);
}

const numberOf = (input) => {
  const value = Number.parseFloat(input.value);
  return Number.isFinite(value) ? value : 0;
};

const round2 = (value) => Math.round(value * 100) / 100;

/** يصغّر الصورة ويحوّلها إلى JPEG بصيغة Data URL. */
async function compressPhoto(file) {
  const bitmap = await createImageBitmap(file);
  const scale = Math.min(1, PHOTO_MAX_SIDE / Math.max(bitmap.width, bitmap.height));
  const canvas = document.createElement("canvas");
  canvas.width = Math.max(1, Math.round(bitmap.width * scale));
  canvas.height = Math.max(1, Math.round(bitmap.height * scale));
  canvas.getContext("2d").drawImage(bitmap, 0, 0, canvas.width, canvas.height);
  bitmap.close?.();
  return canvas.toDataURL("image/jpeg", PHOTO_QUALITY);
}

/**
 * يركّب الشاشة داخل `container`.
 * `getBranchId` اختياري: يُرجع الفرع المختار في اللوحة، وبدونه يُستخدم فرع الموظف.
 */
export function mountPurchaseReceipts(container, { getBranchId = () => "" } = {}) {
  const state = { access: {}, items: [], photo: "", busy: false };

  /* ── النموذج ── */
  const supplier = node("input", { type: "text", maxLength: 160, required: true });
  const invoiceNumber = node("input", { type: "text", maxLength: 80 });
  const businessDate = node("input", { type: "date", required: true, value: todayIso(), max: todayIso() });
  const paymentMethod = node(
    "select",
    {},
    Object.entries(PAYMENT_LABELS).map(([value, text]) => node("option", { value, text })),
  );
  const invoiceTotal = node("input", { type: "number", step: "any", min: "0", required: true, inputMode: "decimal" });
  const paidAmount = node("input", { type: "number", step: "any", min: "0", inputMode: "decimal" });
  const notes = node("textarea", { rows: 2, maxLength: 1000 });
  const photoInput = node("input", { type: "file", accept: "image/*" });
  photoInput.setAttribute("capture", "environment");
  const photoHint = node("span", { class: "hint", text: "لم تُرفق صورة بعد." });

  const linesBody = node("tbody");
  const linesTable = node("table", { class: "table purchase-lines" }, [
    node("thead", {}, [
      node("tr", {}, ["الصنف", "الكمية المستلمة", "سعر الوحدة", "الإجمالي", ""].map((text) => node("th", { text }))),
    ]),
    linesBody,
  ]);
  const totalsHint = node("p", { class: "hint" });
  const result = node("p", { class: "alert", role: "status", hidden: true });
  const submit = node("button", { class: "btn btn--primary btn--sm", type: "submit", text: "تسجيل الاستلام" });

  function itemOptions() {
    return [
      node("option", { value: "", text: "— اختر الصنف —" }),
      ...state.items
        .filter((item) => item.isActive)
        .map((item) => node("option", { value: String(item.id), text: `${item.name} (${item.unit})` })),
    ];
  }

  function recomputeTotals() {
    let linesTotal = 0;
    for (const tr of linesBody.children) {
      const quantity = numberOf(tr.querySelector("[data-role=quantity]"));
      const unitCost = numberOf(tr.querySelector("[data-role=cost]"));
      const lineTotal = round2(quantity * unitCost);
      tr.querySelector("[data-role=total]").textContent = lineTotal ? formatMoney(lineTotal) : "—";
      linesTotal += lineTotal;
    }
    linesTotal = round2(linesTotal);
    const invoice = numberOf(invoiceTotal);
    const difference = round2(invoice - linesTotal);
    totalsHint.textContent =
      `مجموع الأصناف: ${formatMoney(linesTotal)}` +
      (invoice > 0
        ? ` — إجمالي الفاتورة: ${formatMoney(invoice)}` +
          (Math.abs(difference) > 0.009 ? ` — الفرق: ${formatMoney(difference)} (سيُعلَّم للمراجعة إن تجاوز 1%)` : " — متطابقان")
        : "");
  }

  function addLine() {
    const itemSelect = node("select", { required: true }, itemOptions());
    itemSelect.dataset.role = "item";
    const quantity = node("input", {
      type: "number",
      step: "any",
      min: "0",
      required: true,
      inputMode: "decimal",
      placeholder: "الكمية المستلمة",
    });
    quantity.dataset.role = "quantity";
    const cost = node("input", {
      type: "number",
      step: "any",
      min: "0",
      required: true,
      inputMode: "decimal",
      placeholder: "سعر الوحدة",
    });
    cost.dataset.role = "cost";
    const total = node("span", { text: "—" });
    total.dataset.role = "total";

    const tr = row([itemSelect, quantity, cost, total, ""]);
    tr.lastChild.append(
      button("حذف", {
        onClick: () => {
          tr.remove();
          if (linesBody.children.length === 0) addLine();
          recomputeTotals();
        },
      }),
    );

    // اقتراح آخر سعر شراء عند اختيار الصنف — يعدّله الموظف بسعر الفاتورة
    itemSelect.addEventListener("change", () => {
      const item = state.items.find((entry) => String(entry.id) === itemSelect.value);
      if (item && !cost.value && item.unitCost > 0) cost.value = String(item.unitCost);
      recomputeTotals();
    });
    quantity.addEventListener("input", recomputeTotals);
    cost.addEventListener("input", recomputeTotals);

    linesBody.append(tr);
  }

  photoInput.addEventListener("change", async () => {
    const file = photoInput.files?.[0];
    state.photo = "";
    if (!file) {
      photoHint.textContent = "لم تُرفق صورة بعد.";
      return;
    }
    try {
      state.photo = await compressPhoto(file);
      photoHint.textContent = `أُرفقت صورة الفاتورة (${Math.round((state.photo.length * 0.75) / 1024)} ك.ب).`;
    } catch {
      photoHint.textContent = "تعذّرت قراءة الصورة — جرّب التصوير من جديد.";
    }
  });

  invoiceTotal.addEventListener("input", recomputeTotals);
  paymentMethod.addEventListener("change", () => {
    paidAmount.placeholder = paymentMethod.value === "credit" ? "0" : "يساوي الإجمالي إن تُرك فارغاً";
  });
  paidAmount.placeholder = "يساوي الإجمالي إن تُرك فارغاً";

  const form = node("form", { class: "form-grid", noValidate: true }, [
    node("div", { class: "form-grid__fields" }, [
      field("المورد", supplier),
      field("رقم الفاتورة", invoiceNumber),
      field("تاريخ الاستلام", businessDate),
      field("طريقة الدفع", paymentMethod),
      field("إجمالي الفاتورة (كما هو مكتوب)", invoiceTotal),
      field("المدفوع فعلاً", paidAmount),
    ]),
    node("div", { class: "table-wrap" }, [linesTable]),
    node("div", { class: "row row--wrap" }, [button("+ صنف آخر", { onClick: addLine })]),
    totalsHint,
    field("صورة الفاتورة", photoInput, "field--wide"),
    photoHint,
    field("ملاحظات (نقص، تالف، بديل...)", notes, "field--wide"),
    submit,
  ]);

  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    if (state.busy) return;

    const lines = [...linesBody.children]
      .map((tr) => ({
        itemId: tr.querySelector("[data-role=item]").value,
        quantity: tr.querySelector("[data-role=quantity]").value,
        unitCost: tr.querySelector("[data-role=cost]").value,
      }))
      .filter((line) => line.itemId || line.quantity || line.unitCost);

    state.busy = true;
    setBusy(submit, true);
    const response = await api("/purchases/receipts", {
      method: "POST",
      body: {
        branchId: getBranchId() || undefined,
        supplier: supplier.value,
        invoiceNumber: invoiceNumber.value,
        businessDate: businessDate.value,
        paymentMethod: paymentMethod.value,
        invoiceTotal: invoiceTotal.value,
        paidAmount: paidAmount.value,
        notes: notes.value,
        photo: state.photo || undefined,
        lines,
      },
    });
    state.busy = false;
    setBusy(submit, false);

    if (!response.ok) {
      setAlert(result, response.error ?? "تعذّر تسجيل الاستلام", "error");
      return;
    }

    setAlert(result, response.message, response.receipt?.status === "needs_review" ? "warn" : "ok");
    form.reset();
    businessDate.value = todayIso();
    state.photo = "";
    photoHint.textContent = "لم تُرفق صورة بعد.";
    linesBody.replaceChildren();
    addLine();
    recomputeTotals();
    await Promise.all([loadItems(), loadReceipts()]);
  });

  /* ── السجل ── */
  const summary = node("p", { class: "row row--wrap" });
  const listBody = node("tbody");
  const listTable = node("table", { class: "table" }, [
    node("thead", {}, [
      node(
        "tr",
        {},
        ["", "التاريخ", "المورد", "الفاتورة", "الإجمالي", "المدفوع", "الأصناف", "الحالة", "المستلِم"].map((text) =>
          node("th", { text }),
        ),
      ),
    ]),
    listBody,
  ]);
  const empty = node("p", { class: "empty", text: "لا توجد استلامات مسجّلة بعد.", hidden: true });
  const listAlert = node("p", { class: "alert", role: "status", hidden: true });
  const preview = node("div", { hidden: true });
  const onlyReview = node("input", { type: "checkbox" });

  async function showPhoto(id) {
    const response = await api(`/purchases/receipts/${id}/photo`);
    if (!response.ok) {
      setAlert(listAlert, response.error ?? "تعذّر عرض الصورة", "error");
      return;
    }
    const image = node("img", { src: response.image, alt: "صورة الفاتورة" });
    image.style.maxWidth = "100%";
    image.style.borderRadius = "10px";
    preview.replaceChildren(
      node("div", { class: "row row--wrap" }, [
        node("strong", { text: `صورة فاتورة الاستلام رقم ${id}` }),
        button("إغلاق", { onClick: () => (preview.hidden = true) }),
      ]),
      image,
    );
    preview.hidden = false;
    preview.scrollIntoView({ behavior: "smooth", block: "nearest" });
  }

  async function review(id, decision, note, trigger) {
    setBusy(trigger, true);
    const response = await api(`/purchases/receipts/${id}/review`, {
      method: "POST",
      body: { decision, note },
    });
    setBusy(trigger, false);
    setAlert(listAlert, response.ok ? response.message : (response.error ?? "تعذّرت المراجعة"), response.ok ? "ok" : "error");
    if (response.ok) await loadReceipts();
  }

  function actionsFor(receipt) {
    const cell = node("div", { class: "row row--wrap" });
    if (receipt.hasPhoto) cell.append(button("الصورة", { onClick: () => showPhoto(receipt.id) }));

    // المعتمد الذي بقي مدفوعه النقدي بلا قيد خزينة يُعاد اعتماده ممن يملك صلاحيتها
    const cashPending = receipt.flags.includes("cash_unposted") && state.access.canPostCash;
    const open = receipt.status === "needs_review" || receipt.status === "ok";
    if (state.access.canReview && (open || cashPending)) {
      cell.append(button("اعتماد", { onClick: (trigger) => review(receipt.id, "approved", "", trigger) }));

      const note = node("input", { type: "text", maxLength: 500, placeholder: "سبب الخلاف", hidden: true });
      cell.append(
        button("خلاف", {
          onClick: (trigger) => {
            if (note.hidden) {
              note.hidden = false;
              note.focus();
              return;
            }
            review(receipt.id, "disputed", note.value, trigger);
          },
        }),
        note,
      );
    }
    return cell;
  }

  function statusCell(receipt) {
    const cell = node("div");
    cell.append(
      node("span", {
        class: `badge ${STATUS_BADGES[receipt.status] ?? ""}`.trim(),
        text: STATUS_LABELS[receipt.status] ?? receipt.status,
      }),
    );
    for (const text of receipt.flagLabels ?? []) cell.append(node("div", { class: "hint", text }));
    if (receipt.reviewNote) cell.append(node("div", { class: "hint", text: `ملاحظة المراجع: ${receipt.reviewNote}` }));
    return cell;
  }

  function paidCell(receipt) {
    return node("div", {}, [
      node("div", { text: formatMoney(receipt.paidAmount) }),
      node("div", { class: "hint", text: PAYMENT_LABELS[receipt.paymentMethod] ?? receipt.paymentMethod }),
    ]);
  }

  async function loadReceipts() {
    const params = new URLSearchParams();
    if (getBranchId()) params.set("branchId", getBranchId());
    if (onlyReview.checked) params.set("status", "needs_review");
    const response = await api(`/purchases/receipts?${params}`);
    if (!response.ok) {
      setAlert(listAlert, response.error ?? "تعذّر تحميل الاستلامات", "error");
      return;
    }

    summary.replaceChildren(
      ...[
        ["عدد الاستلامات", response.summary.count],
        ["إجمالي الفواتير", formatMoney(response.summary.invoiceTotal)],
        ["إجمالي المدفوع", formatMoney(response.summary.paidTotal)],
        ["تحتاج مراجعة", response.summary.needsReview],
      ].map(([labelText, value]) =>
        node("span", { class: "chip" }, [`${labelText}: `, node("strong", { text: String(value) })]),
      ),
    );

    listBody.replaceChildren(
      ...response.receipts.map((receipt) =>
        row([
          // الأزرار أولاً كي تبقى ظاهرة على الشاشات الضيقة بلا تمرير أفقي
          actionsFor(receipt),
          receipt.businessDate,
          receipt.supplier,
          receipt.invoiceNumber || "—",
          formatMoney(receipt.invoiceTotal),
          paidCell(receipt),
          receipt.lines.map((line) => `${line.itemName}: ${line.quantity} ${line.unit}`).join("، "),
          statusCell(receipt),
          receipt.receivedBy || "—",
        ]),
      ),
    );
    empty.hidden = response.receipts.length > 0;
  }

  async function loadItems() {
    const params = new URLSearchParams();
    if (getBranchId()) params.set("branchId", getBranchId());
    const response = await api(`/inventory/items?${params}`);
    if (!response.ok) return;
    state.items = response.items;
    // القوائم المفتوحة تحتفظ باختيارها عند تحديث الأصناف
    for (const select of linesBody.querySelectorAll("[data-role=item]")) {
      const chosen = select.value;
      select.replaceChildren(...itemOptions());
      select.value = chosen;
    }
  }

  onlyReview.addEventListener("change", loadReceipts);

  const formCard = node("div", {}, [
    node("p", {
      class: "hint",
      text:
        "سجّل ما استلمته فعلاً لا ما هو مكتوب فقط: الكمية بعد العدّ أو الوزن، وسعر الوحدة من الفاتورة. " +
        "الاستلام يُدخل الأصناف إلى المخزون ويسجّل المدفوع نقداً في الخزينة تلقائياً.",
    }),
    form,
    result,
  ]);

  container.replaceChildren(
    formCard,
    node("div", { class: "row row--wrap" }, [
      node("strong", { text: "سجل الاستلامات" }),
      node("label", { class: "row", style: "white-space: nowrap" }, [
        onlyReview,
        node("span", { text: "ما يحتاج مراجعة فقط" }),
      ]),
      button("تحديث", { onClick: () => refresh() }),
    ]),
    summary,
    listAlert,
    node("div", { class: "table-wrap" }, [listTable]),
    empty,
    preview,
  );

  addLine();
  recomputeTotals();

  async function refresh() {
    const access = await api("/purchases/access");
    state.access = access.ok ? access : {};
    formCard.hidden = !state.access.canReceive;

    if (!state.access.canRead) {
      setAlert(listAlert, "لا تملك صلاحية عرض المشتريات.", "error");
      return;
    }
    setAlert(listAlert, "", "ok");
    await Promise.all([loadItems(), loadReceipts()]);
  }

  return { refresh };
}
