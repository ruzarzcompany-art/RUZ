/**
 * استلام من مورد بتصوير الفاتورة — شاشة واحدة تُركَّب في ثلاثة مواضع:
 * شاشة الدخول (بعد التعرّف على الوجه، بتذكرة قصيرة العمر)، تطبيق الموظف،
 * ولوحة الإدارة.
 *
 * الخطوات: صوّر الفاتورة ← تُقرأ آلياً وتظهر أصنافها جاهزة ← عُدّ كل صنف
 * واضغط «تأكيد» (وعدّل الواصل فعلاً إن اختلف) ← إرسال. بعدها يبقى الاستلام
 * معلّقاً حتى يعتمده المشرف.
 */

import { api, formatMoney, setAlert, setBusy } from "./api.js";

/** الفاتورة تحتاج دقة أعلى من صورة الإثبات كي تُقرأ أرقامها الصغيرة. */
const PHOTO_MAX_SIDE = 1900;
const PHOTO_QUALITY = 0.78;
const STATUS_BADGES = { pending: "badge--warn", approved: "badge--ok", rejected: "badge--disputed" };

const qty = (v) => String(Math.round(Number(v || 0) * 1000) / 1000);
const round2 = (v) => Math.round(Number(v || 0) * 100) / 100;
/** إجمالي تكلفة البند = الكمية الواصلة فعلاً (وإن لم تُكتب فكمية الفاتورة) × تكلفة الوحدة */
const lineCost = (line) => round2((line.actualQty ?? line.invoiceQty ?? 0) * (line.unitPrice || 0));

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

async function compressPhoto(file) {
  const bitmap = await createImageBitmap(file);
  let side = PHOTO_MAX_SIDE;
  let quality = PHOTO_QUALITY;
  // حد الخادم 2 ميجابايت: إن زادت الصورة تُصغَّر درجة ثم تُعاد
  for (let attempt = 0; attempt < 4; attempt += 1) {
    const scale = Math.min(1, side / Math.max(bitmap.width, bitmap.height));
    const canvas = document.createElement("canvas");
    canvas.width = Math.max(1, Math.round(bitmap.width * scale));
    canvas.height = Math.max(1, Math.round(bitmap.height * scale));
    canvas.getContext("2d").drawImage(bitmap, 0, 0, canvas.width, canvas.height);
    const dataUrl = canvas.toDataURL("image/jpeg", quality);
    if (dataUrl.length * 0.75 < 1_900_000) {
      bitmap.close?.();
      return dataUrl;
    }
    side = Math.round(side * 0.82);
    quality = Math.max(0.6, quality - 0.06);
  }
  bitmap.close?.();
  throw new Error("الصورة كبيرة جداً");
}

/**
 * يركّب الشاشة داخل `container`.
 *   ticket       تذكرة شاشة الدخول (بلا تسجيل دخول) — فارغة داخل التطبيق
 *   getBranchId  الفرع المختار في لوحة الإدارة (اختياري)
 *   fromAdmin    الاستلام من لوحة الإدارة
 *   onSubmitted  يُستدعى بعد إرسال الاستلام للمشرف
 *   onExpired    يُستدعى إن انتهت مهلة التذكرة
 */
