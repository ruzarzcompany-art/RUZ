/**
 * البنك والمطابقة.
 *
 * كشف البنك يُقرأ في المتصفح ويصل هنا صفوفاً (تاريخ، وصف، دائن، مدين، رصيد).
 * لكل حركة تُستخرج «الجهة» من الوصف، ثم تُوزَّع بقاعدة يثبّتها المالك مرة
 * واحدة (bank_rules)، أو باقتراح آلي يبقى «بانتظار التثبيت» حتى يؤكّده.
 *
 * المطابقة:
 *   - الإيداعات ↔ مستحقات فوديكس لكل طريقة دفع (فودكس باي، الشبكة، التطبيقات)
 *     مع مهلة وصول بالأيام (مبيعات اليوم تصل بعد يوم مثلاً).
 *   - المسحوبات ↔ مشتريات الموردين (مشتريات فوديكس + استلام البضاعة غير النقدي).
 */

import { and, asc, eq, gte, lte, ne, sql } from "drizzle-orm";
import { getDb } from "../db/index.js";
import { bankRules, bankTransactions, foodicsStockDocs, purchaseReceipts } from "../db/schema.js";
import { foodicsDaySales } from "./foodics.js";
import { clampFrom, financeStartDate } from "./financeStart.js";

const round2 = (n: number) => Math.round(n * 100) / 100;

export const BANK_CATEGORIES: Record<string, string> = {
  sales_provider: "مبيعات (شبكة / تطبيق)",
  supplier: "مورد / مشتريات",
  salaries: "رواتب",
  government: "رسوم حكومية وتأمينات",
  utilities: "كهرباء وماء واتصالات",
  bank_fees: "رسوم وضريبة بنكية",
  credit_card: "سداد بطاقة ائتمانية",
  owner: "سحب / إيداع المالك",
  operating_expenses: "مصروفات عمل",
  subscriptions: "اشتراكات وبرامج",
  other_income: "إيراد آخر",
  other: "أخرى",
};

export type BankRowInput = { date: string; description: string; credit: number; debit: number; balance: number | null };

const squash = (s: string) => s.replace(/\s+/g, " ").trim();
export const norm = (s: string) =>
  squash(s)
    .toLowerCase()
    .replace(/[إأآ]/g, "ا")
    .replace(/ة/g, "ه")
    .replace(/ى/g, "ي");

/** يستخرج الجهة ونوع الحركة ومرجعها من وصف كشف البنك. */
export function parseDescription(raw: string) {
  const d = squash(raw);
  const kind = d.split(" ").slice(0, 3).join(" ");
  const ref = d.match(/مرجع العملية\s*([0-9A-Z]{6,})/)?.[1] ?? d.match(/مرجع سداد\s*(\d+)/)?.[1] ?? "";
  let cp = "";
  if (/^(رسوم|ضريبة)/.test(d) && !/رواتب/.test(d)) cp = "رسوم وضريبة بنكية";
  else if (/^(تحويل رواتب|رسوم تمرير خدمة رواتب)/.test(d)) cp = "رواتب";
  else if (/^سداد بطاقة ائتمانية/.test(d)) cp = "سداد بطاقة ائتمانية";
  else if (/اسم المفوتر/.test(d)) cp = squash(d.match(/اسم المفوتر\s+(.+?)\s+الفاتورة/)?.[1] ?? "سداد");
  else {
    const before = d.match(/(?:واردة|صادرة)\s+(.+?)\s+(?:المحول|المستفيد|المرسل)\s/);
    const after = d.match(/(?:المحول|المستفيد|المرسل)\s+(.+?)\s+(?:من|الى|إلى)\s/);
    if (before && !/^(المحول|المستفيد|المرسل)/.test(before[1])) cp = before[1];
    else if (after) cp = after[1];
    else cp = kind;
  }
  return { kind, counterparty: squash(cp).slice(0, 120), reference: ref };
}

