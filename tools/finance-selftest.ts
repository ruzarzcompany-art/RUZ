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
  aggregateMonthlySales,
  carryOverAmount,
  commissionOf,
  commissionRateOf,
  decisionOutcome,
  deductionVariance,
  expectedDeduction,
  invoiceTotal,
  monthBounds,
  monthlyNet,
  monthlySettlementFigures,
  normalizeRate,
  parseMonthKey,
  paymentsTotal,
  remainingCash,
  settlementBase,
  settlementFigures,
  unsettledSales,
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

/* ── 6) مصاريف مكتوبة داخل صفحة التقفيل ───────────────────────── */

section("٦) المصاريف داخل صفحة تقفيل الكاشير (سطر بحقلين: بيان ومبلغ)");

/** أسطر المصروف كما تُكتب في الصفحة: البيان والمبلغ لا غير. */
const closingExpenseLines = [
  { label: "غاز", amount: 90 },
  { label: "دجاج", amount: 282 },
  { label: "لبن", amount: 43.5 },
  { label: "خضار", amount: 27.5 },
];

const closingExpenses = aggregateMonthlySales(closingExpenseLines);

check("مصروفات التقفيلة = مجموع أسطرها المكتوبة في الصفحة نفسها", () => {
  assert.equal(closingExpenses, 443);
  return "90 + 282 + 43.5 + 27.5 = 443";
});

check("كل مصروف يُخصم تلقائياً من نقدي التقفيلة", () => {
  assert.equal(remainingCash(4200, closingExpenses), 3757);
  return "4200 − 443 = 3757";
});

check("سطر بلا مبلغ لا يغيّر شيئاً، وحذف سطر يعيد المبلغ فوراً", () => {
  const withEmpty = aggregateMonthlySales([
    ...closingExpenseLines,
    { label: "بلا مبلغ", amount: 0 },
  ]);
  assert.equal(withEmpty, 443);
  const afterDelete = aggregateMonthlySales(
    closingExpenseLines.filter((line) => line.label !== "دجاج"),
  );
  assert.equal(afterDelete, 161);
  assert.equal(remainingCash(4200, afterDelete), 4039);
  return "بعد حذف الدجاج: 161 والمتبقي 4039";
});

/* ── 7) تسوية شبكة على المجمَّع الشهري ────────────────────────── */

section("٧) تسوية شبكة (مدى) على المجمَّع الشهري لا على يوم واحد");

/** مبيعات مدى كما تجمّعت من تقفيلات الشهر يوماً بيوم. */
const madaDays = [
  { amount: 4000 },
  { amount: 3500 },
  { amount: 1600 },
  { amount: 900 },
];
const madaMonth = aggregateMonthlySales(madaDays);
const madaSettlement = settlementFigures({
  salesAmount: madaMonth,
  receivedAmount: 9750,
  vatRate: 15,
  vatIncluded: true,
});

check("المبالغ تتجمّع طوال الشهر من التقفيلات اليومية", () => {
  assert.equal(madaMonth, 10000);
  return "4000 + 3500 + 1600 + 900 = 10000";
});

check("العمولة = المبيعات المجمّعة − المستلم في البنك", () => {
  assert.equal(commissionOf(madaMonth, 9750), 250);
  assert.equal(madaSettlement.commissionAmount, 250);
  return "10000 − 9750 = 250";
});

check("النسبة = العمولة ÷ المبيعات × 100 على المجمَّع الشهري", () => {
  assert.equal(commissionRateOf(250, madaMonth), 2.5);
  assert.equal(madaSettlement.commissionRate, 2.5);
  return "250 ÷ 10000 × 100 = 2.5%";
});

check("التسوية اليومية تُخرج نسبة مضلِّلة، والشهرية هي الصحيحة", () => {
  // حوالة واحدة وصلت في يوم واحد لو نُسبت إلى مبيعات ذلك اليوم وحده
  const daily = settlementFigures({ salesAmount: 4000, receivedAmount: 3750 });
  assert.equal(daily.commissionRate, 6.25);
  assert.notEqual(daily.commissionRate, madaSettlement.commissionRate);
  return "6.25% ليوم واحد مقابل 2.5% للشهر المجمَّع";
});

check("ما لم يدخل تسويةً بعد = المجمَّع − ما سُوّي", () => {
  assert.equal(unsettledSales(madaMonth, 10000), 0);
  assert.equal(unsettledSales(madaMonth, 6000), 4000);
  return "بقي 4000 بلا تسوية";
});

/* ── 8) تسوية تطبيق توصيل في قسم مستقل ────────────────────────── */

section("٨) تسوية تطبيق توصيل (جاهز) — قسم مستقل بتجميعه الخاص");