export function mountSupplierReceive(container, { ticket = "", getBranchId = () => "", fromAdmin = false, onSubmitted, onExpired } = {}) {
  const state = { receipt: null, items: [], lines: [], busy: false };

  async function call(path, { method = "GET", body } = {}) {
    if (!ticket) return api(path, { method, body });
    try {
      const response = await fetch(`/api${path}`, {
        method,
        headers: { "X-Receive-Ticket": ticket, ...(body === undefined ? {} : { "Content-Type": "application/json" }) },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
      const payload = await response.json().catch(() => ({ ok: false, error: `تعذّر قراءة رد الخادم (${response.status})` }));
      if (payload.expired) onExpired?.(payload.error);
      return { status: response.status, ...payload };
    } catch {
      return { ok: false, status: 0, error: "تعذّر الاتصال بالخادم. تحقّق من الشبكة." };
    }
  }

  /* ── الخطوة 1: التصوير ── */
  const photoInput = node("input", { type: "file", accept: "image/*", hidden: true });
  photoInput.setAttribute("capture", "environment");
  const shoot = node("button", { class: "btn btn--primary", type: "button" }, [
    node("span", { class: "btn__label", text: "📷 صوّر الفاتورة" }),
    node("span", { class: "btn__spinner" }),
  ]);
  const status = node("p", { class: "hint", text: "صوّر فاتورة المورد كاملة وواضحة وفي إضاءة جيدة — تُقرأ أصنافها آلياً." });
  const alert = node("p", { class: "alert", role: "status", hidden: true });
  const preview = node("img", { alt: "صورة الفاتورة", hidden: true, class: "sup-preview" });

  /* ── الخطوة 2: المطابقة ── */
  const supplier = node("input", { type: "text", maxLength: 160 });
  const invoiceNumber = node("input", { type: "text", maxLength: 80, dir: "ltr" });
  const invoiceDate = node("input", { type: "date" });
  const invoiceTotal = node("input", { type: "number", step: "any", min: "0", inputMode: "decimal" });
  const notes = node("textarea", { rows: 2, maxLength: 1000, placeholder: "نقص، تالف، بديل..." });
  const linesBox = node("div", { class: "sup-lines" });
  const progress = node("p", { class: "hint" });
  const linesSum = node("p", { class: "hint sup-sum" });
  const send = node("button", { class: "btn btn--primary", type: "button" }, [
    node("span", { class: "btn__label", text: "إرسال الاستلام للمشرف" }),
    node("span", { class: "btn__spinner" }),
  ]);
  const confirmAll = node("button", { class: "btn btn--ghost btn--sm", type: "button", text: "الكل مطابق ✓" });
  const addLine = node("button", { class: "btn btn--ghost btn--sm", type: "button", text: "+ صنف لم يُقرأ" });
  const retake = node("button", { class: "btn btn--ghost btn--sm", type: "button", text: "إعادة التصوير" });
  const review = node("div", { hidden: true, class: "form-grid" }, [
    node("div", { class: "form-grid__fields" }, [
      field("المورد", supplier),
      field("رقم الفاتورة", invoiceNumber),
      field("تاريخ الفاتورة", invoiceDate),
      field("إجمالي الفاتورة", invoiceTotal),
    ]),
    node("p", { class: "hint", text: "عُدّ كل صنف وصل وراجع وحدته وكميته وتكلفة الوحدة وإجمالي التكلفة كما في الفاتورة، ثم اضغط «تأكيد» عليه. إن اختلف الواصل عن الفاتورة فاكتب الكمية الواصلة فعلاً قبل التأكيد." }),
    linesBox,
    node("div", { class: "row row--wrap" }, [confirmAll, addLine, retake]),
    field("ملاحظات (اختياري)", notes, "field--wide"),
    linesSum,
    progress,
    send,
  ]);

  /* ── استلاماتي الأخيرة ── */
  const mineBox = node("div", { class: "sup-mine" });

  function itemOptions(selected) {
    return [
      node("option", { value: "", text: "— اختر الصنف من المخزون —" }),
      ...state.items.map((item) => node("option", { value: String(item.id), text: `${item.name} (${item.unit})`, selected: item.id === selected })),
    ];
  }

  function paintProgress() {
    const done = state.lines.filter((line) => line.confirmed).length;
    const diffs = state.lines.filter((line) => line.confirmed && Number(line.actualQty) !== Number(line.invoiceQty)).length;
    progress.textContent = state.lines.length
      ? `أُكّد ${done} من ${state.lines.length} صنف${diffs ? ` — ${diffs} بفرق عن الفاتورة` : ""}.`
      : "لا أصناف بعد — أضف الأصناف يدوياً أو أعد التصوير.";
    send.disabled = state.lines.length === 0 || done !== state.lines.length;
    const sum = round2(state.lines.reduce((total, line) => total + lineCost(line), 0));
    linesSum.textContent = state.lines.length ? `مجموع إجمالي تكلفة البنود: ${formatMoney(sum)} (قارنه بإجمالي الفاتورة قبل الضريبة).` : "";
  }

  function lineCard(line) {
    const card = node("article", { class: "dc-card sup-line" });
    const title = node("strong", { text: line.name || "صنف جديد" });
    const head = node("div", { class: "card__head" }, [title]);
    if (line.confidence === "low") head.append(node("span", { class: "badge badge--warn", text: "قراءة غير واضحة — تأكّد" }));

    const select = node("select", {}, itemOptions(line.itemId));
    const invoice = node("input", { type: "number", step: "any", min: "0", inputMode: "decimal", value: qty(line.invoiceQty) });
    const actual = node("input", { type: "number", step: "any", min: "0", inputMode: "decimal", value: qty(line.actualQty), class: "sup-actual" });
    const unit = node("input", { type: "text", maxLength: 40, value: line.unit || "", placeholder: "كيلو، كرتون، حبة..." });
    const price = node("input", { type: "number", step: "any", min: "0", inputMode: "decimal", value: line.unitPrice ? String(line.unitPrice) : "" });
    const total = node("input", { type: "number", step: "any", min: "0", inputMode: "decimal" });
    const pack = node("input", { type: "number", step: "1", min: "0", inputMode: "numeric", value: line.packSize > 1 ? String(line.packSize) : "", placeholder: "مثال: 12" });
    const packNote = node("span", { class: "hint" });
    const paintTotal = () => {
      const value = lineCost(line);
      total.value = value ? String(value) : "";
      const size = Number(line.packSize) || 0;
      const quantity = Number(line.actualQty ?? line.invoiceQty) || 0;
      packNote.textContent =
        size > 1 && quantity > 0
          ? `${qty(quantity)} ${line.unit || "وحدة"} × ${size} = ${qty(quantity * size)} حبة${line.unitPrice ? ` · تكلفة الحبة ${formatMoney(round2(line.unitPrice / size))}` : ""}`
          : "";
    };
    const ok = node("button", { class: "btn btn--primary btn--sm", type: "button" });
    const remove = node("button", { class: "btn btn--ghost btn--xs", type: "button", text: "حذف البند" });
    const diffNote = node("span", { class: "hint" });

    const paint = () => {
      card.classList.toggle("is-confirmed", line.confirmed);
      ok.textContent = line.confirmed ? "مؤكَّد ✓ (تراجع)" : "تأكيد ✓";
      ok.className = line.confirmed ? "btn btn--ghost btn--sm" : "btn btn--primary btn--sm";
      const diff = Number(line.actualQty) - Number(line.invoiceQty);
      diffNote.textContent = diff === 0 ? "" : diff < 0 ? `ناقص ${qty(-diff)} ${line.unit}` : `زائد ${qty(diff)} ${line.unit}`;
      diffNote.classList.toggle("is-far", diff !== 0);
      paintProgress();
    };
    const unconfirm = () => {
      line.confirmed = false;
      paint();
    };

    select.addEventListener("change", () => {
      const item = state.items.find((entry) => String(entry.id) === select.value);
      line.itemId = item?.id ?? null;
      line.itemName = item?.name ?? "";
      if (item) {
        line.unit = line.unit || item.unit;
        unit.value = line.unit;
        if (!line.name) line.name = item.name;
        title.textContent = line.name;
      }
      unconfirm();
    });
    invoice.addEventListener("input", () => {
      line.invoiceQty = Number(invoice.value) || 0;
      paintTotal();
      unconfirm();
    });
    actual.addEventListener("input", () => {
      line.actualQty = actual.value === "" ? null : Number(actual.value);
      paintTotal();
      unconfirm();
    });
    unit.addEventListener("input", () => {
      line.unit = unit.value.trim();
      paintTotal();
      unconfirm();
    });
    pack.addEventListener("input", () => {
      line.packSize = Math.round(Number(pack.value)) || 0;
      paintTotal();
      unconfirm();
    });
    price.addEventListener("input", () => {
      line.unitPrice = Number(price.value) || 0;
      paintTotal();
      unconfirm();
    });
    // كتابة الإجمالي كما في الفاتورة تحسب تكلفة الوحدة تلقائياً
    total.addEventListener("input", () => {
      const quantity = Number(line.actualQty ?? line.invoiceQty) || 0;
      line.unitPrice = quantity > 0 ? round2((Number(total.value) || 0) / quantity) : 0;
      price.value = line.unitPrice ? String(line.unitPrice) : "";
      unconfirm();
    });
    total.addEventListener("change", paintTotal);
    ok.addEventListener("click", () => {
      if (!line.confirmed) {
        if (!line.name && !line.itemId) return setAlert(alert, "اختر الصنف أولاً", "error");
        if (line.actualQty === null || !(Number(line.actualQty) >= 0)) return setAlert(alert, `«${line.name}»: اكتب الكمية الواصلة فعلاً`, "error");
        setAlert(alert, "");
      }
      line.confirmed = !line.confirmed;
      paint();
    });
    remove.addEventListener("click", () => {
      if (!window.confirm(`حذف «${line.name || "البند"}» من الاستلام؟ احذفه فقط إن لم يكن في الفاتورة.`)) return;
      state.lines = state.lines.filter((entry) => entry !== line);
      card.remove();
      paintProgress();
    });

    card.append(
      head,
      node("div", { class: "form-grid__fields" }, [
        field("الصنف في المخزون", select),
        field("الوحدة", unit),
        field("عدد الحبات في الوحدة (كرتون/شدّة)", pack),
        field("الكمية في الفاتورة", invoice),
        field("الكمية الواصلة فعلاً", actual),
        field("تكلفة الوحدة", price),
        field("إجمالي التكلفة", total),
      ]),
      packNote,
      node("div", { class: "row row--wrap" }, [ok, diffNote, remove]),
    );
    line.paint = paint;
    paintTotal();
    paint();
    return card;
  }

  function drawLines() {
    linesBox.replaceChildren(...state.lines.map(lineCard));
    paintProgress();
  }

  function reset() {
    state.receipt = null;
    state.lines = [];
    linesBox.replaceChildren();
    paintProgress();
    review.hidden = true;
    preview.hidden = true;
    shoot.hidden = false;
    photoInput.value = "";
    notes.value = "";
    status.textContent = "صوّر فاتورة المورد كاملة وواضحة وفي إضاءة جيدة — تُقرأ أصنافها آلياً.";
  }

  shoot.addEventListener("click", () => photoInput.click());
  retake.addEventListener("click", () => {
    if (state.lines.some((line) => line.confirmed) && !window.confirm("إعادة التصوير تمسح ما أكّدته. متابعة؟")) return;
    reset();
    photoInput.click();
  });

  photoInput.addEventListener("change", async () => {
    const file = photoInput.files?.[0];
    if (!file || state.busy) return;
    state.busy = true;
    setBusy(shoot, true);
    setAlert(alert, "");
    try {
      status.textContent = "جارٍ تجهيز الصورة…";
      const photo = await compressPhoto(file);
      preview.src = photo;
      preview.hidden = false;
      status.textContent = "جارٍ قراءة الفاتورة وتجهيز الأصناف… (قد تأخذ نصف دقيقة)";
      const res = await call("/supplier-receipts/analyze", {
        method: "POST",
        body: { photo, branchId: getBranchId() || undefined, fromAdmin: fromAdmin || undefined },
      });
      if (!res.ok) {
        setAlert(alert, res.error ?? "تعذّرت قراءة الفاتورة", "error");
        status.textContent = "أعد المحاولة.";
        return;
      }
      state.receipt = res.receipt;
      state.items = res.items ?? [];
      state.lines = (res.receipt.lines ?? []).map((line) => ({ ...line, confirmed: false }));
      supplier.value = res.receipt.supplier ?? "";
      invoiceNumber.value = res.receipt.invoiceNumber ?? "";
      invoiceDate.value = res.receipt.invoiceDate ?? "";
      invoiceDate.max = res.today ?? "";
      invoiceTotal.value = res.receipt.invoiceTotal ? String(res.receipt.invoiceTotal) : "";
      drawLines();
      review.hidden = false;
      shoot.hidden = true;
      status.textContent = "";
      setAlert(alert, res.message, res.readable ? "ok" : "warn");
    } catch (error) {
      setAlert(alert, error?.message === "الصورة كبيرة جداً" ? "الصورة كبيرة جداً — صوّرها من جديد." : "تعذّرت قراءة الصورة — جرّب التصوير من جديد.", "error");
    } finally {
      state.busy = false;
      setBusy(shoot, false);
    }
  });

  confirmAll.addEventListener("click", () => {
    const open = state.lines.filter((line) => !line.confirmed);
    if (!open.length) return;
    if (!window.confirm(`تأكيد أن ${open.length} صنف وصلت بالكميات المكتوبة أمامها بعد عدّها؟`)) return;
    for (const line of open) {
      if (line.actualQty === null || (!line.name && !line.itemId)) continue;
      line.confirmed = true;
      line.paint?.();
    }
  });

  addLine.addEventListener("click", () => {
    const line = { name: "", itemId: null, itemName: "", unit: "", invoiceQty: 0, actualQty: null, unitPrice: 0, lineTotal: 0, packSize: 0, confirmed: false, confidence: "high" };
    state.lines.push(line);
    linesBox.append(lineCard(line));
    paintProgress();
  });

  send.addEventListener("click", async () => {
    if (state.busy || !state.receipt) return;
    state.busy = true;
    setBusy(send, true);
    const res = await call(`/supplier-receipts/${state.receipt.id}/submit`, {
      method: "POST",
      body: {
        supplier: supplier.value,
        invoiceNumber: invoiceNumber.value,
        invoiceDate: invoiceDate.value || undefined,
        invoiceTotal: invoiceTotal.value || 0,
        notes: notes.value,
        lines: state.lines.map(({ paint, ...line }) => line),
      },
    });
    state.busy = false;
    setBusy(send, false);
    if (!res.ok) {
      setAlert(alert, res.error ?? "تعذّر إرسال الاستلام", "error");
      return;
    }
    reset();
    setAlert(alert, res.message, "ok");
    await refresh();
    onSubmitted?.(res);
  });

  function mineCard(r) {
    const card = node("article", { class: "dc-card" });
    card.append(
      node("div", { class: "card__head" }, [
        node("strong", { text: `${r.supplier || "مورد"}${r.invoiceNumber ? ` — فاتورة ${r.invoiceNumber}` : ""}` }),
        node("span", { class: `badge ${STATUS_BADGES[r.status] ?? ""}`, text: r.statusLabel }),
      ]),
      node("p", {
        class: "hint",
        text: [r.businessDate, `${r.lines.length} صنف`, r.invoiceTotal ? formatMoney(r.invoiceTotal) : "", r.diffCount ? `${r.diffCount} بفرق` : "", r.uploadLabel, r.reviewNote ? `ملاحظة المشرف: ${r.reviewNote}` : ""]
          .filter(Boolean)
          .join(" · "),
      }),
    );
    return card;
  }

  async function refresh() {
    const res = await call("/supplier-receipts/mine");
    if (!res.ok || !res.receipts?.length) {
      mineBox.replaceChildren();
      return;
    }
    mineBox.replaceChildren(node("strong", { text: "استلاماتي الأخيرة" }), ...res.receipts.map(mineCard));
  }

  container.replaceChildren(photoInput, shoot, status, alert, preview, review, mineBox);
  paintProgress();
  return { refresh, reset, openCamera: () => photoInput.click() };
}
