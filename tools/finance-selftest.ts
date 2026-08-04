/**
 * فحص ذاتي لحسابات النقدية وإقفال الشهر — بلا قاعدة بيانات وبلا شبكة.
 *
 * يشغّل السيناريوهات الخمسة المطلوبة على نفس دوال الخادم التي تعمل في
 * الإنتاج (server/finance.ts وقاموس الصلاحيات في server/permissions.ts)،
 * فأي تغيير يكسر معادلة أو يفتح صلاحية يسقط هنا قبل النشر.
 *
 * التشغيل:  npm run test:finance
 */

import assert from "node:assert/strict";
import {
  decisionOutcome,
  invoiceTotal,
  monthBounds,
  monthlyNet,
  parseMonthKey,
  remainingCash,
  settlementFigures,
} from "../server/finance.js";
import {
  MODULE_DELETE_GRADE,
  MODULE_INDEX,
  PERMISSIONS,
  codesForModuleLevel,
  isDeleteAvailable,
} from "../server/permissions.js";

let failures = 0;
const lines: string[] = [];

function check(title: string, run: () => string): void {
  try {
    const detail = run();
    lines.push("  [ناجح] " + title + (detail ? " — " + detail : ""));
  } catch (error) {
    failures += 1;
    lines.push("  [فاشل] " + title + " — " + (error as Error).message);
  }
}

function section(title: string): void {
  lines.push("");
  lines.push(title);
}

/* ── 1) تقفيلة بمصاريف مفصّلة ─────────────────────────────────── */

section("١) تقفيلة بمصاريف مفصّلة (فاتورة واحدة تُخصم مرة واحدة)");

const invoices = [
  { description: "غاز", quantity: 1, unitPrice: 90, amount: 0 },
  { description: "دجاج", quantity: 12, unitPrice: 23.5, amount: 0 },
  { description: "لبن", quantity: 6, unitPrice: 7.25, amount: 0 },
  { description: "خضار (فاتورة بمبلغ صريح)", quantity: 3, unitPrice: 10, amount: 27.5 },
];

const invoiceAmounts = invoices.map((invoice) => invoiceTotal(invoice));
const expensesTotal = invoiceAmounts.reduce((total, value) => total + value, 0);
const cashSalesDay = 4200;

check("إجمالي كل فاتورة = الكمية × سعر الوحدة", () => {
  assert.deepEqual(invoiceAmounts, [90, 282, 43.5, 27.5]);
  return "90 + 282 + 43.5 + 27.5";
});

check("المبلغ الصريح يتقدّم على حاصل الضرب (فاتورة فيها ضريبة أو خصم)", () => {
  assert.equal(invoiceTotal({ quantity: 3, unitPrice: 10, amount: 27.5 }), 27.5);
  return "27.5 لا 30";
});

check("المتبقي النقدي = المبيعات النقدية − مصاريف اليوم", () => {
  assert.equal(expensesTotal, 443);
  assert.equal(remainingCash(cashSalesDay, expensesTotal), 3757);
  return "4200 − 443 = 3757";
});

check("قراءة المتبقي مرتين لا تخصم مرتين (الحساب قراءةً لا تخزيناً)", () => {
  const first = remainingCash(cashSalesDay, expensesTotal);
  const second = remainingCash(cashSalesDay, expensesTotal);
  assert.equal(first, second);
  return "3757 في القراءتين";
});

/* ── 2) تسوية شبكة بعمولة وضريبة ──────────────────────────────── */

section("٢) تسوية شبكة (فوديكس) بعمولة وضريبة");

const settlement = settlementFigures({
  salesAmount: 10000,
  receivedAmount: 9750,
  vatRate: 15,
  vatIncluded: true,
});

check("العمولة = المبيعات − المستلم", () => {
  assert.equal(settlement.commissionAmount, 250);
  return "10000 − 9750 = 250";
});

check("النسبة المئوية من المبيعات", () => {
  assert.equal(settlement.commissionRate, 2.5);
  return "2.5%";
});

check("الضريبة مستخرجة من داخل العمولة (شاملة)", () => {
  assert.equal(settlement.vatAmount, 32.61);
  assert.equal(settlement.commissionBeforeVat, 217.39);
  return "250 = 217.39 + 32.61";
});

check("الضريبة تُضاف فوق العمولة عند vatIncluded = false", () => {
  const added = settlementFigures({
    salesAmount: 10000,
    receivedAmount: 9750,
    vatRate: 15,
    vatIncluded: false,
  });
  assert.equal(added.vatAmount, 37.5);
  assert.equal(added.commissionBeforeVat, 250);
  return "250 + 37.5";
});

check("الضريبة اختيارية: بلا نسبة لا ضريبة", () => {
  const noVat = settlementFigures({ salesAmount: 8000, receivedAmount: 7800 });
  assert.equal(noVat.vatAmount, 0);
  assert.equal(noVat.commissionAmount, 200);
  assert.equal(noVat.commissionRate, 2.5);
  return "عمولة 200 بنسبة 2.5% بلا ضريبة";
});

/* ── 3) إقفال شهر باعتماد الترحيل ─────────────────────────────── */

section("٣) إقفال شهر باعتماد الترحيل");

const july = {
  openingBalance: 0,
  cashSalesTotal: 60000,
  expensesTotal: 12500,
};
const julyNet = monthlyNet(july);
const carry = decisionOutcome(julyNet, "carry_forward");

check("الصافي = المرحّل + النقدي المتراكم − المصاريف", () => {
  assert.equal(julyNet, 47500);
  return "0 + 60000 − 12500 = 47500";
});

