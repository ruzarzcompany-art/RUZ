import { computeAccessAudit } from "../server/accessAudit.js";

/**
 * تشغيل أداة تدقيق التغطية (نفس دالة `GET /access/audit`) من سطر الأوامر،
 * بلا حاجة إلى جلسة دخول. بعد حذف نظام الأدوار صار السؤال دائماً: هل كل
 * درجة ورمز نافذ اليوم مردود إلى قاعدة محفوظة في `access_rules` أو إلى
 * أرضية الجوال المكتوبة في الكود؟ أي فجوة تعني صلاحية بلا مصدر.
 *
 *   node --experimental-strip-types tools/access-audit-report.ts        (أو المُحزَّم)
 *   المخرج: ملخّص نصّي + سطر JSON واحد يصلح للفحص الآلي.
 */
const audit = await computeAccessAudit();

const t = audit.totals;
console.log("═══ تدقيق تغطية الصلاحيات ═══");
console.log(`المصدر: ${audit.source}`);
console.log(`الموظفون: ${t.employees}   البنود: ${t.modules}`);
console.log(`الدرجات الممنوحة فعلياً: ${t.grantedGrades}`);
console.log(`المغطّاة بقواعد صريحة: ${t.coveredGrades}`);
console.log(`نسبة التغطية: ${t.coveragePercent}%`);
console.log(`عدد الفجوات: ${t.gapCount}   موظفون بفجوات: ${t.employeesWithGaps}`);
console.log(`موظفون بلا أي قاعدة صريحة: ${t.employeesWithoutRules}`);
console.log(
  `أرضية الجوال (${audit.mobileFloor.codes.join(", ")}): ` +
    `${audit.mobileFloor.ok ? "محقّقة للجميع ✔" : `غير محقّقة لـ ${audit.mobileFloor.employeesFailing} موظف ✘`}`,
);
console.log(`النظام سليم (لا صلاحية بلا مصدر): ${audit.healthy ? "نعم ✔" : "لا ✘"}`);

for (const row of audit.employees) {
  const flawed = row.gaps.length > 0 || row.unexplainedCodes.length > 0 || !row.mobileFloorOk;
  if (!flawed) continue;
  console.log(`\n— ${row.employeeCode} · ${row.fullName} (id=${row.employeeId})`);
  console.log(`  قواعد صريحة: ${row.explicitRuleCount}   أرضية الجوال: ${row.mobileFloorOk ? "✔" : "✘"}`);
  for (const gap of row.gaps) {
    console.log(
      `  فجوة · ${gap.moduleLabel} [${gap.moduleKey}]: الفعلي درجة ${gap.effectiveLevel}` +
        `${gap.effectiveDelete ? "+حذف" : ""} → الصريح درجة ${gap.explicitLevel}` +
        `${gap.explicitDelete ? "+حذف" : ""}`,
    );
  }
  if (row.unexplainedCodes.length > 0) {
    console.log(`  رموز بلا قاعدة مفسّرة: ${row.unexplainedCodes.join(", ")}`);
  }
}

console.log(
  `\nJSON ${JSON.stringify({ source: audit.source, totals: t, mobileFloor: audit.mobileFloor, healthy: audit.healthy })}`,
);

process.exit(audit.healthy ? 0 : 1);