const jahezDays = [{ amount: 2000 }, { amount: 1800 }, { amount: 1200 }];
const jahezMonth = aggregateMonthlySales(jahezDays);
const jahezSettlement = settlementFigures({
  salesAmount: jahezMonth,
  receivedAmount: 4250,
  vatRate: 15,
  vatIncluded: true,
});

check("تجميع التطبيق مستقل عن تجميع الشبكات", () => {
  assert.equal(jahezMonth, 5000);
  assert.notEqual(jahezMonth, madaMonth);
  return "الشبكة 10000 والتطبيق 5000 لا يختلطان";
});

check("عمولة التطبيق ونسبتها من مجمَّعه هو", () => {
  assert.equal(jahezSettlement.commissionAmount, 750);
  assert.equal(jahezSettlement.commissionRate, 15);
  return "5000 − 4250 = 750 بنسبة 15%";
});

check("ضريبة العمولة تُستخرج من داخلها في التطبيق كما في الشبكة", () => {
  assert.equal(jahezSettlement.vatAmount, 97.83);
  assert.equal(jahezSettlement.commissionBeforeVat, 652.17);
  return "750 = 652.17 + 97.83";
});

check("خلط النوعين في تسوية واحدة يُخرج نسبة ثالثة مخالفة للاثنتين", () => {
  const mixed = settlementFigures({
    salesAmount: madaMonth + jahezMonth,
    receivedAmount: 9750 + 4250,
  });
  assert.equal(mixed.commissionRate, 6.67);
  assert.notEqual(mixed.commissionRate, madaSettlement.commissionRate);
  assert.notEqual(mixed.commissionRate, jahezSettlement.commissionRate);
  return "6.67% مخلوطة مقابل 2.5% و15% مفصولتين";
});

/* ── 9) بندا المتبقي والرصيد الشهري ───────────────────────────── */

section("٩) «المتبقي النقدي» و«الرصيد الشهري» بندان مستقلان");

check("لكل بند خانة صح واحدة بلا سلّم درجات ولا حذف", () => {
  for (const key of ["cash_remaining", "cash_monthly_balance"]) {
    const module = MODULE_INDEX.get(key);
    assert.ok(module, "البند مفقود: " + key);
    assert.equal(module.levels.length, 1);
    assert.equal(isDeleteAvailable(key), false);
  }
  return "المتبقي النقدي / الرصيد النقدي الشهري";
});

check("منح أحدهما لا يمنح الآخر ولا يمنح شيئاً من بنود الإقفال", () => {
  const remainingCodes = new Set(codesForModuleLevel("cash_remaining", 1));
  const balanceCodes = new Set(codesForModuleLevel("cash_monthly_balance", 1));

  assert.ok(remainingCodes.has(PERMISSIONS.cashRemainingView));
  assert.equal(remainingCodes.has(PERMISSIONS.cashMonthlyBalanceView), false);
  assert.equal(remainingCodes.has(PERMISSIONS.monthlySummaryView), false);

  assert.ok(balanceCodes.has(PERMISSIONS.cashMonthlyBalanceView));
  assert.equal(balanceCodes.has(PERMISSIONS.cashRemainingView), false);
  assert.equal(balanceCodes.has(PERMISSIONS.monthlyCarryForward), false);
  return "كل خانة ببندها";
});

check("من لا بند له لا يرى المتبقي ولا الرصيد الشهري", () => {
  const none = new Set([
    ...codesForModuleLevel("cash_remaining", 0),
    ...codesForModuleLevel("cash_monthly_balance", 0),
  ]);
  assert.equal(none.size, 0);
  return "صفر رمز";
});

/* ── 10) نسبة العقد والمتوقع والمخصوم الفعلي والفرق ───────────── */

section("١٠) نسبة العقد والمبلغ المتوقع والمخصوم الفعلي والفرق");

/** مدى: مبيعات الشهر 10000، عقدها 2%، وصل 9750 وكشفها يقول خُصم 250. */
const madaContract = monthlySettlementFigures({
  monthlySales: 10000,
  receivedAmount: 9750,
  actualDeducted: 250,
  contractRate: 2,
  vatRate: 15,
  vatIncluded: true,
});

check("الأساس المستحق = مبيعات الشهر + المرحّل من السابق", () => {
  assert.equal(settlementBase(10000, 0), 10000);
  assert.equal(settlementBase(8000, 3800), 11800);
  assert.equal(madaContract.settlementBase, 10000);
  return "8000 + 3800 = 11800";
});

check("المتوقع خصمه = الأساس × نسبة العقد ÷ 100", () => {
  assert.equal(expectedDeduction(10000, 2), 200);
  assert.equal(expectedDeduction(11800, 2), 236);
  assert.equal(madaContract.expectedAmount, 200);
  return "10000 × 2% = 200";
});

