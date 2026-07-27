# نظام إدارة موظفي وتشغيل مطعم متعدد الفروع (restaurant-hr)

نظام متكامل من ثلاثة أجزاء مترابطة تعمل على قاعدة بيانات PostgreSQL مركزية واحدة:

- **لوحة الإدارة** (`/admin`) — واجهة ويب عربية RTL للإدارة والموارد البشرية.
- **تطبيق الموظفين** (`/app`) — تطبيق PWA قابل للتثبيت، للحضور بالموقع الجغرافي ومطابقة الوجه.
- **الخادم وقاعدة البيانات** (`/server`) — Node.js + Express + PostgreSQL مع API آمن بـ JWT.

> **حالة المشروع:** قيد البناء التدريجي. راجع `docs/تقرير-المرحلة.md` لمعرفة ما تم إنجازه وما تبقى بالتفصيل.

## التشغيل محلياً

المتطلبات: Node.js 20+ وخادم PostgreSQL.

```bash
cd server
cp .env.example .env        # عدّل القيم — خاصة JWT_SECRET و FACE_ENC_KEY
npm install
npm run migrate             # إنشاء الجداول — آمن للتكرار
npm run seed                # الأدوار والصلاحيات وحساب admin الأول
npm start                   # http://localhost:3000
```

- لوحة الإدارة: http://localhost:3000/admin/
- تطبيق الموظف: http://localhost:3000/app/
- الدخول الأول: `admin` وكلمة المرور من `ADMIN_INITIAL_PASSWORD` (يفرض تغييرها عند أول دخول).

## النشر على منصة سحابية (Railway / Render)

1. أنشئ قاعدة PostgreSQL من المنصة وخذ رابط `DATABASE_URL`.
2. انشر المستودع (يوجد Dockerfile جاهز) واضبط متغيرات البيئة: `DATABASE_URL`, `JWT_SECRET`, `FACE_ENC_KEY`, `ADMIN_INITIAL_PASSWORD`.
3. الترحيلات والبذر تُنفذ تلقائياً عند الإقلاع ولا تمس البيانات الموجودة.
4. الكاميرا والموقع الجغرافي يتطلبان HTTPS (توفره المنصات السحابية تلقائياً).

## تشغيل اختبارات القبول (بيئة اختبار فقط)

```bash
cd server
node src/index.js &          # مع قاعدة اختبار وليست الإنتاج
node tests/acceptance.mjs
```

## أهم القرارات الأمنية

- كلمات المرور: bcrypt (12 جولة) — لا تُحفظ نصاً واضحاً أبداً.
- قوالب الوجه: قالب رياضي 128 بعداً مشفر AES-256-GCM بمفتاح `FACE_ENC_KEY` — لا تُحفظ صور.
- وقت الحضور: من توقيت الخادم دائماً، لا يعتمد على جهاز الموظف.
- قفل الحساب بعد 5 محاولات فاشلة (قابل للتعديل من `system_settings`).
- الجلسات مسجلة في قاعدة البيانات وقابلة للإنهاء من الإدارة.
- الصلاحيات RBAC من قاعدة البيانات وليست ثابتة في الكود، مع حصر مدير الفرع بفرعه.
- كل عملية حساسة تُسجل في `audit_logs` بالقيمة القديمة والجديدة.
- الحذف منطقي (Soft Delete) للسجلات المهمة.
- Employee ID رقمي ثابت هو مفتاح الربط — ليس الاسم ولا رقم الهوية.

## بنية المشروع

```
restaurant-hr/
├── server/
│   ├── migrations/        # ملفات الترحيل — بناء الجداول بعلاقات كاملة
│   ├── seeds/seed.js      # أدوار وصلاحيات وحساب admin
│   ├── src/
│   │   ├── index.js       # نقطة التشغيل
│   │   ├── db.js          # اتصال PostgreSQL
│   │   ├── migrate.js     # مشغل الترحيلات
│   │   ├── middleware/    # auth (JWT+جلسات) / rbac / audit
│   │   ├── routes/        # auth, employees, branches, attendance, shifts, misc
│   │   └── utils/         # geo (Haversine) / faceCrypto (AES-256-GCM)
│   └── tests/acceptance.mjs
├── admin/                 # لوحة الإدارة العربية RTL
├── app/                   # تطبيق الموظفين PWA
├── docs/تقرير-المرحلة.md  # تقرير الحالة والمراحل
└── Dockerfile
```

└── Dockerfile
```