check("القرار: الشهر يُقفل بحالة (مُرحّل للشهر الجديد)", () => {
  assert.equal(carry.status, "carried_forward");
  assert.equal(carry.carriedAmount, 47500);
  return "المرحّل 47500";
});

check("بداية الشهر الجديد = صافي الشهر المُقفل", () => {
  const august = monthlyNet({
    openingBalance: carry.nextOpening,
    cashSalesTotal: 30000,
    expensesTotal: 5000,
  });
  assert.equal(carry.nextOpening, 47500);
  assert.equal(august, 72500);
  return "47500 + 30000 − 5000 = 72500";
});

/* ── 4) إقفال شهر بتصفير ──────────────────────────────────────── */

section("٤) إقفال شهر بتصفير");

const reset = decisionOutcome(julyNet, "reset");

check("القرار: الشهر يُقفل بحالة (مُصفَّر) ولا يُرحّل شيء", () => {
  assert.equal(reset.status, "reset");
  assert.equal(reset.carriedAmount, 0);
  return "الصافي 47500 لم يُرحّل";
});

check("الشهر الجديد يبدأ من صفر", () => {
  const august = monthlyNet({
    openingBalance: reset.nextOpening,
    cashSalesTotal: 30000,
    expensesTotal: 5000,
  });
  assert.equal(reset.nextOpening, 0);
  assert.equal(august, 25000);
  return "0 + 30000 − 5000 = 25000";
});

check("حدود الشهر تُقرأ من مفتاحه بصيغة YYYY-MM", () => {
  const period = parseMonthKey("2026-07");
  assert.ok(period);
  const bounds = monthBounds(period.year, period.month);
  assert.deepEqual(bounds, { from: "2026-07-01", to: "2026-07-31" });
  assert.equal(parseMonthKey("2026-13"), null);
  return "2026-07-01 ← 2026-07-31";
});

/* ── 5) موظف بدون صلاحية ──────────────────────────────────────── */

section("٥) موظف بدون صلاحية الترحيل أو التصفير");

/** رموز موظف مُنح «عرض ملخص الإقفال» وحده (درجة 1 في بنده). */
const viewerCodes = new Set(codesForModuleLevel("monthly_summary", 1));
/** رموز موظف بلا أي بند من بنود الإقفال (كل بنوده درجة 0). */
const noneCodes = new Set([
  ...codesForModuleLevel("monthly_summary", 0),
  ...codesForModuleLevel("monthly_carry_forward", 0),
  ...codesForModuleLevel("monthly_reset", 0),
]);

check("البنود الثلاثة موجودة في قاموس الصلاحيات بخانة صح واحدة لكل بند", () => {
  for (const key of ["monthly_summary", "monthly_carry_forward", "monthly_reset"]) {
    const module = MODULE_INDEX.get(key);
    assert.ok(module, "البند مفقود: " + key);
    assert.equal(module.levels.length, 1, "البند " + key + " ليس خانة واحدة");
    assert.equal(isDeleteAvailable(key), false);
  }
  return "عرض الملخص / اعتماد الترحيل / تصفير الرصيد";
});

check("من مُنح العرض وحده لا يملك رمز الترحيل ولا رمز التصفير", () => {
  assert.ok(viewerCodes.has(PERMISSIONS.monthlySummaryView));
  assert.equal(viewerCodes.has(PERMISSIONS.monthlyCarryForward), false);
  assert.equal(viewerCodes.has(PERMISSIONS.monthlyReset), false);
  return "يرى الملخّص ولا يرى الأزرار";
});

check("من لا بند له لا يملك أي رمز من رموز الإقفال", () => {
  assert.equal(noneCodes.size, 0);
  return "لا عرض ولا ترحيل ولا تصفير";
});

check("منح الترحيل لا يمنح التصفير (بندان مستقلان)", () => {
  const carryCodes = new Set(codesForModuleLevel("monthly_carry_forward", 1));
  const resetCodes = new Set(codesForModuleLevel("monthly_reset", 1));
  assert.ok(carryCodes.has(PERMISSIONS.monthlyCarryForward));
  assert.equal(carryCodes.has(PERMISSIONS.monthlyReset), false);
  assert.ok(resetCodes.has(PERMISSIONS.monthlyReset));
  assert.equal(resetCodes.has(PERMISSIONS.monthlyCarryForward), false);
  return "كل زر ببنده";
});

check("بندا المصاريف والتسويات فيهما خانة حذف مستقلة", () => {
  assert.ok(MODULE_DELETE_GRADE.cash_expenses);
  assert.ok(MODULE_DELETE_GRADE.settlements);
  assert.equal(isDeleteAvailable("cash_expenses"), true);
  assert.equal(isDeleteAvailable("settlements"), true);
  return "الحذف يُمنح أو يُسحب وحده";
});

check("درجات بند التسويات: التأكيد في الدرجة الرابعة وحدها", () => {
  const level3 = new Set(codesForModuleLevel("settlements", 3));
  const level4 = new Set(codesForModuleLevel("settlements", 4));
  assert.equal(level3.has(PERMISSIONS.settlementsConfirm), false);
  assert.ok(level4.has(PERMISSIONS.settlementsConfirm));
  return "من يعدّل لا يؤكّد السداد";
});

/* ── التقرير ──────────────────────────────────────────────────── */

console.log("فحص نظام تقفيل الكاشير والنقدية");
console.log("=".repeat(52));
for (const line of lines) console.log(line);
console.log("");
console.log(
  failures === 0
    ? "النتيجة: كل الفحوص ناجحة."
    : "النتيجة: " + String(failures) + " فحصاً فاشلاً.",
);

if (failures > 0) process.exitCode = 1;