check("الفرق = المخصوم الفعلي − المتوقع (موجب = خُصم أكثر من العقد)", () => {
  assert.equal(deductionVariance(250, 200), 50);
  assert.equal(madaContract.actualDeducted, 250);
  assert.equal(madaContract.varianceAmount, 50);
  return "250 − 200 = 50 مطالبة على مدى";
});

check("العمولة = المخصوم الفعلي بالضبط، والنسبة عمولة ÷ الأساس × 100", () => {
  assert.equal(madaContract.commissionAmount, 250);
  assert.equal(madaContract.commissionRate, 2.5);
  return "250 ÷ 10000 = 2.5% مقابل عقد 2%";
});

check("ضريبة العمولة تُستخرج من المخصوم الفعلي لا من فرق الحوالة", () => {
  assert.equal(madaContract.vatAmount, 32.61);
  assert.equal(madaContract.commissionBeforeVat, 217.39);
  return "250 = 217.39 + 32.61";
});

check("نسبة العقد تُقصّ داخل 0..100 ولا تقبل عبثاً", () => {
  assert.equal(normalizeRate(2.5), 2.5);
  assert.equal(normalizeRate(120), 100);
  assert.equal(normalizeRate(-5), 0);
  assert.equal(normalizeRate(null), 0);
  assert.equal(normalizeRate("abc"), 0);
  return "120 ← 100 و−5 ← 0";
});

check("جاهز (تطبيق توصيل) بعقد 15%: الفعلي مطابق للمتوقع فلا فرق", () => {
  const jahez = monthlySettlementFigures({
    monthlySales: 5000,
    receivedAmount: 4250,
    actualDeducted: 750,
    contractRate: 15,
    vatRate: 15,
    vatIncluded: true,
  });
  assert.equal(jahez.expectedAmount, 750);
  assert.equal(jahez.varianceAmount, 0);
  assert.equal(jahez.commissionRate, 15);
  assert.equal(jahez.vatAmount, 97.83);
  return "5000 × 15% = 750 = المخصوم الفعلي";
});

/* ── 11) ترحيل ما لم يُحوَّل إلى الشهر الجديد ──────────────────── */

section("١١) ترحيل المبالغ التي لم تتم تحويلها إلى الشهر الجديد");

/** الشهر الأول: مبيعات 10000، عقد 2%، وصل 6000 فقط والمخصوم الفعلي 200. */
const monthOne = monthlySettlementFigures({
  monthlySales: 10000,
  receivedAmount: 6000,
  actualDeducted: 200,
  contractRate: 2,
});

check("المرحّل = الأساس − المحوّل − المخصوم الفعلي", () => {
  assert.equal(carryOverAmount(10000, 6000, 200), 3800);
  assert.equal(monthOne.carriedOutAmount, 3800);
  return "10000 − 6000 − 200 = 3800";
});

check("نقص الحوالة يُفسَّر جزءين: خصمٌ معروف ومبلغ لم يُحوَّل بعد", () => {
  assert.equal(monthOne.actualDeducted, 200);
  assert.equal(monthOne.commissionAmount, 200);
  assert.equal(
    monthOne.settlementBase - monthOne.receivedAmount,
    monthOne.actualDeducted + monthOne.carriedOutAmount,
  );
  return "4000 = 200 خصماً + 3800 مرحّلاً";
});

check("الشهر الجديد: المرحّل يدخل أساسه ولا يُضاف إلى مبيعاته", () => {
  const monthTwo = monthlySettlementFigures({
    monthlySales: 8000,
    carriedInAmount: monthOne.carriedOutAmount,
    receivedAmount: 11564,
    actualDeducted: 236,
    contractRate: 2,
  });
  assert.equal(monthTwo.monthlySales, 8000);
  assert.equal(monthTwo.carriedInAmount, 3800);
  assert.equal(monthTwo.settlementBase, 11800);
  assert.equal(monthTwo.expectedAmount, 236);
  assert.equal(monthTwo.varianceAmount, 0);
  assert.equal(monthTwo.carriedOutAmount, 0);
  return "8000 + 3800 = 11800 سُدّد كاملاً فأُغلق الترحيل";
});

check("جهة لم يصل منها شيء: كل الأساس يُرحَّل ولا عمولة تُحتسب", () => {
  const nothing = monthlySettlementFigures({
    monthlySales: 5000,
    receivedAmount: 0,
    actualDeducted: 0,
  });
  assert.equal(nothing.carriedOutAmount, 5000);
  assert.equal(nothing.commissionAmount, 0);
  assert.equal(nothing.commissionRate, 0);
  return "5000 كلها تنتظر التحويل";
});

