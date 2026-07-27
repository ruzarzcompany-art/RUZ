/**
 * مُصيّر عام لنماذج الموارد البشرية: يقرأ وصف الحقول من `/api/forms/schema`
 * ويبني الحقول والجداول تلقائياً، فتبقى الواجهة والخادم متوافقين دائماً.
 */

import { api, label } from "./api.js";

let schemaPromise;

export async function loadFormsSchema() {
  if (!schemaPromise) {
    schemaPromise = api("/forms/schema").then((result) => {
      if (!result.ok) {
        schemaPromise = undefined;
        throw new Error(result.error ?? "تعذّر قراءة وصف النماذج");
      }
      return new Map(result.resources.map((resource) => [resource.key, resource]));
    });
  }
  return schemaPromise;
}

const INPUT_TYPES = {
  string: "text",
  money: "number",
  number: "number",
  date: "date",
  month: "month",
};

/** حقول القرار لا يعبّئها مُقدّم الطلب. */
const DECISION_FIELDS = new Set(["status", "decisionNote"]);

/**
 * يبني حقول النموذج داخل عنصر.
 * @param {HTMLElement} container
 * @param {object} resource وصف النموذج من الخادم
 * @param {{mode: 'self'|'manage', values?: object, includeDecision?: boolean}} options
 */
export function renderFormFields(container, resource, options = {}) {
  const { mode = "self", values = {}, includeDecision = false } = options;
  container.textContent = "";

  const fields = resource.fields.filter((field) => {
    if (mode === "self") return field.self;
    if (!includeDecision && DECISION_FIELDS.has(field.name)) return false;
    return true;
  });

  for (const field of fields) {
    const wrapper = document.createElement("label");
    wrapper.className = "field field--sm";

    const caption = document.createElement("span");
    caption.className = "field__label";
    caption.textContent = field.required ? `${field.labelAr} *` : field.labelAr;
    wrapper.append(caption);

    let input;

    if (field.kind === "enum" && Array.isArray(field.values)) {
      input = document.createElement("select");
      for (const value of field.values) {
        const option = document.createElement("option");
        option.value = value;
        option.textContent = label(value);
        input.append(option);
      }
    } else if (field.kind === "bool") {
      input = document.createElement("select");
      for (const [value, text] of [
        ["true", "نعم"],
        ["false", "لا"],
      ]) {
        const option = document.createElement("option");
        option.value = value;
        option.textContent = text;
        input.append(option);
      }
    } else if (field.kind === "string" && (field.name === "terms" || field.name === "reason")) {
      input = document.createElement("textarea");
      input.rows = field.name === "terms" ? 4 : 2;
    } else {
      input = document.createElement("input");
      input.type = INPUT_TYPES[field.kind] ?? "text";
      if (field.kind === "money") input.step = "0.01";
      if (field.kind === "number") input.step = "0.25";
      if (field.kind === "money" || field.kind === "number") input.min = "0";
    }

    input.name = field.name;
    input.dataset.kind = field.kind;
    if (field.required) input.required = true;

    const existing = values[field.name];
    if (existing !== undefined && existing !== null) {
      input.value = typeof existing === "boolean" ? String(existing) : String(existing);
    }

    wrapper.append(input);
    container.append(wrapper);
  }

  return fields;
}

/** يجمع قيم الحقول المبنيّة داخل عنصر إلى كائن جاهز للإرسال. */
export function collectFormValues(container) {
  const payload = {};

  for (const input of container.querySelectorAll("[name]")) {
    const raw = input.value;
    const kind = input.dataset.kind;

    if (raw === "" || raw === null) continue;

    if (kind === "money" || kind === "number") {
      const num = Number(raw);
      if (Number.isFinite(num)) payload[input.name] = num;
      continue;
    }

    if (kind === "bool") {
      payload[input.name] = raw === "true";
      continue;
    }

    payload[input.name] = raw;
  }

  return payload;
}

/** أعمدة العرض لكل نموذج في الجداول. */
export const LIST_COLUMNS = {
  advances: [
    { key: "requestDate", label: "التاريخ" },
    { key: "amount", label: "المبلغ", money: true },
    { key: "reason", label: "السبب" },
    { key: "status", label: "الحالة", badge: true },
  ],
  overtime: [
    { key: "workDate", label: "التاريخ" },
    { key: "hours", label: "الساعات" },
    { key: "reason", label: "السبب" },
    { key: "status", label: "الحالة", badge: true },
  ],
  leaves: [
    { key: "startDate", label: "من" },
    { key: "endDate", label: "إلى" },
    { key: "leaveType", label: "النوع", badge: false, translate: true },
    { key: "days", label: "الأيام" },
    { key: "status", label: "الحالة", badge: true },
  ],
  bonuses: [
    { key: "bonusDate", label: "التاريخ" },
    { key: "amount", label: "المبلغ", money: true },
    { key: "reason", label: "السبب" },
    { key: "status", label: "الحالة", badge: true },
  ],
  custody: [
    { key: "issuedAt", label: "تاريخ التسليم" },
    { key: "itemName", label: "البيان" },
    { key: "itemType", label: "النوع", translate: true },
    { key: "quantity", label: "الكمية" },
    { key: "returnedAt", label: "الاستلام" },
    { key: "status", label: "الحالة", badge: true },
  ],
  vouchers: [
    { key: "voucherNumber", label: "رقم السند" },
    { key: "type", label: "النوع", translate: true },
    { key: "voucherDate", label: "التاريخ" },
    { key: "amount", label: "المبلغ", money: true },
    { key: "description", label: "البيان" },
  ],
  contracts: [
    { key: "contractNumber", label: "رقم العقد" },
    { key: "jobTitle", label: "المسمى" },
    { key: "startDate", label: "البداية" },
    { key: "basicSalary", label: "الأساسي", money: true },
    { key: "status", label: "الحالة", badge: true },
  ],
};
