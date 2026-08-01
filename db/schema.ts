import {
  pgTable,
  serial,
  text,
  timestamp,
  integer,
  boolean,
  doublePrecision,
  date,
  primaryKey,
  index,
  uniqueIndex,
  type AnyPgColumn,
} from "drizzle-orm/pg-core";

/**
 * المبالغ المالية تُخزَّن كأرقام عشرية مضاعفة الدقة وتُقرَّب إلى منزلتين
 * عند العرض والحساب النهائي (انظر `server/money.ts`).
 */
const money = (name: string) => doublePrecision(name).notNull().default(0);

/**
 * roles — وظائف الموظفين (مدير عام، مدير فرع، كاشير، طاهي ...)
 */
export const roles = pgTable("roles", {
  id: serial().primaryKey(),
  name: text().notNull().unique(),
  nameAr: text("name_ar").notNull().default(""),
  description: text().notNull().default(""),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

/**
 * permissions — الصلاحيات الذرّية التي تُمنح للأدوار
 */
export const permissions = pgTable("permissions", {
  id: serial().primaryKey(),
  code: text().notNull().unique(),
  description: text().notNull().default(""),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

/**
 * role_permissions — ربط الأدوار بالصلاحيات (many-to-many)
 */
export const rolePermissions = pgTable(
  "role_permissions",
  {
    roleId: integer("role_id")
      .notNull()
      .references(() => roles.id, { onDelete: "cascade" }),
    permissionId: integer("permission_id")
      .notNull()
      .references(() => permissions.id, { onDelete: "cascade" }),
  },
  (table) => [primaryKey({ columns: [table.roleId, table.permissionId] })],
);

/**
 * branches — فروع المطعم مع الإحداثيات ونطاق تسجيل الحضور المسموح
 */
export const branches = pgTable("branches", {
  id: serial().primaryKey(),
  code: text().notNull().unique(),
  name: text().notNull(),
  address: text().notNull().default(""),
  latitude: doublePrecision().notNull(),
  longitude: doublePrecision().notNull(),
  /** نصف قطر السماح بتسجيل الحضور بالأمتار (geofence) */
  radiusMeters: integer("radius_meters").notNull().default(150),
  timezone: text().notNull().default("Asia/Riyadh"),
  /**
   * المدير المسؤول عن الفرع — يُختار من الموظفين بدور «مدير فرع»،
   * ويظهر اسمه في ملف كل موظف تابع للفرع. المرجع دائري بين الجدولين
   * (موظف ← فرع، فرع ← موظف) فنُصرّح بنوع العمود لكسر حلقة الاستدلال.
   */
  managerEmployeeId: integer("manager_employee_id").references(
    (): AnyPgColumn => employees.id,
    { onDelete: "set null" },
  ),
  isActive: boolean("is_active").notNull().default(true),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

/**
 * employees — الموظفون. تسجيل الدخول يتم برقم الموظف أو البريد + كلمة المرور.
 */
export const employees = pgTable(
  "employees",
  {
    id: serial().primaryKey(),
    employeeCode: text("employee_code").notNull().unique(),
    fullName: text("full_name").notNull(),
    email: text(),
    phone: text(),
    /** الجنسية كما في الهوية/الإقامة */
    nationality: text().notNull().default(""),
    /** رقم الهوية الوطنية أو الإقامة */
    nationalId: text("national_id"),
    /** القسم داخل الفرع (المطبخ، الصالة، الكاشير...) */
    department: text().notNull().default(""),
    /** scrypt hash بصيغة scrypt$<salt-hex>$<hash-hex> */
    passwordHash: text("password_hash").notNull(),
    roleId: integer("role_id").references(() => roles.id, {
      onDelete: "set null",
    }),
    branchId: integer("branch_id").references(() => branches.id, {
      onDelete: "set null",
    }),
    jobTitle: text("job_title").notNull().default(""),
    isActive: boolean("is_active").notNull().default(true),
    mustChangePassword: boolean("must_change_password").notNull().default(false),
    /**
     * تفعيل بصمة الوجه لهذا الموظف تحديداً (علامة صح في شاشة الموظفين).
     * عند إلغائها يُعامل الموظف كأن وضع المطابقة `off` مهما كان الإعداد العام،
     * فيسجّل حضوره دون تحقق بالوجه.
     */
    faceEnabled: boolean("face_enabled").notNull().default(true),
    /** تاريخ الانضمام للعمل */
    hiredAt: timestamp("hired_at", { withTimezone: true }),
    lastLoginAt: timestamp("last_login_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex("employees_email_unique_idx").on(table.email),
    index("employees_branch_idx").on(table.branchId),
    index("employees_national_id_idx").on(table.nationalId),
  ],
);

/**
 * sessions — جلسات JWT الصادرة، تسمح بإبطال التوكن قبل انتهاء صلاحيته
 */
export const sessions = pgTable(
  "sessions",
  {
    id: serial().primaryKey(),
    /** jti الموجود داخل التوكن */
    tokenId: text("token_id").notNull().unique(),
    employeeId: integer("employee_id")
      .notNull()
      .references(() => employees.id, { onDelete: "cascade" }),
    userAgent: text("user_agent").notNull().default(""),
    ipAddress: text("ip_address").notNull().default(""),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    /**
     * آخر طلب موثَّق بهذه الجلسة — يُحدَّث في `requireAuth` وتُبطل الجلسة
     * تلقائياً إذا تجاوز الخمول المدة المسموحة (خروج تلقائي بعد ترك الصفحة).
     */
    lastSeenAt: timestamp("last_seen_at", { withTimezone: true }).notNull().defaultNow(),
    revokedAt: timestamp("revoked_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [index("sessions_employee_idx").on(table.employeeId)],
);

/**
 * attendance_logs — سجلات الحضور والانصراف.
 * `server_time` هو الوقت المعتمد رسمياً ويُكتب من توقيت الخادم دائماً،
 * أما `client_reported_time` فيُحفظ للمراجعة فقط ولا يُعتمد عليه.
 */
export const attendanceLogs = pgTable(
  "attendance_logs",
  {
    id: serial().primaryKey(),
    employeeId: integer("employee_id")
      .notNull()
      .references(() => employees.id, { onDelete: "cascade" }),
    branchId: integer("branch_id")
      .notNull()
      .references(() => branches.id, { onDelete: "restrict" }),
    /** check_in | check_out */
    type: text().notNull(),
    /** الوقت الرسمي — توقيت الخادم دائماً */
    serverTime: timestamp("server_time", { withTimezone: true }).notNull().defaultNow(),
    /** الوقت الذي أرسله الجهاز — للمراجعة فقط */
    clientReportedTime: timestamp("client_reported_time", { withTimezone: true }),
    latitude: doublePrecision(),
    longitude: doublePrecision(),
    accuracyMeters: doublePrecision("accuracy_meters"),
    /** المسافة المحسوبة بين الموظف والفرع (Haversine) بالأمتار */
    distanceMeters: doublePrecision("distance_meters"),
    withinGeofence: boolean("within_geofence").notNull().default(false),
    /** approved | rejected | flagged */
    status: text().notNull().default("approved"),
    reason: text().notNull().default(""),
    deviceInfo: text("device_info").notNull().default(""),
    ipAddress: text("ip_address").notNull().default(""),
    /** device = من تطبيق الموظف، manual = إدخال يدوي، auto_close = إقفال تلقائي */
    source: text().notNull().default("device"),
    /** هل تحقّق الخادم من قالب الوجه المُرسل من الجهاز؟ */
    faceVerified: boolean("face_verified").notNull().default(false),
    /** مسافة إقليدية بين القالب المُرسل والقالب المسجَّل (أصغر = أقرب) */
    faceDistance: doublePrecision("face_distance"),
    /** مَن أنشأ السجل يدوياً (الموارد البشرية) */
    createdByEmployeeId: integer("created_by_employee_id").references(
      () => employees.id,
      { onDelete: "set null" },
    ),
    /** مَن صحّح وقت الانصراف بعد الإقفال التلقائي */
    correctedByEmployeeId: integer("corrected_by_employee_id").references(
      () => employees.id,
      { onDelete: "set null" },
    ),
    correctedAt: timestamp("corrected_at", { withTimezone: true }),
    /** الوقت قبل التصحيح — يُحفظ للمراجعة */
    originalServerTime: timestamp("original_server_time", { withTimezone: true }),
    /** ساعات تُخصم من الموظف بتقدير المسؤول عند تصحيح الانصراف */
    deductedHours: doublePrecision("deducted_hours").notNull().default(0),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index("attendance_logs_employee_time_idx").on(
      table.employeeId,
      table.serverTime,
    ),
    index("attendance_logs_branch_time_idx").on(table.branchId, table.serverTime),
  ],
);

/**
 * work_schedules — جدول دوام الموظف: وقت البدء والانتهاء، الساعات اليومية،
 * وعدد أيام الإجازة الشهرية (2 أو 4) مع تحديد أيام الأسبوع تحديداً.
 *
 * يُستخدم في حساب التأخير والدوام الإضافي والساعات المتوقّعة شهرياً بدلاً من
 * الافتراضات الثابتة. الموظف الذي لا يملك صفاً هنا يُحسب بالافتراضات القديمة
 * (240 ساعة شهرياً) حتى لا تتغيّر أي حسابات قائمة.
 */
export const workSchedules = pgTable(
  "work_schedules",
  {
    id: serial().primaryKey(),
    employeeId: integer("employee_id")
      .notNull()
      .references(() => employees.id, { onDelete: "cascade" }),
    /** وقت بدء الوردية بصيغة HH:MM بتوقيت الفرع */
    shiftStart: text("shift_start").notNull().default("09:00"),
    /** وقت انتهاء الوردية بصيغة HH:MM (أصغر من البدء = وردية تمتد لليوم التالي) */
    shiftEnd: text("shift_end").notNull().default("17:00"),
    /** عدد ساعات العمل اليومية المتعاقد عليها */
    dailyHours: doublePrecision("daily_hours").notNull().default(8),
    breakMinutes: integer("break_minutes").notNull().default(0),
    /** عدد أيام الإجازة في الشهر (0–15) */
    daysOffPerMonth: integer("days_off_per_month").notNull().default(4),
    /**
     * طريقة تحديد أيام الإجازة:
     * - `weekly` : أيام أسبوعية متكرّرة تُقرأ من `off_days`.
     * - `dates`  : تواريخ محدّدة داخل كل شهر تُقرأ من `schedule_off_dates`.
     */
    offMode: text("off_mode").notNull().default("weekly"),
    /** أيام الإجازة تحديداً: أرقام أيام الأسبوع 0=الأحد … 6=السبت مفصولة بفاصلة */
    offDays: text("off_days").notNull().default(""),
    /** دقائق السماح قبل اعتبار الحضور تأخيراً */
    graceMinutes: integer("grace_minutes").notNull().default(10),
    note: text().notNull().default(""),
    updatedByEmployeeId: integer("updated_by_employee_id").references(
      () => employees.id,
      { onDelete: "set null" },
    ),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [uniqueIndex("work_schedules_employee_unique_idx").on(table.employeeId)],
);

/**
 * schedule_off_dates — أيام إجازة الموظف بتواريخ محدّدة داخل الشهر.
 *
 * تُستخدم عندما يكون `work_schedules.off_mode = 'dates'`: يختار المسؤول عدد
 * أيام الإجازة الشهرية (2 أو 4 أو 8 …) ثم يحدّد تواريخها فعلياً في التقويم،
 * فلا تُفرض أياماً أسبوعية متكرّرة. الحذف يتسلسل مع الموظف.
 */
export const scheduleOffDates = pgTable(
  "schedule_off_dates",
  {
    id: serial().primaryKey(),
    employeeId: integer("employee_id")
      .notNull()
      .references(() => employees.id, { onDelete: "cascade" }),
    /** تاريخ الإجازة (يوم كامل) بتوقيت الفرع */
    offDate: date("off_date").notNull(),
    note: text().notNull().default(""),
    createdByEmployeeId: integer("created_by_employee_id").references(() => employees.id, {
      onDelete: "set null",
    }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex("schedule_off_dates_unique_idx").on(table.employeeId, table.offDate),
    index("schedule_off_dates_date_idx").on(table.offDate),
  ],
);

/**
 * employee_permission_overrides — تخصيص صلاحيات العرض لموظف بعينه فوق
 * صلاحيات دوره: `allow` تمنح صلاحية لا يملكها دوره، و`deny` تسحب صلاحية
 * يمنحها دوره. الصلاحية الفعلية = صلاحيات الدور + المسموح − الممنوع.
 */
export const employeePermissionOverrides = pgTable(
  "employee_permission_overrides",
  {
    id: serial().primaryKey(),
    employeeId: integer("employee_id")
      .notNull()
      .references(() => employees.id, { onDelete: "cascade" }),
    /** رمز الصلاحية كما في جدول `permissions` (مثال: sections.payroll) */
    permissionCode: text("permission_code").notNull(),
    /** allow | deny */
    effect: text().notNull().default("allow"),
    note: text().notNull().default(""),
    grantedByEmployeeId: integer("granted_by_employee_id").references(
      () => employees.id,
      { onDelete: "set null" },
    ),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex("employee_permission_overrides_unique_idx").on(
      table.employeeId,
      table.permissionCode,
    ),
  ],
);

/**
 * access_rules — قواعد الصلاحيات المتدرّجة (شاشة «إدارة الصلاحيات»).
 *
 * كل صف = بند واحد من النظام (`module_key`) مع درجة واحدة (`level`) تُمنح
 * لنطاق واحد:
 *   • `employee`   — موظف محدّد بالاسم (`employee_id`، و`scope_key` = رقمه)
 *   • `department` — قسم كامل (`scope_key` = اسم القسم)
 *   • `job_title`  — مسمى وظيفي (`scope_key` = اسم المسمى)
 *
 * الدرجات تراكمية: (1) قراءة فقط، (2) رفع/تسجيل حركة، (3) إضافة/تعديل/حذف،
 * (4) إعطاء موافقات — فالدرجة المخزّنة هي أعلى درجة، وما تحتها مُفعَّل حكماً.
 * الأخصّ يفوز عند التعارض: الموظف ثم القسم ثم المسمى الوظيفي.
 */
export const accessRules = pgTable(
  "access_rules",
  {
    id: serial().primaryKey(),
    /** employee | department | job_title */
    scopeType: text("scope_type").notNull(),
    /** مرجع الموظف عند نطاق «موظف محدّد» — يُحذف الصف بحذف الموظف */
    employeeId: integer("employee_id").references(() => employees.id, {
      onDelete: "cascade",
    }),
    /** مفتاح النطاق النصّي: رقم الموظف، أو اسم القسم، أو اسم المسمى الوظيفي */
    scopeKey: text("scope_key").notNull(),
    /** رمز البند كما في `MODULE_CATALOG` (مثال: cashier_closing) */
    moduleKey: text("module_key").notNull(),
    /**
     * 0..4 — الدرجة النهائية لهذا البند في هذا النطاق. القاعدة **تحسم**
     * الدرجة ولا تُضاف فقط: الصفر يعني سحب البند كاملاً مهما منح الدور.
     */
    level: integer().notNull().default(1),
    /** درجة الحذف المستقلة — تُمنح أو تُسحب بمعزل عن درجة الإضافة والتعديل */
    canDelete: boolean("can_delete").notNull().default(false),
    note: text().notNull().default(""),
    grantedByEmployeeId: integer("granted_by_employee_id").references(
      () => employees.id,
      { onDelete: "set null" },
    ),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex("access_rules_scope_module_unique_idx").on(
      table.scopeType,
      table.scopeKey,
      table.moduleKey,
    ),
    index("access_rules_scope_idx").on(table.scopeType, table.scopeKey),
    index("access_rules_employee_idx").on(table.employeeId),
  ],
);

/**
 * face_templates — القالب الرقمي للوجه (embedding) لكل موظف.
 *
 * لا تُخزَّن أي صورة إطلاقاً: القالب يُستخرج على جهاز الموظف داخل المتصفح،
 * ويصل الخادم كمتجّه أرقام فقط، ثم يُخزَّن **مشفَّراً AES-256-GCM**
 * (انظر `server/crypto.ts`). القالب غير قابل لإعادة توليد الصورة منه.
 */
export const faceTemplates = pgTable(
  "face_templates",
  {
    id: serial().primaryKey(),
    employeeId: integer("employee_id")
      .notNull()
      .references(() => employees.id, { onDelete: "cascade" }),
    /** اسم/إصدار النموذج الذي أنتج القالب — القوالب غير متبادلة بين النماذج */
    algorithm: text().notNull().default("face-api:faceRecognitionNet@1.7"),
    /**
     * ترتيب البصمة للموظف (1..3): تطبيق الحضور يسجّل ثلاث بصمات من زوايا
     * وإضاءات مختلفة، والمطابقة تأخذ أقرب مسافة بينها.
     */
    slot: integer().notNull().default(1),
    dimensions: integer().notNull().default(128),
    /** النص المشفَّر بصيغة v1.<iv>.<tag>.<ciphertext> — base64url */
    encryptedTemplate: text("encrypted_template").notNull(),
    keyVersion: text("key_version").notNull().default("v1"),
    enrolledByEmployeeId: integer("enrolled_by_employee_id").references(
      () => employees.id,
      { onDelete: "set null" },
    ),
    enrolledAt: timestamp("enrolled_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex("face_templates_employee_unique_idx").on(table.employeeId, table.slot),
  ],
);

/**
 * audit_logs — سجل تدقيق لكل إجراء إداري حسّاس (تعديل حضور، اعتماد طلب،
 * تصحيح انصراف، تسجيل قالب وجه...) مع القيم قبل/بعد والسبب.
 */
export const auditLogs = pgTable(
  "audit_logs",
  {
    id: serial().primaryKey(),
    actorEmployeeId: integer("actor_employee_id").references(() => employees.id, {
      onDelete: "set null",
    }),
    /** مثال: attendance.manual_create, attendance.correct_checkout, advance.decide */
    action: text().notNull(),
    entityType: text("entity_type").notNull(),
    entityId: integer("entity_id"),
    /** لقطة JSON قبل/بعد التعديل */
    beforeJson: text("before_json"),
    afterJson: text("after_json"),
    reason: text().notNull().default(""),
    ipAddress: text("ip_address").notNull().default(""),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index("audit_logs_entity_idx").on(table.entityType, table.entityId),
    index("audit_logs_actor_time_idx").on(table.actorEmployeeId, table.createdAt),
  ],
);

/**
 * salary_definitions — تعريف راتب الموظف: الأساسي والبدلات ومعامل الأوفرتايم.
 * صف واحد لكل موظف (آخر تعريف سارٍ).
 */
export const salaryDefinitions = pgTable(
  "salary_definitions",
  {
    id: serial().primaryKey(),
    employeeId: integer("employee_id")
      .notNull()
      .references(() => employees.id, { onDelete: "cascade" }),
    basicSalary: money("basic_salary"),
    housingAllowance: money("housing_allowance"),
    transportAllowance: money("transport_allowance"),
    otherAllowances: money("other_allowances"),
    /** أجر الساعة — إن تُرك فارغاً يُحسب من الأساسي ÷ (contractHoursPerMonth) */
    hourlyRate: doublePrecision("hourly_rate"),
    contractHoursPerMonth: doublePrecision("contract_hours_per_month")
      .notNull()
      .default(240),
    /** معامل ساعة الأوفرتايم (نظام العمل السعودي: 1.5) */
    overtimeMultiplier: doublePrecision("overtime_multiplier").notNull().default(1.5),
    currency: text().notNull().default("SAR"),
    effectiveFrom: date("effective_from"),
    note: text().notNull().default(""),
    updatedByEmployeeId: integer("updated_by_employee_id").references(
      () => employees.id,
      { onDelete: "set null" },
    ),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex("salary_definitions_employee_unique_idx").on(table.employeeId),
  ],
);

/**
 * advances — طلبات السلف. تُخصم من الراتب عند الاعتماد
 * (`deduct_from_payroll` + `deduction_month`).
 */
export const advances = pgTable(
  "advances",
  {
    id: serial().primaryKey(),
    employeeId: integer("employee_id")
      .notNull()
      .references(() => employees.id, { onDelete: "cascade" }),
    amount: money("amount"),
    requestDate: date("request_date").notNull(),
    reason: text().notNull().default(""),
    /** pending | approved | rejected */
    status: text().notNull().default("pending"),
    deductFromPayroll: boolean("deduct_from_payroll").notNull().default(true),
    /** شهر الخصم بصيغة YYYY-MM (أول قسط) */
    deductionMonth: text("deduction_month"),
    /**
     * تقسيط السلفة على عدد أشهر: 1 = تُخصم كاملة في شهر الخصم،
     * وأكثر من ذلك يوزّع المبلغ بالتساوي بدءاً من شهر الخصم
     * (القسط الأخير يستوعب فروق التقريب).
     */
    installmentMonths: integer("installment_months").notNull().default(1),
    decisionNote: text("decision_note").notNull().default(""),
    decidedByEmployeeId: integer("decided_by_employee_id").references(
      () => employees.id,
      { onDelete: "set null" },
    ),
    decidedAt: timestamp("decided_at", { withTimezone: true }),
    createdByEmployeeId: integer("created_by_employee_id").references(
      () => employees.id,
      { onDelete: "set null" },
    ),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [index("advances_employee_idx").on(table.employeeId, table.requestDate)],
);

/**
 * overtime_requests — طلبات العمل الإضافي بعدد الساعات وموافقة المسؤول.
 */
export const overtimeRequests = pgTable(
  "overtime_requests",
  {
    id: serial().primaryKey(),
    employeeId: integer("employee_id")
      .notNull()
      .references(() => employees.id, { onDelete: "cascade" }),
    workDate: date("work_date").notNull(),
    hours: doublePrecision().notNull().default(0),
    reason: text().notNull().default(""),
    /** pending | approved | rejected */
    status: text().notNull().default("pending"),
    decisionNote: text("decision_note").notNull().default(""),
    decidedByEmployeeId: integer("decided_by_employee_id").references(
      () => employees.id,
      { onDelete: "set null" },
    ),
    decidedAt: timestamp("decided_at", { withTimezone: true }),
    createdByEmployeeId: integer("created_by_employee_id").references(
      () => employees.id,
      { onDelete: "set null" },
    ),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index("overtime_requests_employee_idx").on(table.employeeId, table.workDate),
  ],
);

/**
 * bonuses — المكافآت التي تُصرف للموظف (تُضاف إلى مسير الراتب).
 */
export const bonuses = pgTable(
  "bonuses",
  {
    id: serial().primaryKey(),
    employeeId: integer("employee_id")
      .notNull()
      .references(() => employees.id, { onDelete: "cascade" }),
    amount: money("amount"),
    bonusDate: date("bonus_date").notNull(),
    reason: text().notNull().default(""),
    /** pending | approved | rejected */
    status: text().notNull().default("approved"),
    createdByEmployeeId: integer("created_by_employee_id").references(
      () => employees.id,
      { onDelete: "set null" },
    ),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [index("bonuses_employee_idx").on(table.employeeId, table.bonusDate)],
);

/**
 * contracts — عقود العمل، قابلة للطباعة كـPDF من شاشة الطباعة.
 */
export const contracts = pgTable(
  "contracts",
  {
    id: serial().primaryKey(),
    employeeId: integer("employee_id")
      .notNull()
      .references(() => employees.id, { onDelete: "cascade" }),
    contractNumber: text("contract_number").notNull().unique(),
    jobTitle: text("job_title").notNull().default(""),
    startDate: date("start_date").notNull(),
    endDate: date("end_date"),
    basicSalary: money("basic_salary"),
    allowancesTotal: money("allowances_total"),
    probationMonths: integer("probation_months").notNull().default(3),
    workingHours: text("working_hours").notNull().default("8 ساعات يومياً / 6 أيام أسبوعياً"),
    terms: text().notNull().default(""),
    /** draft | active | ended */
    status: text().notNull().default("draft"),
    signedAt: date("signed_at"),
    createdByEmployeeId: integer("created_by_employee_id").references(
      () => employees.id,
      { onDelete: "set null" },
    ),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [index("contracts_employee_idx").on(table.employeeId)],
);

/**
 * payroll_slips — مسير الراتب الشهري لكل موظف (لقطة محسوبة ومحفوظة).
 * صافي الراتب = الأساسي + البدلات + الأوفرتايم + المكافآت − السلف − الخصومات.
 */
export const payrollSlips = pgTable(
  "payroll_slips",
  {
    id: serial().primaryKey(),
    employeeId: integer("employee_id")
      .notNull()
      .references(() => employees.id, { onDelete: "cascade" }),
    periodYear: integer("period_year").notNull(),
    periodMonth: integer("period_month").notNull(),
    basicSalary: money("basic_salary"),
    allowancesTotal: money("allowances_total"),
    overtimeHours: doublePrecision("overtime_hours").notNull().default(0),
    overtimeAmount: money("overtime_amount"),
    bonusesAmount: money("bonuses_amount"),
    advancesAmount: money("advances_amount"),
    deductedHours: doublePrecision("deducted_hours").notNull().default(0),
    hoursDeductionAmount: money("hours_deduction_amount"),
    otherDeductions: money("other_deductions"),
    workedHours: doublePrecision("worked_hours").notNull().default(0),
    /** الساعات المتوقّعة حسب جدول دوام الموظف (0 = لا جدول مُعرَّف) */
    expectedHours: doublePrecision("expected_hours").notNull().default(0),
    /** إجمالي دقائق التأخير في الشهر حسب جدول الدوام */
    lateMinutes: doublePrecision("late_minutes").notNull().default(0),
    netPay: money("net_pay"),
    hourlyRate: doublePrecision("hourly_rate").notNull().default(0),
    currency: text().notNull().default("SAR"),
    /** draft | final */
    status: text().notNull().default("draft"),
    notes: text().notNull().default(""),
    generatedByEmployeeId: integer("generated_by_employee_id").references(
      () => employees.id,
      { onDelete: "set null" },
    ),
    generatedAt: timestamp("generated_at", { withTimezone: true }).notNull().defaultNow(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex("payroll_slips_period_unique_idx").on(
      table.employeeId,
      table.periodYear,
      table.periodMonth,
    ),
  ],
);

/**
 * vouchers — سند قبض (receipt) وسند صرف (payment)، قابلان للطباعة.
 */
export const vouchers = pgTable(
  "vouchers",
  {
    id: serial().primaryKey(),
    voucherNumber: text("voucher_number").notNull().unique(),
    /** receipt = سند قبض، payment = سند صرف */
    type: text().notNull(),
    amount: money("amount"),
    voucherDate: date("voucher_date").notNull(),
    description: text().notNull().default(""),
    /** الموظف المرتبط بالسند إن وُجد */
    employeeId: integer("employee_id").references(() => employees.id, {
      onDelete: "set null",
    }),
    /** cash | bank | transfer */
    method: text().notNull().default("cash"),
    beneficiaryName: text("beneficiary_name").notNull().default(""),
    createdByEmployeeId: integer("created_by_employee_id").references(
      () => employees.id,
      { onDelete: "set null" },
    ),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [index("vouchers_type_date_idx").on(table.type, table.voucherDate)],
);

/**
 * custody_items — إخراج عهدة (جهاز، زي، مفتاح...) مع تاريخ التسليم والاستلام.
 */
export const custodyItems = pgTable(
  "custody_items",
  {
    id: serial().primaryKey(),
    employeeId: integer("employee_id")
      .notNull()
      .references(() => employees.id, { onDelete: "cascade" }),
    itemName: text("item_name").notNull(),
    /** device | uniform | key | other */
    itemType: text("item_type").notNull().default("other"),
    serialNumber: text("serial_number").notNull().default(""),
    quantity: integer().notNull().default(1),
    estimatedValue: money("estimated_value"),
    issuedAt: date("issued_at").notNull(),
    dueReturnAt: date("due_return_at"),
    returnedAt: date("returned_at"),
    conditionNote: text("condition_note").notNull().default(""),
    /** issued | returned | lost */
    status: text().notNull().default("issued"),
    createdByEmployeeId: integer("created_by_employee_id").references(
      () => employees.id,
      { onDelete: "set null" },
    ),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [index("custody_items_employee_idx").on(table.employeeId)],
);

/**
 * leave_requests — طلبات الإجازة المرتبطة بملف الموظف.
 */
export const leaveRequests = pgTable(
  "leave_requests",
  {
    id: serial().primaryKey(),
    employeeId: integer("employee_id")
      .notNull()
      .references(() => employees.id, { onDelete: "cascade" }),
    /** annual | sick | unpaid | emergency | other */
    leaveType: text("leave_type").notNull().default("annual"),
    startDate: date("start_date").notNull(),
    endDate: date("end_date").notNull(),
    days: doublePrecision().notNull().default(0),
    reason: text().notNull().default(""),
    /** pending | approved | rejected */
    status: text().notNull().default("pending"),
    decisionNote: text("decision_note").notNull().default(""),
    decidedByEmployeeId: integer("decided_by_employee_id").references(
      () => employees.id,
      { onDelete: "set null" },
    ),
    decidedAt: timestamp("decided_at", { withTimezone: true }),
    createdByEmployeeId: integer("created_by_employee_id").references(
      () => employees.id,
      { onDelete: "set null" },
    ),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index("leave_requests_employee_idx").on(table.employeeId, table.startDate),
  ],
);

/**
 * company_settings — هوية المؤسسة وإعدادات الورق والطباعة.
 * صف واحد فقط (`settings_key = 'default'`) يُقرأ في كل المطبوعات.
 * الشعار يُخزَّن كـData URL داخل قاعدة البيانات حتى يعمل في المعاينة
 * والإنتاج بلا أي خدمة تخزين خارجية.
 */
export const companySettings = pgTable("company_settings", {
  id: serial().primaryKey(),
  settingsKey: text("settings_key").notNull().unique().default("default"),
  companyName: text("company_name").notNull().default("مؤسسة المطعم"),
  companyNameEn: text("company_name_en").notNull().default(""),
  legalForm: text("legal_form").notNull().default(""),
  commercialRegister: text("commercial_register").notNull().default(""),
  taxNumber: text("tax_number").notNull().default(""),
  address: text().notNull().default(""),
  city: text().notNull().default(""),
  country: text().notNull().default("المملكة العربية السعودية"),
  phone: text().notNull().default(""),
  email: text().notNull().default(""),
  website: text().notNull().default(""),
  /** بيانات التذييل التي تظهر أسفل كل ورقة مطبوعة */
  footerText: text("footer_text").notNull().default(""),
  footerNote: text("footer_note").notNull().default(""),
  /** صورة الشعار كـdata URL (base64) */
  logoDataUrl: text("logo_data_url").notNull().default(""),
  logoUpdatedAt: timestamp("logo_updated_at", { withTimezone: true }),
  // ------------------------------------------------ تخصيص تصميم الورقة
  /** A4 | A5 | letter */
  paperSize: text("paper_size").notNull().default("A4"),
  /** portrait | landscape */
  paperOrientation: text("paper_orientation").notNull().default("portrait"),
  marginMm: integer("margin_mm").notNull().default(16),
  baseFontPt: doublePrecision("base_font_pt").notNull().default(11),
  fontFamily: text("font_family").notNull().default("system"),
  accentColor: text("accent_color").notNull().default("#0f766e"),
  textColor: text("text_color").notNull().default("#111827"),
  showLogo: boolean("show_logo").notNull().default(true),
  showFooter: boolean("show_footer").notNull().default(true),
  showSignatures: boolean("show_signatures").notNull().default(true),
  showWatermark: boolean("show_watermark").notNull().default(false),
  watermarkText: text("watermark_text").notNull().default(""),
  headerNote: text("header_note").notNull().default(""),
  currency: text().notNull().default("SAR"),
  updatedByEmployeeId: integer("updated_by_employee_id").references(
    () => employees.id,
    { onDelete: "set null" },
  ),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

/**
 * document_identity_fields — أي بيانات المؤسسة تظهر على مطبوعات كل نموذج.
 *
 * الأصل أن كل مطبوعة تحمل هوية المؤسسة كاملةً كما هي في `company_settings`،
 * لكن بعض النماذج لا يُناسبها ذلك (طلب إجازة داخلي لا يحتاج الرقم الضريبي
 * مثلاً). فيُسجَّل هنا صفٌّ واحد لكل نموذج يُستثنى فيه ما لا يُراد ظهوره،
 * وغياب الصف يعني ظهور الهوية كاملةً — فلا يتغيّر سلوك أي نموذج لم يُخصَّص.
 *
 * هذه المفاتيح تُقيّد الإظهار ولا تُنشئه: مفتاح المؤسسة العام في
 * `company_settings` (الشعار، التذييل، التوقيعات، العلامة المائية) يبقى
 * الأعلى، فإن أُغلق هناك لا يفتحه تخصيص نموذج.
 */
export const documentIdentityFields = pgTable("document_identity_fields", {
  id: serial().primaryKey(),
  /** مفتاح النموذج في حزمة النماذج (advance، leave، payroll_slip ...) */
  docKey: text("doc_key").notNull().unique(),
  showLogo: boolean("show_logo").notNull().default(true),
  showCompanyName: boolean("show_company_name").notNull().default(true),
  showCompanyNameEn: boolean("show_company_name_en").notNull().default(true),
  showCommercialRegister: boolean("show_commercial_register").notNull().default(true),
  showTaxNumber: boolean("show_tax_number").notNull().default(true),
  showAddress: boolean("show_address").notNull().default(true),
  showCity: boolean("show_city").notNull().default(true),
  showCountry: boolean("show_country").notNull().default(true),
  showPhone: boolean("show_phone").notNull().default(true),
  showEmail: boolean("show_email").notNull().default(true),
  showWebsite: boolean("show_website").notNull().default(true),
  showHeaderNote: boolean("show_header_note").notNull().default(true),
  showFooter: boolean("show_footer").notNull().default(true),
  showFooterNote: boolean("show_footer_note").notNull().default(true),
  showSignatures: boolean("show_signatures").notNull().default(true),
  showWatermark: boolean("show_watermark").notNull().default(true),
  updatedByEmployeeId: integer("updated_by_employee_id").references(() => employees.id, {
    onDelete: "set null",
  }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

/**
 * departments — الأقسام (المطبخ، الكاشير، الصالة ...) لإدارتها من لوحة الإعدادات.
 */
export const departments = pgTable("departments", {
  id: serial().primaryKey(),
  name: text().notNull().unique(),
  nameEn: text("name_en").notNull().default(""),
  branchId: integer("branch_id").references(() => branches.id, {
    onDelete: "set null",
  }),
  managerEmployeeId: integer("manager_employee_id").references(
    (): AnyPgColumn => employees.id,
    { onDelete: "set null" },
  ),
  note: text().notNull().default(""),
  isActive: boolean("is_active").notNull().default(true),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

/**
 * job_titles — المسميات الوظيفية المعتمدة.
 */
export const jobTitles = pgTable("job_titles", {
  id: serial().primaryKey(),
  name: text().notNull().unique(),
  nameEn: text("name_en").notNull().default(""),
  departmentId: integer("department_id").references(() => departments.id, {
    onDelete: "set null",
  }),
  defaultBasicSalary: money("default_basic_salary"),
  note: text().notNull().default(""),
  isActive: boolean("is_active").notNull().default(true),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

/**
 * salary_components — بنود الرواتب القابلة للتعريف (بدلات وخصومات).
 */
export const salaryComponents = pgTable("salary_components", {
  id: serial().primaryKey(),
  code: text().notNull().unique(),
  name: text().notNull(),
  /** allowance | deduction */
  kind: text().notNull().default("allowance"),
  /** fixed | percent — النسبة تُحسب من الراتب الأساسي */
  calculation: text().notNull().default("fixed"),
  defaultValue: money("default_value"),
  taxable: boolean().notNull().default(false),
  note: text().notNull().default(""),
  isActive: boolean("is_active").notNull().default(true),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

/**
 * cashier_closings — تقفيل الكاشير اليومي: يرفعه الكاشير بنفسه
 * (مبيعات، نقد، شبكة، فروقات) مرتبطاً بالفرع والتاريخ.
 * الفارق = النقد المعدود − النقد المتوقّع، ويُحسب في الخادم.
 */
export const cashierClosings = pgTable(
  "cashier_closings",
  {
    id: serial().primaryKey(),
    branchId: integer("branch_id")
      .notNull()
      .references(() => branches.id, { onDelete: "cascade" }),
    employeeId: integer("employee_id")
      .notNull()
      .references(() => employees.id, { onDelete: "cascade" }),
    /** تاريخ العمل بتوقيت الفرع */
    businessDate: date("business_date").notNull(),
    /** morning | evening | full — الوردية */
    shift: text().notNull().default("full"),
    openingFloat: money("opening_float"),
    totalSales: money("total_sales"),
    cashSales: money("cash_sales"),
    cardSales: money("card_sales"),
    /** مبيعات شبكة فودكس (Foodics) — تُرصد منفصلة عن باقي الشبكات */
    foodicsSales: money("foodics_sales"),
    transferSales: money("transfer_sales"),
    deliverySales: money("delivery_sales"),
    otherSales: money("other_sales"),
    discounts: money("discounts"),
    refunds: money("refunds"),
    expenses: money("expenses"),
    countedCash: money("counted_cash"),
    /** النقد المتوقّع في الدرج = عهدة البداية + النقد − المصروفات − المرتجعات */
    expectedCash: money("expected_cash"),
    /** الفارق: سالب = عجز، موجب = زيادة */
    difference: money("difference"),
    invoiceCount: integer("invoice_count").notNull().default(0),
    notes: text().notNull().default(""),
    /** submitted | reviewed | disputed */
    status: text().notNull().default("submitted"),
    reviewNote: text("review_note").notNull().default(""),
    reviewedByEmployeeId: integer("reviewed_by_employee_id").references(
      () => employees.id,
      { onDelete: "set null" },
    ),
    reviewedAt: timestamp("reviewed_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    /** تقفيل واحد لكل كاشير في نفس الفرع والتاريخ والوردية */
    uniqueIndex("cashier_closings_unique_idx").on(
      table.branchId,
      table.employeeId,
      table.businessDate,
      table.shift,
    ),
    index("cashier_closings_branch_date_idx").on(table.branchId, table.businessDate),
  ],
);

/**
 * cashier_closing_lines — بنود التقفيل التي يضيفها المستخدم بنفسه:
 * `network` = أجهزة/حسابات الشبكة، و`delivery_app` = تطبيقات التواصل والتوصيل
 * (هنجرستيشن، كيتا، جاهز، ذاشيف...). كل بند سطر مستقل يمكن إضافته وتعديله
 * وحذفه، ومجموع كل تصنيف يُرحّل إلى `card_sales` و`delivery_sales`.
 */
export const cashierClosingLines = pgTable(
  "cashier_closing_lines",
  {
    id: serial().primaryKey(),
    closingId: integer("closing_id")
      .notNull()
      .references(() => cashierClosings.id, { onDelete: "cascade" }),
    /** network | delivery_app */
    category: text().notNull().default("network"),
    label: text().notNull(),
    amount: money("amount"),
    /** رقم الجهاز أو رقم الدفعة كما في التقرير */
    reference: text().notNull().default(""),
    sortOrder: integer("sort_order").notNull().default(0),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index("cashier_closing_lines_closing_idx").on(table.closingId, table.category),
  ],
);

/**
 * inventory_items — أصناف المخزون (مواد أولية، مستهلكات).
 */
export const inventoryItems = pgTable("inventory_items", {
  id: serial().primaryKey(),
  code: text().notNull().unique(),
  name: text().notNull(),
  category: text().notNull().default(""),
  /** وحدة القياس: كجم، لتر، علبة ... */
  unit: text().notNull().default("قطعة"),
  unitCost: money("unit_cost"),
  /**
   * fixed = سعر الوحدة ثابت كما هو مُعرَّف هنا.
   * variable = السعر متغيّر ويُؤخذ من فاتورة الشراء في كل حركة إدخال،
   * وآخر سعر شراء يصبح سعر الوحدة المحتسب للصنف.
   */
  priceMode: text("price_mode").notNull().default("fixed"),
  minQuantity: doublePrecision("min_quantity").notNull().default(0),
  note: text().notNull().default(""),
  isActive: boolean("is_active").notNull().default(true),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

/**
 * inventory_movements — حركة المخزون اليومية لكل فرع:
 * `in` إدخال، `out` إخراج/استهلاك، `count` جرد (الكمية المعدودة فعلياً)،
 * `manufacture` تصنيع (خصم المادة الخام مقابل إضافة المنتج النهائي).
 * الرصيد = آخر جرد + الإدخالات − الإخراجات والتصنيع بعد تاريخ ذلك الجرد.
 */
export const inventoryMovements = pgTable(
  "inventory_movements",
  {
    id: serial().primaryKey(),
    branchId: integer("branch_id")
      .notNull()
      .references(() => branches.id, { onDelete: "cascade" }),
    itemId: integer("item_id")
      .notNull()
      .references(() => inventoryItems.id, { onDelete: "cascade" }),
    /** in | out | count | manufacture */
    movementType: text("movement_type").notNull().default("in"),
    businessDate: date("business_date").notNull(),
    quantity: doublePrecision().notNull().default(0),
    unitCost: money("unit_cost"),
    totalCost: money("total_cost"),
    /** purchase | consumption | waste | transfer | stocktake | manufacture | other */
    reason: text().notNull().default("other"),
    reference: text().notNull().default(""),
    /** فرق الجرد عن الرصيد الدفتري (يُحسب في الخادم لحركات الجرد) */
    variance: doublePrecision().notNull().default(0),
    /** التصنيع: الصنف النهائي الناتج عن استهلاك هذا الخام */
    producedItemId: integer("produced_item_id").references(() => inventoryItems.id, {
      onDelete: "set null",
    }),
    /** عدد الوحدات المنتجة — صفر يعني أنه لم يُسجَّل بعد ويمكن إكماله لاحقاً */
    producedUnits: doublePrecision("produced_units").notNull().default(0),
    /**
     * وزن الوحدة المنتجة الواحدة بوحدة `unitWeightUnit` (جرام عادةً):
     * وزن الوحدة × عدد الوحدات (بعد التحويل إلى وحدة الخام) = الكمية الخام.
     */
    unitWeight: doublePrecision("unit_weight").notNull().default(0),
    /**
     * وحدة قياس `unitWeight` — تُخزَّن صريحةً لأنها تختلف عن وحدة الخام
     * (جرام للوحدة مقابل كيلوجرام للخام)، فلا يُفسَّر الرقم بوحدة خاطئة لاحقاً.
     */
    unitWeightUnit: text("unit_weight_unit").notNull().default(""),
    /**
     * ربط حركتَي التصنيع: حركة خصم الخام ↔ حركة إضافة المنتج. عمود عادي بلا
     * مفتاح أجنبي لأن الجدول يشير إلى نفسه، والحذف يتكفّل بإزالة الطرفين معاً.
     */
    linkedMovementId: integer("linked_movement_id"),
    notes: text().notNull().default(""),
    createdByEmployeeId: integer("created_by_employee_id").references(
      () => employees.id,
      { onDelete: "set null" },
    ),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index("inventory_movements_branch_date_idx").on(table.branchId, table.businessDate),
    index("inventory_movements_item_idx").on(table.itemId, table.businessDate),
  ],
);

/**
 * disciplinary_actions — الإنذارات التأديبية (نموذج قابل للطباعة).
 */
export const disciplinaryActions = pgTable(
  "disciplinary_actions",
  {
    id: serial().primaryKey(),
    employeeId: integer("employee_id")
      .notNull()
      .references(() => employees.id, { onDelete: "cascade" }),
    /** notice | first | second | final | suspension */
    level: text().notNull().default("first"),
    incidentDate: date("incident_date").notNull(),
    incidentDescription: text("incident_description").notNull().default(""),
    violationType: text("violation_type").notNull().default("other"),
    actionTaken: text("action_taken").notNull().default(""),
    deductionAmount: money("deduction_amount"),
    /** draft | issued | acknowledged | cancelled */
    status: text().notNull().default("issued"),
    acknowledgedAt: timestamp("acknowledged_at", { withTimezone: true }),
    notes: text().notNull().default(""),
    createdByEmployeeId: integer("created_by_employee_id").references(
      () => employees.id,
      { onDelete: "set null" },
    ),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index("disciplinary_actions_employee_idx").on(table.employeeId, table.incidentDate),
  ],
);

/**
 * document_issues — سجل النماذج والمستندات التي صُدرت/طُبعت،
 * يُستخدم لتقرير «النماذج المُصدرة» ولتتبّع من طبع ماذا ومتى.
 */
export const documentIssues = pgTable(
  "document_issues",
  {
    id: serial().primaryKey(),
    /** مفتاح النموذج: contract | nda | appointment | warning ... */
    docType: text("doc_type").notNull(),
    title: text().notNull().default(""),
    employeeId: integer("employee_id").references(() => employees.id, {
      onDelete: "set null",
    }),
    branchId: integer("branch_id").references(() => branches.id, {
      onDelete: "set null",
    }),
    /** نوع ومعرّف السجل المرتبط (سلفة، سند، عهدة ...) إن وُجد */
    refType: text("ref_type").notNull().default(""),
    refId: integer("ref_id"),
    /** بيانات إضافية عن اللحظة التي صُدر فيها المستند (JSON نصي) */
    payload: text().notNull().default(""),
    notes: text().notNull().default(""),
    issuedByEmployeeId: integer("issued_by_employee_id").references(
      () => employees.id,
      { onDelete: "set null" },
    ),
    issuedAt: timestamp("issued_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index("document_issues_type_idx").on(table.docType, table.issuedAt),
    index("document_issues_employee_idx").on(table.employeeId, table.issuedAt),
  ],
);

/**
 * password_reset_requests — طلبات «نسيت الرقم السري».
 *
 * لا يُخزَّن الرمز نفسه أبداً بل تجزئته (نفس دالة كلمات المرور)، ويُرسل الرمز
 * إلى بريد الموظف عند توفّر مزوّد بريد. وإن لم يتوفّر يبقى الطلب معلّقاً
 * (`status = pending`) في قائمة مسؤول البرنامج ليصدر رمزاً مؤقتاً بنفسه.
 */
export const passwordResetRequests = pgTable(
  "password_reset_requests",
  {
    id: serial().primaryKey(),
    employeeId: integer("employee_id")
      .notNull()
      .references(() => employees.id, { onDelete: "cascade" }),
    /** ما كتبه الموظف في شاشة الدخول (رقم موظف أو بريد) — للمراجعة فقط */
    requestedIdentifier: text("requested_identifier").notNull().default(""),
    /** تجزئة رمز الاستعادة بصيغة scrypt$<salt>$<hash> */
    codeHash: text("code_hash").notNull(),
    /** عدد محاولات إدخال الرمز الخاطئة على هذا الطلب */
    attempts: integer().notNull().default(0),
    /** pending | sent | used | expired | cancelled */
    status: text().notNull().default("pending"),
    /** email | admin — كيف وصل الرمز للموظف */
    deliveryChannel: text("delivery_channel").notNull().default(""),
    /** البريد الذي أُرسل إليه الرمز (إن أُرسل) */
    deliveredTo: text("delivered_to").notNull().default(""),
    /** المسؤول الذي أصدر الرمز يدوياً */
    issuedByEmployeeId: integer("issued_by_employee_id").references(
      () => employees.id,
      { onDelete: "set null" },
    ),
    ipAddress: text("ip_address").notNull().default(""),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    usedAt: timestamp("used_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index("password_reset_employee_idx").on(table.employeeId, table.createdAt),
    index("password_reset_status_idx").on(table.status, table.createdAt),
  ],
);

/**
 * system_flags — أعلام تشغيلية دائمة (مفتاح/قيمة).
 * أهم استخدامها: العلم `demo_data_purged` الذي يمنع إعادة بذر البيانات
 * التجريبية بعد حذفها من لوحة الإعدادات.
 */
export const systemFlags = pgTable("system_flags", {
  id: serial().primaryKey(),
  flagKey: text("flag_key").notNull().unique(),
  flagValue: text("flag_value").notNull().default(""),
  note: text().notNull().default(""),
  setByEmployeeId: integer("set_by_employee_id").references(() => employees.id, {
    onDelete: "set null",
  }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});
