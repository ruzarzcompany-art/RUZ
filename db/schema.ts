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
    /** عدد أيام الإجازة في الشهر — 2 أو 4 */
    daysOffPerMonth: integer("days_off_per_month").notNull().default(4),
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
  (table) => [uniqueIndex("face_templates_employee_unique_idx").on(table.employeeId)],
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
    /** شهر الخصم بصيغة YYYY-MM */
    deductionMonth: text("deduction_month"),
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
