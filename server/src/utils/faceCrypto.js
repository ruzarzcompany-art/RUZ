// faceCrypto.js — تشفير/فك تشفير قالب الوجه الرياضي (128 بعداً) باستخدام AES-256-GCM
// ملاحظة أمنية: لا يتم حفظ أي صورة للوجه إطلاقاً، فقط قالب رقمي (embedding) مشفر.

const crypto = require('crypto');

const ALGORITHM = 'aes-256-gcm';
const IV_LENGTH = 12; // موصى به لـ GCM
const EXPECTED_DIMENSIONS = 128;

function getKey() {
  const hex = process.env.FACE_ENC_KEY;
  if (!hex || hex.length !== 64) {
    throw new Error('FACE_ENC_KEY يجب أن يكون 64 حرف hex (32 بايت) في متغيرات البيئة');
  }
  return Buffer.from(hex, 'hex');
}

/**
 * يشفر مصفوفة أرقام عائمة (قالب الوجه) ويرجع نصاً واحداً قابلاً للتخزين في عمود TEXT
 * الصيغة المخزنة: base64(iv) + ':' + base64(authTag) + ':' + base64(ciphertext)
 */
function encryptFaceTemplate(vector) {
  if (!Array.isArray(vector) || vector.length !== EXPECTED_DIMENSIONS) {
    throw new Error(`قالب الوجه يجب أن يكون مصفوفة من ${EXPECTED_DIMENSIONS} بعداً`);
  }
  const key = getKey();
  const iv = crypto.randomBytes(IV_LENGTH);
  const cipher = crypto.createCipheriv(ALGORITHM, key, iv);

  const plaintext = Buffer.from(Float32Array.from(vector).buffer);
  const encrypted = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  const authTag = cipher.getAuthTag();

  return [iv.toString('base64'), authTag.toString('base64'), encrypted.toString('base64')].join(':');
}

/**
 * يفك تشفير النص المخزن ويرجع مصفوفة الأرقام العائمة الأصلية (128 بعداً)
 */
function decryptFaceTemplate(storedValue) {
  if (!storedValue || typeof storedValue !== 'string') {
    throw new Error('قيمة قالب الوجه المخزنة غير صالحة');
  }
  const [ivB64, authTagB64, dataB64] = storedValue.split(':');
  if (!ivB64 || !authTagB64 || !dataB64) {
    throw new Error('تنسيق قالب الوجه المخزن غير صحيح');
  }
  const key = getKey();
  const iv = Buffer.from(ivB64, 'base64');
  const authTag = Buffer.from(authTagB64, 'base64');
  const encrypted = Buffer.from(dataB64, 'base64');

  const decipher = crypto.createDecipheriv(ALGORITHM, key, iv);
  decipher.setAuthTag(authTag);
  const decrypted = Buffer.concat([decipher.update(encrypted), decipher.final()]);

  const floatArray = new Float32Array(
    decrypted.buffer,
    decrypted.byteOffset,
    decrypted.byteLength / Float32Array.BYTES_PER_ELEMENT
  );
  return Array.from(floatArray);
}

/**
 * المسافة الإقليدية بين قالبي وجه — كلما قلّت القيمة زاد التطابق
 */
function euclideanDistance(vectorA, vectorB) {
  if (vectorA.length !== vectorB.length) {
    throw new Error('يجب أن يكون القالبان بنفس عدد الأبعاد للمقارنة');
  }
  let sum = 0;
  for (let i = 0; i < vectorA.length; i += 1) {
    const diff = vectorA[i] - vectorB[i];
    sum += diff * diff;
  }
  return Math.sqrt(sum);
}

/**
 * يقارن قالب وجه ملتقط لحظياً بالقالب المخزن (بعد فك تشفيره) ويرجع نتيجة التطابق
 * threshold الافتراضي قابل للضبط من system_settings (face_match_threshold)
 */
function matchFaceTemplate(capturedVector, storedEncryptedValue, threshold = 0.6) {
  const storedVector = decryptFaceTemplate(storedEncryptedValue);
  const distance = euclideanDistance(capturedVector, storedVector);
  return { isMatch: distance <= threshold, distance, threshold };
}

module.exports = {
  encryptFaceTemplate,
  decryptFaceTemplate,
  euclideanDistance,
  matchFaceTemplate,
  EXPECTED_DIMENSIONS,
};
