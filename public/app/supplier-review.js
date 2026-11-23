/**
 * مراجعة «استلام من مورد» — للمشرف في تطبيق الموظف وفي لوحة الإدارة.
 * كل استلام بطاقة: المورد والفاتورة، من استلم وكيف (بالوجه من شاشة الدخول
 * أو من التطبيق)، الأصناف (في الفاتورة ↔ الواصل فعلاً)، وصورة الفاتورة،
 * ثم «اعتماد» أو «رفض». المعتمد يبقى «بانتظار رفع المحاسب» حتى تصل فاتورته
 * من فوديكس فتُربط به آلياً.
 */

import { api, formatDateTime, formatMoney, setAlert, setBusy, todayIso } from "./api.js";

const STATUS_BADGES = { pending: "badge--warn", approved: "badge--ok", rejected: "badge--disputed" };
const SOURCE_LABELS = { kiosk: "من شاشة الدخول", app: "من التطبيق", admin: "من لوحة الإدارة" };
const VERIFY_LABELS = { face: "بالوجه", pin: "بالرقم وPIN", session: "بتسجيل الدخول" };
const qty = (v) => String(Math.round(Number(v || 0) * 1000) / 1000);

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

/**
 * يركّب قائمة المراجعة داخل `container`.
 *   getBranchId  الفرع المختار في لوحة الإدارة (اختياري)
 *   compact      تطبيق الموظف: ما ينتظر الاعتماد فقط بلا فلاتر
 *   onChange     يُستدعى بعد كل تحميل بعدد ما ينتظر الاعتماد
 */
