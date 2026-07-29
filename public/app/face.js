/**
 * استخراج قالب الوجه (embedding) **داخل متصفح الموظف** — لا تُرفع أي صورة.
 *
 * المكتبة: `@vladmandic/face-api` (نسخة ESM محدّثة من face-api.js) تُحمَّل من
 * jsDelivr مع أوزان الموديلات، وتعمل بالكامل على الجهاز عبر TensorFlow.js.
 * الناتج متجّه من 128 قيمة (FaceNet/ResNet descriptor) يُرسل وحده إلى الخادم.
 *
 * ملاحظات عملية:
 * - يحتاج اتصالاً آمناً (HTTPS) وإذن كاميرا؛ كليهما متاح على Netlify.
 * - التحميل الأول ~8 ميجابايت من الـCDN ثم يُخزَّن في كاش المتصفح.
 * - عند أي فشل (لا كاميرا، رفض الإذن، تعذّر التحميل) نُعيد خطأً واضحاً
 *   وتُكمل عملية الحضور بالموقع الجغرافي وحده (تُوسم `flagged` في الخادم).
 */

const LIB_URL = "https://cdn.jsdelivr.net/npm/@vladmandic/face-api@1.7.15/dist/face-api.esm.js";
const MODEL_URL = "https://cdn.jsdelivr.net/npm/@vladmandic/face-api@1.7.15/model";

/** أقصى عدد محاولات كشف الوجه في اللقطة الواحدة (~6 ثوانٍ). */
const MAX_ATTEMPTS = 14;
const ATTEMPT_DELAY_MS = 420;

let libPromise;
let modelsReady = false;

export function isFaceCaptureSupported() {
  return Boolean(navigator.mediaDevices?.getUserMedia) && window.isSecureContext;
}

async function loadLibrary() {
  if (!libPromise) {
    libPromise = import(/* @vite-ignore */ LIB_URL).catch(() => {
      libPromise = undefined;
      throw new Error("تعذّر تحميل مكتبة التعرف على الوجه. تحقّق من اتصال الإنترنت.");
    });
  }
  return libPromise;
}

async function loadModels(faceapi) {
  if (modelsReady) return;
  await faceapi.tf.ready();
  await Promise.all([
    faceapi.nets.tinyFaceDetector.loadFromUri(MODEL_URL),
    faceapi.nets.faceLandmark68Net.loadFromUri(MODEL_URL),
    faceapi.nets.faceRecognitionNet.loadFromUri(MODEL_URL),
  ]);
  modelsReady = true;
}

/** تحضير المكتبة والموديلات مسبقاً (يُستدعى بعد الدخول لتسريع أول لقطة). */
export async function warmUpFaceEngine() {
  const faceapi = await loadLibrary();
  await loadModels(faceapi);
  return true;
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function startCamera(video) {
  const stream = await navigator.mediaDevices.getUserMedia({
    video: { facingMode: "user", width: { ideal: 640 }, height: { ideal: 480 } },
    audio: false,
  });

  video.srcObject = stream;
  video.muted = true;
  video.playsInline = true;
  await video.play().catch(() => {});

  // انتظر أول إطار حقيقي قبل محاولة الكشف
  if (video.readyState < 2) {
    await new Promise((resolve) => {
      video.addEventListener("loadeddata", resolve, { once: true });
      setTimeout(resolve, 3000);
    });
  }

  return stream;
}

function stopCamera(stream, video) {
  for (const track of stream?.getTracks() ?? []) track.stop();
  if (video) video.srcObject = null;
}

/**
 * يرسم الإطار الحالي من الكاميرا إلى صورة صغيرة **للعرض داخل الجهاز فقط**:
 * تُستخدم لتأكيد هوية الموظف بصرياً عند نجاح المطابقة، ولا تُرسل إلى الخادم
 * ولا تُخزَّن إطلاقاً.
 * @returns {string|null} صورة data URL أو null إن تعذّر الرسم
 */
function frameSnapshot(video) {
  try {
    const width = video.videoWidth;
    const height = video.videoHeight;
    if (!width || !height) return null;

    const scale = Math.min(1, 240 / Math.max(width, height));
    const canvas = document.createElement("canvas");
    canvas.width = Math.max(1, Math.round(width * scale));
    canvas.height = Math.max(1, Math.round(height * scale));

    const context = canvas.getContext("2d");
    if (!context) return null;
    context.drawImage(video, 0, 0, canvas.width, canvas.height);
    return canvas.toDataURL("image/jpeg", 0.7);
  } catch {
    return null;
  }
}

/**
 * يلتقط لقطة واحدة من الكاميرا ويُعيد قالب الوجه.
 * @param {HTMLVideoElement} video عنصر معاينة الكاميرا
 * @param {(text: string) => void} [onProgress]
 * @returns {Promise<{descriptor: number[], score: number, snapshot: string|null}>}
 */
export async function captureFaceDescriptor(video, onProgress = () => {}) {
  if (!isFaceCaptureSupported()) {
    throw new Error("هذا الجهاز/المتصفح لا يدعم التقاط الوجه (يلزم HTTPS وكاميرا).");
  }

  onProgress("جارٍ تحميل محرّك التعرف على الوجه…");
  const faceapi = await loadLibrary();
  await loadModels(faceapi);

  onProgress("جارٍ تشغيل الكاميرا…");
  let stream;
  try {
    stream = await startCamera(video);
  } catch (error) {
    const name = error?.name ?? "";
    if (name === "NotAllowedError" || name === "SecurityError") {
      throw new Error("تم رفض إذن الكاميرا. فعّل الكاميرا من إعدادات المتصفح ثم أعد المحاولة.");
    }
    if (name === "NotFoundError" || name === "OverconstrainedError") {
      throw new Error("لا توجد كاميرا متاحة على هذا الجهاز.");
    }
    throw new Error("تعذّر تشغيل الكاميرا.");
  }

  const options = new faceapi.TinyFaceDetectorOptions({
    inputSize: 320,
    scoreThreshold: 0.4,
  });

  try {
    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt += 1) {
      onProgress(`جارٍ التعرّف على وجهك… (${attempt}/${MAX_ATTEMPTS})`);

      const result = await faceapi
        .detectSingleFace(video, options)
        .withFaceLandmarks()
        .withFaceDescriptor();

      if (result?.descriptor?.length === 128) {
        return {
          descriptor: Array.from(result.descriptor),
          score: Number(result.detection?.score ?? 0),
          // لقطة للعرض على الجهاز فقط — لا تُرسل مع القالب
          snapshot: frameSnapshot(video),
        };
      }

      await delay(ATTEMPT_DELAY_MS);
    }

    throw new Error("لم يتم التعرّف على وجه واضح. اقترب من الكاميرا في إضاءة جيدة وأعد المحاولة.");
  } finally {
    stopCamera(stream, video);
  }
}