/** اقتراح آلي للبند حين لا توجد قاعدة مثبّتة. */
export function suggestRule(counterparty: string, description: string, isCredit: boolean) {
  const c = norm(counterparty);
  const d = norm(description);
  const has = (...words: string[]) => words.some((w) => c.includes(norm(w)) || d.includes(norm(w)));
  if (counterparty === "رسوم وضريبة بنكية") return { category: "bank_fees", mappedName: "", lagDays: 0 };
  if (counterparty === "رواتب") return { category: "salaries", mappedName: "", lagDays: 0 };
  if (counterparty === "سداد بطاقة ائتمانية") return { category: "credit_card", mappedName: "", lagDays: 0 };
  if (has("hunger", "hanqar", "هنقر")) return { category: "sales_provider", mappedName: "hungerstation", lagDays: 0 };
  if (has("keeta", "كيتا")) return { category: "sales_provider", mappedName: "keeta", lagDays: 0 };
  if (has("jahez", "جاهز")) return { category: "sales_provider", mappedName: "jahez", lagDays: 0 };
  if (has("toyou", "تويو")) return { category: "sales_provider", mappedName: "toyou", lagDays: 0 };
  if (has("افضل الطهاه", "chefz")) return { category: "sales_provider", mappedName: "the chefz", lagDays: 0 };
  if (has("اللون الرقمي", "foodics")) return { category: "sales_provider", mappedName: "Card foodics pay", lagDays: 1 };
  if (has("ايداع وحفظ اموال", "geidea", "جيديا")) return { category: "sales_provider", mappedName: "Card", lagDays: 1 };
  if (has("تامينات", "وزاره", "تجديد اقامه", "moi", "مقيم", "قوي", "بلدي", "جوازات", "زكاه")) return { category: "government", mappedName: "", lagDays: 0 };
  if (has("جوباي", "foodics subscription")) return { category: "subscriptions", mappedName: "", lagDays: 0 };
  if (has("كهرباء", "مياه", "stc", "موبايلي", "زين", "جوباي", "اتصالات")) return { category: "utilities", mappedName: "", lagDays: 0 };
  if (has("small medium enterprises", "منشات")) return { category: "other_income", mappedName: "", lagDays: 0 };
  return isCredit ? { category: "other_income", mappedName: "", lagDays: 0 } : { category: "supplier", mappedName: counterparty, lagDays: 0 };
}

export async function importBankRows(branchId: number, rows: BankRowInput[], employeeId: number | null) {
  const db = getDb();
  let inserted = 0;
  let skipped = 0;
  const values = rows.map((r) => {
    const p = parseDescription(r.description);
    const credit = round2(Math.abs(r.credit || 0));
    const debit = round2(Math.abs(r.debit || 0));
    const fingerprint = [r.date, credit, debit, r.balance ?? "", p.reference || squash(r.description).slice(0, 160)].join("|");
    return {
      branchId,
      txDate: r.date,
      description: squash(r.description).slice(0, 2000),
      credit,
      debit,
      balance: r.balance,
      counterparty: p.counterparty,
      kind: p.kind,
      reference: p.reference,
      fingerprint,
      uploadedByEmployeeId: employeeId,
    };
  });
  for (let i = 0; i < values.length; i += 100) {
    const chunk = values.slice(i, i + 100);
    const res = await db.insert(bankTransactions).values(chunk).onConflictDoNothing().returning({ id: bankTransactions.id });
    inserted += res.length;
    skipped += chunk.length - res.length;
  }
  return { inserted, skipped };
}

