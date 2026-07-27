import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { getFaceEncryptionKey } from "./config.js";

const ALGORITHM = "aes-256-gcm";
const IV_LENGTH = 12; // المعيار الموصى به لـGCM
const VERSION = "v1";

/** إصدار مفتاح التشفير المستخدم — يُحفظ مع كل صف لتسهيل تدوير المفاتيح. */
export const KEY_VERSION = VERSION;

/**
 * تشفير نص بـAES-256-GCM. الناتج: `v1.<iv>.<tag>.<ciphertext>` بترميز base64url.
 * الوسم (tag) يضمن سلامة البيانات: أي تعديل على النص المشفَّر يُفشل فك التشفير.
 */
export function encryptString(plaintext: string): string {
  const iv = randomBytes(IV_LENGTH);
  const cipher = createCipheriv(ALGORITHM, getFaceEncryptionKey(), iv);

  const ciphertext = Buffer.concat([
    cipher.update(plaintext, "utf8"),
    cipher.final(),
  ]);

  return [
    VERSION,
    iv.toString("base64url"),
    cipher.getAuthTag().toString("base64url"),
    ciphertext.toString("base64url"),
  ].join(".");
}

/** فك تشفير نص أنتجته `encryptString`. يرمي خطأ إذا تغيّر المفتاح أو البيانات. */
export function decryptString(payload: string): string {
  const [version, ivPart, tagPart, dataPart] = payload.split(".");

  if (version !== VERSION || !ivPart || !tagPart || !dataPart) {
    throw new Error("صيغة النص المشفَّر غير معروفة");
  }

  const decipher = createDecipheriv(
    ALGORITHM,
    getFaceEncryptionKey(),
    Buffer.from(ivPart, "base64url"),
  );
  decipher.setAuthTag(Buffer.from(tagPart, "base64url"));

  return Buffer.concat([
    decipher.update(Buffer.from(dataPart, "base64url")),
    decipher.final(),
  ]).toString("utf8");
}
