/**
 * فحص ذاتي لمنطق النوم الليلي (بلا قاعدة بيانات ولا شبكة):
 *   node --experimental-strip-types tools/night-sleep-selftest.ts
 */
import assert from "node:assert/strict";
import { allBranchesQuiet, branchQuietAt, inWakeSlot, offHours, routineKind, type QuietConfig } from "../server/quiet.ts";

const branch = { timezone: "Asia/Riyadh", openTime: "09:00", closeTime: "01:30", briefTime: "04:00" };
// الرياض = UTC+3
const at = (hhmm: string) => {
  const [h, m] = hhmm.split(":").map(Number);
  return new Date(Date.UTC(2026, 10, 21, h - 3, m));
};
const quiet = (hhmm: string, b = branch) => branchQuietAt(at(hhmm), b, [4, 4]);

assert.equal(quiet("01:29"), false, "قبل الإغلاق: يعمل");
assert.equal(quiet("01:30"), true, "وقت الإغلاق: ينام");
assert.equal(quiet("03:59"), true);
assert.equal(quiet("04:00"), false, "موعد الإقفال الآلي: يستيقظ");
assert.equal(quiet("04:19"), false);
assert.equal(quiet("04:20"), true, "بعد نافذة الإقفال: يعود للنوم");
assert.equal(quiet("08:59"), true);
assert.equal(quiet("09:00"), false, "وقت الفتح: يعمل");
assert.equal(quiet("15:00"), false);
assert.equal(quiet("23:59"), false);
assert.equal(quiet("00:30"), false, "بعد منتصف الليل وقبل الإغلاق: يعمل");

// تقرير ليلي في وقت الإغلاق يفتح نافذته
assert.equal(quiet("02:05", { ...branch, briefTime: "02:00" }), false);
assert.equal(quiet("02:25", { ...branch, briefTime: "02:00" }), true);

// ساعات في نفس اليوم، وساعات متطابقة (لا نوم)، وقيم تالفة (لا نوم)
assert.equal(offHours(7 * 60, "08:00", "23:00"), true);
assert.equal(offHours(12 * 60, "08:00", "23:00"), false);
assert.equal(offHours(3 * 60, "00:00", "00:00"), false);
assert.equal(offHours(3 * 60, "", "01:30"), false);
assert.equal(inWakeSlot(23 * 60 + 55, "23:50", [4]), true);
assert.equal(inWakeSlot(5, "23:50", [4]), true, "النافذة تعبر منتصف الليل");

// كل الفروع يجب أن تكون نائمة؛ وبلا إعدادات لا نوم
const config = (branches: Array<typeof branch>): QuietConfig => ({
  version: 1,
  savedAt: 0,
  branches: branches.map((b, i) => ({ ...b, id: i + 1, code: `B${i}`, edgeConfig: {}, cameras: {} })),
});
assert.equal(allBranchesQuiet(at("03:00"), config([branch])), true);
assert.equal(allBranchesQuiet(at("03:00"), config([branch, { ...branch, openTime: "02:00", closeTime: "23:00" }])), false);
assert.equal(allBranchesQuiet(at("03:00"), config([])), false);
assert.equal(allBranchesQuiet(at("03:00"), null), false);

// تصنيف طلبات الجهاز
assert.equal(routineKind("POST", "/control/edge/events", { events: [] }), "beat");
assert.equal(routineKind("POST", "/control/edge/events", {}), "beat");
assert.equal(routineKind("POST", "/control/edge/events", { events: [{ type: "footfall", entries: 0, exits: 0 }] }), "beat");
assert.equal(routineKind("POST", "/control/edge/events", { events: [{ type: "footfall", entries: 1, exits: 0 }] }), null);
assert.equal(routineKind("POST", "/control/edge/events", { events: [{ type: "intrusion", zoneId: 3 }] }), null, "الدخول الليلي يوقظ");
assert.equal(routineKind("POST", "/control/edge/outbox", { state: "connected", results: [] }), "outbox");
assert.equal(routineKind("POST", "/control/edge/outbox", { results: [{ id: 1, ok: true }] }), null);
assert.equal(routineKind("GET", "/control/edge/config", {}), "config");
assert.equal(routineKind("POST", "/control/edge/preview", { image: "x" }), "preview");
assert.equal(routineKind("GET", "/surveillance/agent/jobs", {}), "jobs");
assert.equal(routineKind("POST", "/surveillance/snapshots", {}), null);
assert.equal(routineKind("POST", "/attendance/punch", {}), null);

console.log("night-sleep selftest: OK");
