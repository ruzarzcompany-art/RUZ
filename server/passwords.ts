import { randomBytes, scryptSync, timingSafeEqual } from "node:crypto";

const KEY_LENGTH = 64;
const PREFIX = "scrypt";

/**
 * يُنتج تجزئة كلمة المرور بصيغة `scrypt$<salt>$<hash>` باستخدام node:crypto
 * دون الحاجة إلى مكتبات أصلية (native) لا تعمل في البيئات السيرفرلس.
 */
export function hashPassword(password: string): string {
  const salt = randomBytes(16);
  const hash = scryptSync(password.normalize("NFKC"), salt, KEY_LENGTH);
  return `${PREFIX}$${salt.toString("hex")}$${hash.toString("hex")}`;
}

/** يتحقق من كلمة المرور بمقارنة ثابتة الزمن. */
export function verifyPassword(password: string, stored: string): boolean {
  const [prefix, saltHex, hashHex] = stored.split("$");
  if (prefix !== PREFIX || !saltHex || !hashHex) return false;

  const expected = Buffer.from(hashHex, "hex");
  const actual = scryptSync(
    password.normalize("NFKC"),
    Buffer.from(saltHex, "hex"),
    expected.length,
  );

  return expected.length === actual.length && timingSafeEqual(expected, actual);
}