function addDays(date: string, days: number) {
  const d = new Date(`${date}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

function daysBetween(from: string, to: string) {
  const out: string[] = [];
  for (let d = from; d <= to && out.length < 93; d = addDays(d, 1)) out.push(d);
  return out;
}

type Rule = { category: string; mappedName: string; lagDays: number; confirmed: boolean };

export async function loadRules(branchId: number) {
  const db = getDb();
  const rows = await db.select().from(bankRules).where(eq(bankRules.branchId, branchId));
  return new Map(rows.map((r) => [r.counterparty, r]));
}

export async function reconcile(branchId: number, fromRaw: string, to: string) {
  const db = getDb();
  const startDate = await financeStartDate(branchId);
  const from = clampFrom(fromRaw, startDate);
  const txs = await db
    .select()
    .from(bankTransactions)
    .where(and(eq(bankTransactions.branchId, branchId), gte(bankTransactions.txDate, from), lte(bankTransactions.txDate, addDays(to, 7))))
    .orderBy(asc(bankTransactions.txDate), asc(bankTransactions.id));
  const rules = await loadRules(branchId);
  const ruleOf = (t: (typeof txs)[number]): Rule => {
    const r = rules.get(t.counterparty);
    if (r) return { category: r.category, mappedName: r.mappedName, lagDays: r.lagDays, confirmed: true };
    return { ...suggestRule(t.counterparty, t.description, t.credit > 0), confirmed: false };
  };

  const inPeriod = txs.filter((t) => t.txDate <= to);
  const withRule = inPeriod.map((t) => ({ ...t, rule: ruleOf(t) }));

  // الجهات: صف لكل جهة مع بندها (مثبّت أم مقترح) — منها يثبّت المالك الأسماء
  const parties = new Map<string, { counterparty: string; direction: string; count: number; total: number; rule: Rule }>();
  for (const t of withRule) {
    const key = t.counterparty;
    const p = parties.get(key) ?? { counterparty: key, direction: t.credit > 0 ? "in" : "out", count: 0, total: 0, rule: t.rule };
    p.count++;
    p.total = round2(p.total + t.credit - t.debit);
    parties.set(key, p);
  }

  // البنود
  const categories = new Map<string, { category: string; label: string; credit: number; debit: number; count: number }>();
  for (const t of withRule) {
    const c = categories.get(t.rule.category) ?? { category: t.rule.category, label: BANK_CATEGORIES[t.rule.category] ?? t.rule.category, credit: 0, debit: 0, count: 0 };
    c.credit = round2(c.credit + t.credit);
    c.debit = round2(c.debit + t.debit);
    c.count++;
    categories.set(t.rule.category, c);
  }

  // ── المبيعات: مستحقات فوديكس ↔ الإيداعات ──
  const days = daysBetween(from, to);
  const salesByDay = new Map<string, Map<string, number>>();
  const methodNames = new Set<string>();
  for (const d of days) {
    const s = await foodicsDaySales(branchId, d);
    const m = new Map<string, number>();
    for (const x of s.methods) {
      if (x.kind === "cash") continue;
      m.set(norm(x.name), (m.get(norm(x.name)) ?? 0) + x.amount);
      methodNames.add(x.name);
    }
    salesByDay.set(d, m);
  }
  const firstSalesDay = days.find((d) => (salesByDay.get(d)?.size ?? 0) > 0) ?? null;

  const providers = new Map<string, { name: string; lagDays: number; senders: Set<string> }>();
  for (const p of parties.values()) {
    if (p.rule.category !== "sales_provider" || !p.rule.mappedName) continue;
    const key = norm(p.rule.mappedName);
    const pr = providers.get(key) ?? { name: p.rule.mappedName, lagDays: p.rule.lagDays, senders: new Set<string>() };
    pr.senders.add(p.counterparty);
    providers.set(key, pr);
  }
  // طرق دفع في فوديكس بلا جهة مثبّتة في البنك تظهر أيضاً (مستحق لم يصل)
  for (const name of methodNames) {
    if (!providers.has(norm(name))) providers.set(norm(name), { name, lagDays: 0, senders: new Set() });
  }

  const allWithRule = txs.map((t) => ({ ...t, rule: ruleOf(t) }));
  const sales = [...providers.entries()].map(([key, pr]) => {
    const deposits = allWithRule.filter((t) => t.credit > 0 && pr.senders.has(t.counterparty));
    const expectedOf = (d: string) => round2(salesByDay.get(d)?.get(key) ?? 0);
    const expected = round2(days.reduce((s, d) => s + expectedOf(d), 0));
    let rowsOut: Array<{ salesDate: string; expected: number; depositDate: string; received: number; difference: number; feeRate: number | null }> = [];
    let received: number;
    if (pr.lagDays > 0) {
      rowsOut = days.map((d) => {
        const depositDate = addDays(d, pr.lagDays);
        const got = round2(deposits.filter((t) => t.txDate === depositDate).reduce((s, t) => s + t.credit, 0));
        const exp = expectedOf(d);
        return {
          salesDate: d,
          expected: exp,
          depositDate,
          received: got,
          difference: round2(got - exp),
          feeRate: exp > 0 && got > 0 ? round2(((exp - got) / exp) * 100) : null,
        };
      });
      received = round2(rowsOut.reduce((s, r) => s + r.received, 0));
    } else {
      received = round2(deposits.filter((t) => t.txDate >= from && t.txDate <= to).reduce((s, t) => s + t.credit, 0));
    }
    return {
      provider: pr.name,
      senders: [...pr.senders],
      lagDays: pr.lagDays,
      expected,
      received,
      difference: round2(received - expected),
      feeRate: expected > 0 && received > 0 ? round2(((expected - received) / expected) * 100) : null,
      deposits: deposits.filter((t) => t.txDate >= from && t.txDate <= to).map((t) => ({ date: t.txDate, amount: t.credit })),
      days: rowsOut,
    };
  });

  // ── المشتريات: فواتير الموردين (بتاريخ الفاتورة) ↔ التحويلات ──
  const docDate = sql<string>`coalesce(${foodicsStockDocs.invoiceDate}, ${foodicsStockDocs.businessDate})`;
  const stockDocs = await db
    .select({ party: foodicsStockDocs.party, supplierName: foodicsStockDocs.supplierName, state: foodicsStockDocs.state, total: foodicsStockDocs.total, date: foodicsStockDocs.businessDate, reference: foodicsStockDocs.reference })
    .from(foodicsStockDocs)
    .where(and(eq(foodicsStockDocs.branchId, branchId), eq(foodicsStockDocs.kind, "purchase"), gte(docDate, from), lte(docDate, to)))
    // اسم المورد وحده: «المورد — أدخله فلان» كان يفصل المورد الواحد عن تحويلاته وعن نفسه
    .then((rows) => rows.filter((r) => r.state !== "cancelled").map((r) => ({ ...r, party: (r.supplierName || r.party.split(" — أدخله ")[0]).trim() })));
  const receipts = await db
    .select({ party: purchaseReceipts.supplier, total: purchaseReceipts.invoiceTotal, paid: purchaseReceipts.paidAmount, method: purchaseReceipts.paymentMethod, date: purchaseReceipts.businessDate, reference: purchaseReceipts.invoiceNumber })
    .from(purchaseReceipts)
    .where(and(eq(purchaseReceipts.branchId, branchId), ne(purchaseReceipts.paymentMethod, "cash"), gte(purchaseReceipts.businessDate, from), lte(purchaseReceipts.businessDate, to)));
  const suppliers = new Map<string, { supplier: string; invoices: number; invoiceCount: number; paid: number; payments: number; sources: Set<string> }>();
  const sup = (name: string) => {
    const key = norm(name);
    const s = suppliers.get(key) ?? { supplier: name, invoices: 0, invoiceCount: 0, paid: 0, payments: 0, sources: new Set<string>() };
    suppliers.set(key, s);
    return s;
  };
  for (const d of stockDocs) {
    if (!d.party) continue;
    const s = sup(d.party);
    s.invoices = round2(s.invoices + d.total);
    s.invoiceCount++;
    s.sources.add("مشتريات فوديكس");
  }
  for (const r of receipts) {
    if (!r.party) continue;
    const s = sup(r.party);
    s.invoices = round2(s.invoices + r.total);
    s.invoiceCount++;
    s.sources.add("استلام البضاعة");
  }
  for (const t of withRule) {
    if (t.debit <= 0 || t.rule.category !== "supplier") continue;
    const s = sup(t.rule.mappedName || t.counterparty);
    s.paid = round2(s.paid + t.debit);
    s.payments++;
  }
  const purchases = [...suppliers.values()]
    .map((s) => ({ ...s, sources: [...s.sources], difference: round2(s.paid - s.invoices) }))
    .sort((a, b) => Math.max(b.invoices, b.paid) - Math.max(a.invoices, a.paid));

  const credits = round2(inPeriod.reduce((s, t) => s + t.credit, 0));
  const debits = round2(inPeriod.reduce((s, t) => s + t.debit, 0));
  const supplierNames = [...new Set([...stockDocs.map((d) => d.party), ...receipts.map((r) => r.party)].filter(Boolean))].sort();

  return {
    from,
    to,
    startDate,
    firstSalesDay,
    totals: {
      transactions: inPeriod.length,
      credits,
      debits,
      closingBalance: inPeriod.length ? inPeriod[inPeriod.length - 1].balance : null,
      unconfirmed: [...parties.values()].filter((p) => !p.rule.confirmed).length,
    },
    parties: [...parties.values()].sort((a, b) => Number(a.rule.confirmed) - Number(b.rule.confirmed) || Math.abs(b.total) - Math.abs(a.total)),
    categories: [...categories.values()].sort((a, b) => b.credit + b.debit - (a.credit + a.debit)),
    sales: sales.sort((a, b) => b.expected + b.received - (a.expected + a.received)),
    purchases,
    methodNames: [...methodNames].sort(),
    supplierNames,
    transactions: withRule.map((t) => ({
      id: t.id,
      date: t.txDate,
      counterparty: t.counterparty,
      kind: t.kind,
      credit: t.credit,
      debit: t.debit,
      balance: t.balance,
      category: t.rule.category,
      categoryLabel: BANK_CATEGORIES[t.rule.category] ?? t.rule.category,
      mappedName: t.rule.mappedName,
      confirmed: t.rule.confirmed,
      description: t.description,
    })),
  };
}

export async function saveRules(
  branchId: number,
  items: Array<{ counterparty: string; category: string; mappedName: string; lagDays: number }>,
) {
  const db = getDb();
  let saved = 0;
  for (const it of items) {
    if (!it.counterparty || !(it.category in BANK_CATEGORIES)) continue;
    await db
      .insert(bankRules)
      .values({ branchId, counterparty: it.counterparty, category: it.category, mappedName: it.mappedName, lagDays: it.lagDays })
      .onConflictDoUpdate({
        target: [bankRules.branchId, bankRules.counterparty],
        set: { category: it.category, mappedName: it.mappedName, lagDays: it.lagDays, updatedAt: new Date() },
      });
    saved++;
  }
  return saved;
}

export async function deleteTransactions(branchId: number, from: string, to: string) {
  const db = getDb();
  const rows = await db
    .delete(bankTransactions)
    .where(and(eq(bankTransactions.branchId, branchId), gte(bankTransactions.txDate, from), lte(bankTransactions.txDate, to)))
    .returning({ id: bankTransactions.id });
  return rows.length;
}