export function mountSupplierReview(container, { getBranchId = () => "", compact = false, onChange } = {}) {
  const from = node("input", { type: "date" });
  const to = node("input", { type: "date" });
  const status = node(
    "select",
    {},
    [
      ["", "الكل"],
      ["pending", "بانتظار اعتماد المشرف"],
      ["awaiting_upload", "معتمد — بانتظار رفع المحاسب"],
      ["approved", "معتمد"],
      ["rejected", "مرفوض"],
    ].map(([value, text]) => node("option", { value, text })),
  );
  const load = node("button", { class: "btn btn--ghost btn--xs", type: "button", text: "عرض" });
  const totals = node("p", { class: "row row--wrap" });
  const alert = node("p", { class: "alert", role: "status", hidden: true });
  const list = node("div");
  const empty = node("p", { class: "empty", hidden: true, text: compact ? "لا استلام بانتظار اعتمادك الآن." : "لا استلامات في هذه الفترة." });
  const field = (labelText, control) =>
    node("label", { class: "field field--sm" }, [node("span", { class: "field__label", text: labelText }), control]);
  const filters = node("div", { class: "row row--wrap", hidden: compact }, [field("من", from), field("إلى", to), field("الحالة", status), load]);

  async function showPhoto(receipt, button, slot) {
    if (!slot.hidden) {
      slot.hidden = true;
      return;
    }
    setBusy(button, true);
    const res = await api(`/supplier-receipts/${receipt.id}/photo`);
    setBusy(button, false);
    if (!res.ok) return setAlert(alert, res.error ?? "تعذّر عرض الصورة", "error");
    const image = node("img", { src: res.image, alt: "صورة الفاتورة" });
    image.style.maxWidth = "100%";
    image.style.borderRadius = "10px";
    slot.replaceChildren(image);
    slot.hidden = false;
  }

  async function review(receipt, decision, button) {
    let note = "";
    if (decision === "reject") {
      const typed = window.prompt("سبب الرفض (إلزامي):", "");
      if (typed === null) return;
      note = typed.trim();
      if (!note) return setAlert(alert, "اكتب سبب الرفض", "error");
    } else if (!window.confirm(`اعتماد استلام ${receipt.supplier || "المورد"}${receipt.invoiceNumber ? ` — فاتورة ${receipt.invoiceNumber}` : ""} بالكميات الواصلة المسجّلة؟`)) {
      return;
    }
    setBusy(button, true);
    const res = await api(`/supplier-receipts/${receipt.id}/review`, { method: "POST", body: { decision, note } });
    setBusy(button, false);
    setAlert(alert, res.ok ? res.message : (res.error ?? "تعذّرت المراجعة"), res.ok ? "ok" : "error");
    if (res.ok) await refresh();
  }

  function card(r, canApprove) {
    const box = node("article", { class: `dc-card${r.status === "pending" ? " sup-pending" : ""}` });
    const badges = node("span", { class: "row row--wrap" }, [node("span", { class: `badge ${STATUS_BADGES[r.status] ?? ""}`, text: r.statusLabel })]);
    if (r.uploadLabel) badges.append(node("span", { class: `badge ${r.uploaded ? "badge--ok" : "badge--warn"}`, text: r.uploadLabel }));
    if (r.diffCount) badges.append(node("span", { class: "badge badge--disputed", text: `${r.diffCount} بفرق عن الفاتورة` }));

    box.append(
      node("div", { class: "card__head" }, [
        node("strong", { text: `${r.supplier || "مورد غير مسمّى"}${r.invoiceNumber ? ` — فاتورة ${r.invoiceNumber}` : ""}` }),
        badges,
      ]),
      node("p", {
        class: "hint",
        text: [
          `استلام رقم ${r.id}`,
          r.invoiceDate ? `تاريخ الفاتورة ${r.invoiceDate}` : "",
          r.invoiceTotal ? `الإجمالي ${formatMoney(r.invoiceTotal)}` : "",
          `المستلِم: ${r.receivedBy || "—"} (${SOURCE_LABELS[r.source] ?? r.source}، ${VERIFY_LABELS[r.verifyMethod] ?? r.verifyMethod})`,
          r.submittedAt ? formatDateTime(r.submittedAt) : r.businessDate,
        ]
          .filter(Boolean)
          .join(" · "),
      }),
    );

    const body = node("tbody");
    for (const line of r.lines) {
      const diff = Number(line.actualQty) - Number(line.invoiceQty);
      const tr = node("tr", { class: diff !== 0 ? "row--attention" : "" }, [
        node("td", { text: line.itemName && line.itemName !== line.name ? `${line.name} ← ${line.itemName}` : line.name }),
        node("td", { text: `${qty(line.invoiceQty)} ${line.unit}` }),
        node("td", { text: `${qty(line.actualQty)} ${line.unit}` }),
        node("td", { text: diff === 0 ? "مطابق" : diff < 0 ? `ناقص ${qty(-diff)}` : `زائد ${qty(diff)}` }),
        node("td", { text: line.unitPrice ? formatMoney(line.unitPrice) : "—" }),
      ]);
      if (!line.itemId) tr.lastChild.textContent += " · غير مربوط بصنف";
      body.append(tr);
    }
    box.append(
      node("div", { class: "table-wrap" }, [
        node("table", { class: "table" }, [
          node("thead", {}, [node("tr", {}, ["الصنف", "في الفاتورة", "الواصل فعلاً", "الفرق", "سعر الوحدة"].map((text) => node("th", { text })))]),
          body,
        ]),
      ]),
    );
    if (r.notes) box.append(node("p", { class: "hint", text: `ملاحظة المستلِم: ${r.notes}` }));
    if (r.reviewedBy) box.append(node("p", { class: "hint", text: `${r.status === "rejected" ? "رفضه" : "اعتمده"}: ${r.reviewedBy}${r.reviewNote ? ` — ${r.reviewNote}` : ""}` }));

    const photoSlot = node("div", { hidden: true });
    const actions = node("div", { class: "row row--wrap" });
    if (r.hasPhoto) {
      const photo = node("button", { class: "btn btn--ghost btn--xs", type: "button", text: "صورة الفاتورة" });
      photo.onclick = () => showPhoto(r, photo, photoSlot);
      actions.append(photo);
    }
    if (r.status === "pending" && canApprove) {
      const approve = node("button", { class: "btn btn--primary btn--xs", type: "button", text: "اعتماد" });
      approve.onclick = () => review(r, "approve", approve);
      const reject = node("button", { class: "btn btn--danger btn--xs", type: "button", text: "رفض" });
      reject.onclick = () => review(r, "reject", reject);
      actions.append(approve, reject);
    }
    box.append(actions, photoSlot);
    return box;
  }

  async function refresh() {
    if (!from.value) from.value = compact ? "" : `${todayIso().slice(0, 8)}01`;
    if (!to.value && !compact) to.value = todayIso();
    const params = new URLSearchParams();
    if (getBranchId()) params.set("branchId", getBranchId());
    if (compact) {
      // المشرف في التطبيق: كل ما ينتظر اعتماده مهما كان تاريخه القريب
      const since = new Date(Date.now() - 30 * 86_400_000).toISOString().slice(0, 10);
      params.set("from", since);
      params.set("status", "pending");
    } else {
      params.set("from", from.value);
      params.set("to", to.value);
      if (status.value) params.set("status", status.value);
    }
    const res = await api(`/supplier-receipts?${params}`);
    if (!res.ok) {
      setAlert(alert, res.error ?? "تعذّر تحميل الاستلامات", "error");
      return res;
    }
    const t = res.totals;
    totals.replaceChildren(
      ...(compact
        ? []
        : [
            ["بانتظار اعتماد المشرف", t.pending],
            ["بانتظار رفع المحاسب", t.awaitingUpload],
            ["مرفوعة في فوديكس", t.uploaded],
            ["بفروق عن الفاتورة", t.withDiffs],
            ["قيمة الفواتير", formatMoney(t.value)],
          ].map(([labelText, value]) => node("span", { class: "chip" }, [`${labelText}: `, node("strong", { text: String(value) })]))),
    );
    list.replaceChildren(...res.receipts.map((r) => card(r, res.canApprove)));
    empty.hidden = res.receipts.length > 0;
    onChange?.(t.pending, res);
    return res;
  }

  load.addEventListener("click", refresh);
  status.addEventListener("change", refresh);
  container.replaceChildren(filters, totals, alert, list, empty);
  return { refresh };
}