check("وصول أكثر من المستحق لا يُنشئ ترحيلاً بالسالب", () => {
  assert.equal(carryOverAmount(1000, 1200, 0), 0);
  const over = monthlySettlementFigures({
    monthlySales: 1000,
    receivedAmount: 1200,
    actualDeducted: 0,
  });
  assert.equal(over.carriedOutAmount, 0);
  return "الترحيل لا يقلّ عن صفر";
});

check("الترحيل مرة واحدة: المرحّل الداخل لا يتضاعف مهما أُعيد الحساب", () => {
  const input = {
    monthlySales: 8000,
    carriedInAmount: 3800,
    receivedAmount: 5000,
    actualDeducted: 100,
    contractRate: 2,
  };
  const first = monthlySettlementFigures(input);
  const second = monthlySettlementFigures(input);
  assert.equal(first.settlementBase, 11800);
  assert.deepEqual(first, second);
  return "11800 في الحسابين لا 15600";
});

/* ── 12) دفعات التحويل والتوافق مع السلوك السابق ──────────────── */

section("١٢) إضافة مبالغ التحويل على دفعات، والتوافق مع البيانات السابقة");

check("المستلم = مجموع الدفعات لا رقماً مكتوباً فوقها", () => {
  assert.equal(paymentsTotal([{ amount: 3000 }, { amount: 1250 }]), 4250);
  assert.equal(paymentsTotal([]), 0);
  assert.equal(paymentsTotal([{ amount: 1000 }, { amount: null }]), 1000);
  return "3000 + 1250 = 4250";
});

check("إضافة دفعة تُنقص المرحّل بمقدارها بالضبط", () => {
  const before = monthlySettlementFigures({
    monthlySales: 10000,
    receivedAmount: paymentsTotal([{ amount: 6000 }]),
    actualDeducted: 200,
  });
  const after = monthlySettlementFigures({
    monthlySales: 10000,
    receivedAmount: paymentsTotal([{ amount: 6000 }, { amount: 1800 }]),
    actualDeducted: 200,
  });
  assert.equal(before.carriedOutAmount, 3800);
  assert.equal(after.receivedAmount, 7800);
  assert.equal(after.carriedOutAmount, 2000);
  return "3800 − 1800 = 2000";
});

check("بلا مخصوم فعلي: النتيجة مطابقة للسلوك السابق حرفياً ولا ترحيل", () => {
  const legacy = settlementFigures({ salesAmount: 10000, receivedAmount: 9750 });
  const upgraded = monthlySettlementFigures({
    monthlySales: 10000,
    receivedAmount: 9750,
  });
  assert.equal(upgraded.commissionAmount, legacy.commissionAmount);
  assert.equal(upgraded.commissionRate, legacy.commissionRate);
  assert.equal(upgraded.vatAmount, legacy.vatAmount);
  assert.equal(upgraded.expectedAmount, 0);
  assert.equal(upgraded.varianceAmount, 0);
  assert.equal(upgraded.carriedOutAmount, 0);
  return "عمولة 250 بنسبة 2.5% كما كانت، ولا مبلغ مرحّل";
});

check("بلا نسبة عقد لا مبلغ متوقع ولا فرق (الحقل اختياري)", () => {
  const noContract = monthlySettlementFigures({
    monthlySales: 10000,
    receivedAmount: 9800,
    actualDeducted: 150,
  });
  assert.equal(noContract.contractRate, 0);
  assert.equal(noContract.expectedAmount, 0);
  assert.equal(noContract.varianceAmount, 0);
  assert.equal(noContract.carriedOutAmount, 50);
  return "خصم 150 ومرحّل 50 بلا عقد";
});

check("مجاميع تقرير نهاية الشهر: الشبكات والتطبيقات يُجمعان بلا اختلاط", () => {
  const networkRow = monthlySettlementFigures({
    monthlySales: 10000,
    receivedAmount: 6000,
    actualDeducted: 200,
    contractRate: 2,
  });
  const appRow = monthlySettlementFigures({
    monthlySales: 5000,
    receivedAmount: 4250,
    actualDeducted: 750,
    contractRate: 15,
  });
  const baseTotal = networkRow.settlementBase + appRow.settlementBase;
  const expectedTotal = networkRow.expectedAmount + appRow.expectedAmount;
  const actualTotal = networkRow.actualDeducted + appRow.actualDeducted;
  const carryTotal = networkRow.carriedOutAmount + appRow.carriedOutAmount;
  assert.equal(baseTotal, 15000);
  assert.equal(expectedTotal, 950);
  assert.equal(actualTotal, 950);
  assert.equal(carryTotal, 3800);
  assert.equal(networkRow.commissionRate, 2);
  assert.equal(appRow.commissionRate, 15);
  return "أساس 15000، متوقع 950، فعلي 950، مرحّل 3800";
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
