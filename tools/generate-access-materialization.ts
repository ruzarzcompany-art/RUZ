import { readFileSync, writeFileSync } from "node:fs";
import { catalogSize, coverageGuardSql, materializationInsertSql } from "./materializationSql.js";

/**
 * توليد ملف ترحيل البيانات الذي يحوّل صلاحيات الأدوار الضمنية إلى قواعد
 * صريحة في `access_rules` بنطاق «موظف محدّد».
 *
 * الاستعلام مولَّد من `MODULE_CATALOG` لا منسوخاً باليد، وعام لا يعتمد على
 * أرقام موظفين بعينهم — يقرأ الموظفين وأدوارهم من قاعدة البيانات وقت
 * التطبيق، فيصحّ على أي بيئة.
 *
 *   node .generate.mjs <مسار migration.sql>
 */
const target = process.argv[2];
if (!target) {
  console.error("مطلوب: مسار ملف migration.sql [--guard <مسار ترحيل الحذف>]");
  process.exit(2);
}

const guardIndex = process.argv.indexOf("--guard");
const guardTarget = guardIndex > 0 ? process.argv[guardIndex + 1] : undefined;

const header = `-- ترحيل بيانات: تثبيت صلاحيات الأدوار الضمنية كقواعد صريحة في access_rules
--
-- قبل هذا الترحيل كان كل موظف يستمد صلاحياته من حقل الدور (employees.role_id)
-- عبر احتياط في الكود، وجدول access_rules فارغ. بعده تُصبح صلاحية كل موظف
-- مكتوبة باسمه صراحةً بنطاق «موظف محدّد» وبنفس درجة كل بند ونفس درجة الحذف
-- المستقلة التي يملكها اليوم بالضبط — فلا يعتمد أحد على الدور بعد الآن.
--
-- الدرجة المحسوبة هي نفسها التي يحسبها derivedModuleLevel في الكود: أعلى درجة
-- يملك الموظف رمزاً واحداً على الأقل من رموزها. ودرجة الحذف derivedModuleDelete:
-- امتلاك أي رمز من رموز حذف البند. البنود التي درجتها صفر ولا حذف فيها لا
-- تُكتب لها قاعدة، لأن غياب القاعدة يعني صفراً أصلاً.
--
-- الجدولان catalog و delete_grade أدناه صورة من MODULE_CATALOG و
-- MODULE_DELETE_GRADE لحظة الترحيل، مولَّدة من الكود عبر
-- tools/generate-access-materialization.ts لا منسوخة باليد.

`;

writeFileSync(target, `${header}${materializationInsertSql()}\n`, "utf-8");

const size = catalogSize();
console.log(
  `كُتب الترحيل: ${target}\n` +
    `القاموس المُدمج: ${size.modules} بنداً، ${size.levels} صف درجة، ${size.deletes} صف حذف.`,
);

/* ── بوابة الأمان في صدر ترحيل الحذف ─────────────────────────────── */

const GUARD_MARKER = "legacy_role_removal_guard";

if (guardTarget) {
  const existing = readFileSync(guardTarget, "utf-8");
  if (existing.includes(GUARD_MARKER)) {
    console.log(`بوابة الأمان موجودة سابقاً في ${guardTarget} — لم تُكرَّر.`);
  } else {
    const guard = `-- بوابة أمان: لا يُحذف نظام الأدوار إلا والتغطية كاملة فعلاً في قاعدة البيانات.
-- تُقارن ما يمنحه دور كل موظف بما تغطّيه قواعده الصريحة في access_rules،
-- وتُفشل الترحيل كاملاً (قبل تنفيذ أي DROP) إن بقيت درجة واحدة غير مغطّاة.
${coverageGuardSql()};--> statement-breakpoint
`;
    writeFileSync(guardTarget, `${guard}${existing}`, "utf-8");
    console.log(`أُضيفت بوابة الأمان إلى ${guardTarget}`);
  }
}
