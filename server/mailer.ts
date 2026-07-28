import { getMailConfig } from "./config.js";

export interface MailMessage {
  to: string;
  subject: string;
  text: string;
}

export interface MailResult {
  /** هل خرجت الرسالة فعلاً إلى مزوّد البريد؟ */
  delivered: boolean;
  /** سبب عدم الإرسال — يُعرض للمسؤول ولا يُعرض للمستخدم المجهول */
  reason: string;
}

/**
 * إرسال بريد عبر واجهة Resend (HTTPS فقط، تعمل داخل دوال Netlify).
 *
 * التصميم مقصود: عند غياب `RESEND_API_KEY` لا نرمي خطأ ولا نُفشل الطلب، بل
 * نُرجع `delivered: false` ليكمل النظام مساره البديل — أن يُصدر مسؤول البرنامج
 * الرمز يدوياً من لوحة الإدارة. هكذا تعمل الميزة على أي نشر بلا إعداد مسبق.
 */
export async function sendMail(message: MailMessage): Promise<MailResult> {
  const config = getMailConfig();

  if (!config.configured) {
    return {
      delivered: false,
      reason: "مزوّد البريد غير مضبوط (RESEND_API_KEY) — يلزم إصدار الرمز من مسؤول البرنامج.",
    };
  }

  if (!message.to.includes("@")) {
    return { delivered: false, reason: "لا يوجد بريد صالح لهذا الحساب." };
  }

  try {
    const response = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: {
        authorization: `Bearer ${config.apiKey}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        from: config.from,
        to: [message.to],
        subject: message.subject,
        text: message.text,
        ...(config.replyTo ? { reply_to: config.replyTo } : {}),
      }),
    });

    if (!response.ok) {
      // لا نُسجّل جسم الطلب (يحتوي الرمز) — الحالة والرمز فقط
      console.error(
        `[restaurant-hr] فشل إرسال البريد عبر Resend — الحالة ${response.status}`,
      );
      return { delivered: false, reason: `تعذّر الإرسال (رمز ${response.status}).` };
    }

    return { delivered: true, reason: "" };
  } catch (error) {
    console.error(
      "[restaurant-hr] خطأ شبكة أثناء إرسال البريد:",
      error instanceof Error ? error.message : error,
    );
    return { delivered: false, reason: "تعذّر الوصول إلى مزوّد البريد." };
  }
}
