/**
 * قاموس الصلاحيات: البيانات الثابتة فقط (بلا قاعدة بيانات).
 *
 * ينقسم إلى طبقتين:
 *  1. `PERMISSIONS` — الرموز الذرّية التي تُفحص في كل مسار خادم.
 *  2. `MODULE_CATALOG` — بنود النظام كما يراها المستخدم في شاشة «إدارة
 *     الصلاحيات»، وكل بند له درجات متدرّجة (1..4) ودرجة حذف مستقلة، وكل
 *     درجة تُترجم إلى مجموعة رموز ذرّية. هذه الطبقة هي ما يُخزَّن في
 *     `access_rules`، وهي **المصدر النهائي** لدرجة البند حين توجد قاعدة.
 *
 * يُستورد هذا الملف من `rbac.ts` (الذي يعيد تصديره) حتى تبقى نقطة الاستيراد
 * واحدة في بقية الخادم وتُمنع الحلقات الدائرية بين الوحدات.
 */

/**
 * الصلاحيات الذرّية في النظام. لا تُمنح مباشرةً لأحد: كل رمز يأتي من درجة بند
 * في `access_rules`، ويُفحص كل مسار بصلاحيته الخاصة.
 *
 * ملاحظة مهمة: `attendanceManualWrite` أقوى ما في بند سجلات الحضور — تسمح
 * بإنشاء/تعديل/حذف أي سجل حضور بكل حقوله، فهي في أعلى درجة من درجاته. أما
 * `attendanceCorrectCheckout` فأدنى منها: تصحيح وقت انصراف وردية أُقفلت
 * تلقائياً فقط.
 */
export const PERMISSIONS = {
  attendanceCheckIn: "attendance.check_in",
  attendanceReadOwn: "attendance.read_own",
  attendanceReadAll: "attendance.read_all",
  attendanceApprove: "attendance.approve",
  attendanceManualWrite: "attendance.manual_write",
  attendanceCorrectCheckout: "attendance.correct_checkout",
  employeesRead: "employees.read",
  employeesWrite: "employees.write",
  branchesRead: "branches.read",
  branchesWrite: "branches.write",
  reportsView: "reports.view",
  auditRead: "audit.read",
  formsSubmit: "forms.submit",
  formsReadOwn: "forms.read_own",
  formsReadAll: "forms.read_all",
  formsApprove: "forms.approve",
  bonusesManage: "bonuses.manage",
  contractsManage: "contracts.manage",
  salaryManage: "salary.manage",
  payrollManage: "payroll.manage",
  vouchersManage: "vouchers.manage",
  custodyManage: "custody.manage",
  schedulesManage: "schedules.manage",
  /** تخصيص صلاحيات عرض لموظف بعينه (فوق صلاحيات دوره) */
  permissionsManage: "permissions.manage",
  /** الكاشير يرفع تقفيله اليومي بنفسه */
  cashierSubmit: "cashier.submit",
  /** عرض تقفيلات كل الكاشيرات لا تقفيلاته فقط */
  cashierReadAll: "cashier.read_all",
  /** مراجعة/اعتماد التقفيل وتعديله بعد الرفع */
  cashierReview: "cashier.review",
  inventoryRead: "inventory.read",
  inventoryWrite: "inventory.write",
  /** إدارة أصناف المخزون نفسها (لا الحركات فقط) */
  inventoryItemsManage: "inventory.items_manage",
  /** لوحة الإعدادات الشاملة: الكيانات الأساسية وهوية المطبوعات */
  settingsManage: "settings.manage",
  /** طباعة/إصدار النماذج الرسمية من حزمة المستندات */
  documentsPrint: "documents.print",
  documentsReadAll: "documents.read_all",
  disciplinaryManage: "disciplinary.manage",
  /* أقسام العرض — تُستخدم لإظهار/إخفاء أقسام بعينها لموظف محدّد */
  sectionPayroll: "sections.payroll",
  sectionCashierClosing: "sections.cashier_closing",
  sectionReports: "sections.reports",
  sectionEmployeeFile: "sections.employee_file",
  sectionInventory: "sections.inventory",
  sectionSettings: "sections.settings",
  sectionDocuments: "sections.documents",

  /* ── النقدية والخزينة (إضافة نظام تقفيل الكاشير والنقدية) ─────── */
  /** قراءة السجل الموحّد للمصاريف والمشتريات النقدية */
  cashExpensesRead: "cash_expenses.read",
  /** تسجيل وتعديل فواتير المصاريف والمشتريات النقدية */
  cashExpensesWrite: "cash_expenses.write",
  /** قراءة تسويات الشبكات وتطبيقات التوصيل */
  settlementsRead: "settlements.read",
  /** تسجيل وتعديل تسوية قبل تأكيدها */
  settlementsManage: "settlements.manage",
  /** تأكيد وصول المبلغ إلى البنك وإقفال التسوية */
  settlementsConfirm: "settlements.confirm",
  /** عرض ملخّص إقفال الشهر والرصيد النقدي الشهري */
  monthlySummaryView: "monthly.summary_view",
  /** اعتماد ترحيل صافي الشهر إلى بداية الشهر الجديد */
  monthlyCarryForward: "monthly.carry_forward",
  /** تصفير الرصيد وبدء الشهر الجديد من صفر */
  monthlyReset: "monthly.reset",
  /** شاشة النقدية والخزينة في لوحة الإدارة */
  sectionCashBook: "sections.cash_book",
} as const;

export const PERMISSION_CATALOG: Array<{ code: string; description: string }> = [
  { code: PERMISSIONS.attendanceCheckIn, description: "تسجيل الحضور والانصراف" },
  { code: PERMISSIONS.attendanceReadOwn, description: "عرض سجل الحضور الشخصي" },
  { code: PERMISSIONS.attendanceReadAll, description: "عرض سجلات حضور جميع الموظفين" },
  { code: PERMISSIONS.attendanceApprove, description: "اعتماد أو رفض سجلات الحضور" },
  {
    code: PERMISSIONS.attendanceManualWrite,
    description: "إضافة وتعديل سجلات الحضور يدوياً بكل حقولها (الموارد البشرية)",
  },
  {
    code: PERMISSIONS.attendanceCorrectCheckout,
    description: "تصحيح وقت الانصراف بعد الإقفال التلقائي مع خصم ساعات",
  },
  { code: PERMISSIONS.employeesRead, description: "عرض بيانات الموظفين" },
  { code: PERMISSIONS.employeesWrite, description: "إضافة وتعديل الموظفين" },
  { code: PERMISSIONS.branchesRead, description: "عرض الفروع" },
  { code: PERMISSIONS.branchesWrite, description: "إضافة وتعديل الفروع" },
  { code: PERMISSIONS.reportsView, description: "عرض التقارير" },
  { code: PERMISSIONS.auditRead, description: "عرض سجل التدقيق" },
  { code: PERMISSIONS.formsSubmit, description: "تقديم الطلبات (سلفة، أوفرتايم، إجازة)" },
  { code: PERMISSIONS.formsReadOwn, description: "عرض نماذج الموظف الخاصة به" },
  { code: PERMISSIONS.formsReadAll, description: "عرض نماذج جميع الموظفين" },
  { code: PERMISSIONS.formsApprove, description: "اعتماد أو رفض الطلبات وتعديلها" },
  { code: PERMISSIONS.bonusesManage, description: "إدارة المكافآت" },
  { code: PERMISSIONS.contractsManage, description: "إدارة عقود العمل" },
  { code: PERMISSIONS.salaryManage, description: "تعريف الرواتب والبدلات" },
  { code: PERMISSIONS.payrollManage, description: "توليد مسير الرواتب" },
  { code: PERMISSIONS.vouchersManage, description: "سندات القبض والصرف" },
  { code: PERMISSIONS.custodyManage, description: "إخراج العهد واستلامها" },
  { code: PERMISSIONS.schedulesManage, description: "تعريف جداول الدوام للموظفين" },
  {
    code: PERMISSIONS.permissionsManage,
    description: "تخصيص صلاحيات العرض لموظف بعينه",
  },
  { code: PERMISSIONS.sectionPayroll, description: "رؤية قسم الرواتب" },
  {
    code: PERMISSIONS.sectionCashierClosing,
    description: "رؤية قسم تقفيل الكاشير",
  },
  { code: PERMISSIONS.sectionReports, description: "رؤية شاشة التقارير" },
  {
    code: PERMISSIONS.sectionEmployeeFile,
    description: "رؤية ملف الموظف الكامل",
  },
  { code: PERMISSIONS.cashierSubmit, description: "رفع تقفيل الكاشير اليومي" },
  {
    code: PERMISSIONS.cashierReadAll,
    description: "عرض تقفيلات جميع الكاشيرات",
  },
  { code: PERMISSIONS.cashierReview, description: "مراجعة تقفيل الكاشير وتعديله" },
  { code: PERMISSIONS.inventoryRead, description: "عرض المخزون وحركاته" },
  { code: PERMISSIONS.inventoryWrite, description: "تسجيل حركة مخزون (إدخال/إخراج/جرد)" },
  { code: PERMISSIONS.inventoryItemsManage, description: "إدارة أصناف المخزون" },
  {
    code: PERMISSIONS.settingsManage,
    description: "لوحة الإعدادات: الكيانات الأساسية وهوية المطبوعات",
  },
  { code: PERMISSIONS.documentsPrint, description: "إصدار وطباعة النماذج الرسمية" },
  { code: PERMISSIONS.documentsReadAll, description: "عرض سجل النماذج المُصدرة" },
  { code: PERMISSIONS.disciplinaryManage, description: "إصدار الإنذارات التأديبية" },
  { code: PERMISSIONS.sectionInventory, description: "رؤية شاشة المخزون" },
  { code: PERMISSIONS.sectionSettings, description: "رؤية لوحة الإعدادات" },
  { code: PERMISSIONS.sectionDocuments, description: "رؤية شاشة النماذج القابلة للطباعة" },
  {
    code: PERMISSIONS.cashExpensesRead,
    description: "عرض سجل المصاريف والمشتريات النقدية",
  },
  {
    code: PERMISSIONS.cashExpensesWrite,
    description: "تسجيل وتعديل فواتير المصاريف والمشتريات النقدية",
  },
  { code: PERMISSIONS.settlementsRead, description: "عرض تسويات الشبكات وتطبيقات التوصيل" },
  { code: PERMISSIONS.settlementsManage, description: "تسجيل وتعديل تسوية شبكة أو تطبيق" },
  { code: PERMISSIONS.settlementsConfirm, description: "تأكيد سداد التسوية وإقفالها" },
  { code: PERMISSIONS.monthlySummaryView, description: "عرض ملخص إقفال الشهر" },
  { code: PERMISSIONS.monthlyCarryForward, description: "اعتماد الترحيل الشهري" },
  { code: PERMISSIONS.monthlyReset, description: "تصفير الرصيد الشهري" },
  { code: PERMISSIONS.sectionCashBook, description: "رؤية شاشة النقدية والخزينة" },
];

/**
 * الأقسام والبنود القابلة للتخصيص لموظف بعينه من شاشة الموارد البشرية.
 * كل بند يقابل رمز صلاحية واحد يُفحص في الخادم وتُخفى واجهته في المتصفح،
 * و`group` يُستخدم لتجميع البنود في الواجهة فقط.
 */
export const SECTION_CATALOG: Array<{
  code: string;
  label: string;
  hint: string;
  group: string;
}> = [
  {
    code: PERMISSIONS.sectionPayroll,
    label: "قسم الرواتب",
    hint: "عرض مسيّرات الرواتب وتقرير الرواتب",
    group: "الشاشات",
  },
  {
    code: PERMISSIONS.sectionCashierClosing,
    label: "قسم تقفيل الكاشير",
    hint: "عرض سندات القبض والصرف وتقفيل الكاشير",
    group: "الشاشات",
  },
  {
    code: PERMISSIONS.sectionReports,
    label: "شاشة التقارير",
    hint: "عرض شاشة التقارير وتصديرها",
    group: "الشاشات",
  },
  {
    code: PERMISSIONS.sectionEmployeeFile,
    label: "ملف الموظف الكامل",
    hint: "عرض بيانات ملف الموظف وجدول دوامه",
    group: "الشاشات",
  },
  {
    code: PERMISSIONS.sectionInventory,
    label: "شاشة المخزون",
    hint: "عرض حركة المخزون اليومية والأصناف",
    group: "الشاشات",
  },
  {
    code: PERMISSIONS.sectionDocuments,
    label: "شاشة النماذج والمستندات",
    hint: "عرض حزمة النماذج القابلة للطباعة",
    group: "الشاشات",
  },
  {
    code: PERMISSIONS.sectionSettings,
    label: "لوحة الإعدادات",
    hint: "عرض لوحة الإعدادات الشاملة",
    group: "الشاشات",
  },
  {
    code: PERMISSIONS.reportsView,
    label: "التقارير (صلاحية أساسية)",
    hint: "الصلاحية التي تسمح بقراءة بيانات التقارير من الخادم",
    group: "صلاحيات القراءة",
  },
  {
    code: PERMISSIONS.attendanceReadAll,
    label: "حضور جميع الموظفين",
    hint: "عرض سجلات حضور بقية الفريق",
    group: "صلاحيات القراءة",
  },
  {
    code: PERMISSIONS.formsReadAll,
    label: "نماذج جميع الموظفين",
    hint: "عرض نماذج وطلبات بقية الفريق",
    group: "صلاحيات القراءة",
  },
  {
    code: PERMISSIONS.cashierReadAll,
    label: "تقفيلات جميع الكاشيرات",
    hint: "عرض تقفيلات الفرع كاملة لا تقفيلاته الشخصية فقط",
    group: "صلاحيات القراءة",
  },
  {
    code: PERMISSIONS.documentsReadAll,
    label: "سجل النماذج المُصدرة",
    hint: "عرض من طبع أي نموذج ومتى",
    group: "صلاحيات القراءة",
  },
  {
    code: PERMISSIONS.inventoryRead,
    label: "قراءة المخزون",
    hint: "عرض الأصناف والأرصدة والحركات",
    group: "صلاحيات القراءة",
  },
  {
    code: PERMISSIONS.cashierSubmit,
    label: "رفع تقفيل الكاشير",
    hint: "السماح لهذا الموظف برفع تقفيله اليومي",
    group: "صلاحيات التنفيذ",
  },
  {
    code: PERMISSIONS.cashierReview,
    label: "مراجعة التقفيل",
    hint: "اعتماد أو الاعتراض على تقفيلات الكاشير",
    group: "صلاحيات التنفيذ",
  },
  {
    code: PERMISSIONS.inventoryWrite,
    label: "تسجيل حركة مخزون",
    hint: "إدخال/إخراج/جرد الأصناف",
    group: "صلاحيات التنفيذ",
  },
  {
    code: PERMISSIONS.inventoryItemsManage,
    label: "إدارة أصناف المخزون",
    hint: "إضافة وتعديل الأصناف نفسها",
    group: "صلاحيات التنفيذ",
  },
  {
    code: PERMISSIONS.documentsPrint,
    label: "إصدار النماذج الرسمية",
    hint: "طباعة العقود والإنذارات والإقرارات",
    group: "صلاحيات التنفيذ",
  },
  {
    code: PERMISSIONS.disciplinaryManage,
    label: "الإنذارات التأديبية",
    hint: "إنشاء الإنذارات وإصدارها",
    group: "صلاحيات التنفيذ",
  },
  {
    code: PERMISSIONS.settingsManage,
    label: "تعديل الإعدادات",
    hint: "إضافة/تعديل/حذف الكيانات الأساسية وهوية المطبوعات",
    group: "صلاحيات التنفيذ",
  },
  {
    code: PERMISSIONS.sectionCashBook,
    label: "شاشة النقدية والخزينة",
    hint: "سجل المصاريف، المتبقي النقدي، الرصيد الشهري، وإقفال الشهر",
    group: "الشاشات",
  },
  {
    code: PERMISSIONS.cashExpensesRead,
    label: "قراءة سجل المصاريف النقدية",
    hint: "عرض فواتير المصاريف والمشتريات النقدية",
    group: "صلاحيات القراءة",
  },
  {
    code: PERMISSIONS.settlementsRead,
    label: "قراءة تسويات الشبكات",
    hint: "عرض تسويات الشبكات وتطبيقات التوصيل وعمولاتها",
    group: "صلاحيات القراءة",
  },
  {
    code: PERMISSIONS.monthlySummaryView,
    label: "عرض ملخص الإقفال",
    hint: "ملخّص إقفال الشهر والرصيد النقدي الشهري",
    group: "صلاحيات القراءة",
  },
  {
    code: PERMISSIONS.cashExpensesWrite,
    label: "تسجيل مصروف نقدي",
    hint: "إضافة وتعديل فواتير المصاريف والمشتريات",
    group: "صلاحيات التنفيذ",
  },
  {
    code: PERMISSIONS.settlementsManage,
    label: "تسجيل تسوية شبكة",
    hint: "إضافة وتعديل تسويات الشبكات وتطبيقات التوصيل",
    group: "صلاحيات التنفيذ",
  },
  {
    code: PERMISSIONS.settlementsConfirm,
    label: "تأكيد سداد التسوية",
    hint: "تأكيد وصول المبلغ إلى البنك وإقفال التسوية",
    group: "صلاحيات التنفيذ",
  },
  {
    code: PERMISSIONS.monthlyCarryForward,
    label: "اعتماد الترحيل الشهري",
    hint: "ترحيل صافي الشهر إلى بداية الشهر الجديد",
    group: "صلاحيات التنفيذ",
  },
  {
    code: PERMISSIONS.monthlyReset,
    label: "تصفير الرصيد الشهري",
    hint: "بدء الشهر الجديد من صفر بلا ترحيل",
    group: "صلاحيات التنفيذ",
  },
];

/* ── الصلاحيات المتدرّجة (شاشة «إدارة الصلاحيات») ─────────────────── */

export type AccessLevel = 1 | 2 | 3 | 4;

/** نطاقات المنح: موظف محدّد بالاسم، أو قسم كامل، أو مسمى وظيفي. */
export const ACCESS_SCOPE_TYPES = ["employee", "department", "job_title"] as const;
export type AccessScopeType = (typeof ACCESS_SCOPE_TYPES)[number];

export const ACCESS_SCOPES: Array<{
  type: AccessScopeType;
  label: string;
  hint: string;
}> = [
  {
    type: "employee",
    label: "موظف محدّد",
    hint: "قاعدة تخص هذا الموظف بالاسم وتتقدّم على قاعدة قسمه ومسماه",
  },
  {
    type: "department",
    label: "قسم كامل",
    hint: "تنطبق على كل موظفي القسم ما لم تكن للموظف قاعدة خاصة",
  },
  {
    type: "job_title",
    label: "مسمى وظيفي",
    hint: "تنطبق على كل من يحمل هذا المسمى في جميع الأقسام",
  },
];

/**
 * سلّم الدرجات الأربع. تراكمي: الدرجة الأعلى تُفعّل ما دونها حتماً، فلا يمكن
 * منح «إضافة/تعديل» دون «القراءة» و«تسجيل الحركة». أما **الحذف** فدرجة
 * مستقلة خارج هذا السلّم — انظر `ACCESS_DELETE_GRADE`.
 */
export const ACCESS_LEVELS: Array<{
  level: AccessLevel;
  label: string;
  short: string;
  hint: string;
}> = [
  {
    level: 1,
    label: "قراءة فقط",
    short: "قراءة",
    hint: "عرض البيانات دون أي تغيير",
  },
  {
    level: 2,
    label: "رفع / تسجيل حركة",
    short: "تسجيل",
    hint: "تقديم طلب أو تسجيل حركة جديدة",
  },
  {
    level: 3,
    label: "إضافة / تعديل",
    short: "تحكّم",
    hint: "إنشاء السجلات وتعديلها — دون الحذف",
  },
  {
    level: 4,
    label: "صلاحية إعطاء الموافقات",
    short: "موافقات",
    hint: "اعتماد أو رفض ما يرفعه الآخرون — للبنود التي تحتاج موافقة فعلاً",
  },
];

/**
 * درجة الحذف: **مستقلة تماماً** عن سلّم الدرجات 1..4، تُمنح أو تُسحب وحدها.
 * فقد يملك موظف «إضافة/تعديل» بلا حذف، أو حذفاً بلا موافقات، والعكس.
 * لا تظهر إلا في البنود التي فيها حذف فعلي في الخادم.
 */
export const ACCESS_DELETE_GRADE = {
  key: "delete",
  label: "حذف",
  short: "حذف",
  hint: "حذف السجلات — تُمنح أو تُسحب باستقلال عن درجة الإضافة والتعديل",
} as const;

export interface ModuleLevelSpec {
  level: AccessLevel;
  /** الرموز الذرّية التي تُمنح عند الوصول إلى هذه الدرجة */
  codes: string[];
  /** وصف مخصّص لهذه الدرجة في هذا البند (يظهر كتلميح في الواجهة) */
  hint?: string;
}

export interface AccessModule {
  key: string;
  label: string;
  hint: string;
  group: string;
  levels: ModuleLevelSpec[];
}

const P = PERMISSIONS;

/**
 * بنود النظام القابلة للمنح. الدرجات المذكورة لكل بند هي **المتاحة فقط**:
 * الدرجة 4 (الموافقات) موجودة حصراً في البنود التي فيها قرار اعتماد/رفض
 * حقيقي في الخادم (الحضور، السلف، الأوفرتايم، الإجازات، المكافآت، تقفيلات
 * الفريق، مسير الرواتب)، والدرجة 2 موجودة فقط حيث توجد «حركة تُرفع».
 *
 * كل درجة تُترجم إلى رموز صلاحيات قائمة فعلاً في النظام، ولذلك فإن منح قاعدة
 * يُفعّل مسارات الخادم نفسها. وحيث لا يملك النظام رمزاً منفصلاً للتعديل عن
 * الاعتماد (مثل `forms.approve` و`cashier.review`) يتكرّر الرمز في الدرجتين 3
 * و4، ويأتي فحص `requireModuleLevel` في المسار ليمنع صاحب الدرجة 3 من تنفيذ
 * إجراء الموافقة.
 *
 * **شرط لازم في هذا الجدول:** الدرجة تراكمية — من بلغ درجةً نال رموز ما دونها
 * كلها (`codesForModuleLevel`). فيجب أن تكون رموز كل درجة أضعف مما فوقها وأقوى
 * مما تحتها، ولا يجوز أن تُجمع في درجة واحدة قدرةٌ شخصية (عرض ما يخصّه، رفع
 * حركته) مع قدرة على بيانات الآخرين (عرض الكل، الإدارة). ولو اختلط الأمران في
 * درجة واحدة لصار من يستحق الأدنى نائلاً للأعلى بمجرّد تثبيت درجته في
 * `access_rules` — وهو اتّساع صامت في الصلاحية. ولهذا فُصلت القدرة الشخصية عن
 * قدرة الفريق في بندين مستقلّين حيث اجتمعتا: `attendance_self` مقابل
 * `attendance_records`، و`cashier_self` مقابل `cashier_closing`.
 */
export const MODULE_CATALOG: AccessModule[] = [
  /* ── الحضور والدوام ─────────────────────────────────────────── */
  {
    key: "attendance_self",
    label: "حضوري وانصرافي",
    hint: "بصمة الحضور الشخصية وسجلها",
    group: "الحضور والدوام",
    levels: [
      { level: 1, codes: [P.attendanceReadOwn], hint: "عرض سجله الشخصي" },
      { level: 2, codes: [P.attendanceCheckIn], hint: "تسجيل حضوره وانصرافه" },
    ],
  },
  {
    key: "attendance_records",
    label: "سجلات حضور الموظفين",
    hint: "سجل الحضور الكامل للفريق وتصحيحه واعتماده",
    group: "الحضور والدوام",
    levels: [
      { level: 1, codes: [P.attendanceReadAll], hint: "عرض حضور بقية الفريق" },
      {
        level: 2,
        codes: [P.attendanceCorrectCheckout],
        hint: "تصحيح وقت انصراف وردية أُقفلت تلقائياً",
      },
      {
        level: 3,
        codes: [P.attendanceApprove],
        hint: "اعتماد سجلات الحضور وإقفال الورديات المعلّقة",
      },
      {
        level: 4,
        codes: [P.attendanceManualWrite],
        hint: "إدخال وتعديل سجلات الحضور يدوياً",
      },
    ],
  },
  {
    key: "schedules",
    label: "جداول الدوام",
    hint: "تعريف ورديات الموظفين وأيام العمل",
    group: "الحضور والدوام",
    levels: [
      { level: 1, codes: [P.sectionEmployeeFile], hint: "عرض جدول دوامه" },
      { level: 2, codes: [P.schedulesManage], hint: "حفظ جدول دوام موظف" },
      { level: 3, codes: [P.schedulesManage], hint: "تعديل الجداول" },
    ],
  },

  /* ── الطلبات والنماذج ───────────────────────────────────────── */
  {
    key: "leaves",
    label: "الإجازات",
    hint: "طلبات الإجازة السنوية والمرضية وغيرها",
    group: "الطلبات والنماذج",
    levels: [
      { level: 1, codes: [P.formsReadOwn], hint: "عرض إجازاته" },
      { level: 2, codes: [P.formsSubmit], hint: "تقديم طلب إجازة" },
      { level: 3, codes: [P.formsReadAll], hint: "عرض إجازات بقية الفريق" },
      {
        level: 4,
        codes: [P.formsApprove],
        hint: "اعتماد أو رفض طلبات الإجازة وتعديلها",
      },
    ],
  },
  {
    key: "advances",
    label: "السلف",
    hint: "طلبات السلفة وخصمها من الراتب",
    group: "الطلبات والنماذج",
    levels: [
      { level: 1, codes: [P.formsReadOwn], hint: "عرض سلفه" },
      { level: 2, codes: [P.formsSubmit], hint: "تقديم طلب سلفة" },
      { level: 3, codes: [P.formsReadAll], hint: "عرض سلف بقية الفريق" },
      {
        level: 4,
        codes: [P.formsApprove],
        hint: "اعتماد أو رفض طلبات السلف وتعديلها",
      },
    ],
  },
  {
    key: "overtime",
    label: "الأوفرتايم",
    hint: "طلبات ساعات العمل الإضافية",
    group: "الطلبات والنماذج",
    levels: [
      { level: 1, codes: [P.formsReadOwn], hint: "عرض أوفرتايمه" },
      { level: 2, codes: [P.formsSubmit], hint: "تقديم طلب أوفرتايم" },
      { level: 3, codes: [P.formsReadAll], hint: "عرض أوفرتايم بقية الفريق" },
      {
        level: 4,
        codes: [P.formsApprove],
        hint: "اعتماد أو رفض الأوفرتايم وتعديله",
      },
    ],
  },
  {
    key: "bonuses",
    label: "المكافآت",
    hint: "منح المكافآت وربطها بمسير الرواتب",
    group: "الطلبات والنماذج",
    levels: [
      { level: 1, codes: [P.formsReadOwn], hint: "عرض مكافآته" },
      { level: 2, codes: [P.formsReadAll], hint: "عرض مكافآت بقية الفريق" },
      { level: 3, codes: [P.bonusesManage], hint: "تسجيل المكافآت وتعديلها" },
      { level: 4, codes: [P.bonusesManage], hint: "اعتماد أو رفض المكافآت" },
    ],
  },
  {
    key: "custody",
    label: "العهد",
    hint: "إخراج العهد للموظفين واستلامها",
    group: "الطلبات والنماذج",
    levels: [
      { level: 1, codes: [P.formsReadOwn], hint: "عرض عهده" },
      { level: 2, codes: [P.formsReadAll], hint: "عرض عهد بقية الفريق" },
      {
        level: 3,
        codes: [P.custodyManage],
        hint: "تسجيل إخراج العهد وتعديل سجلاتها",
      },
    ],
  },
  {
    key: "contracts",
    label: "عقود العمل",
    hint: "إصدار عقود الموظفين وتجديدها",
    group: "الطلبات والنماذج",
    levels: [
      { level: 1, codes: [P.formsReadOwn], hint: "عرض عقده" },
      { level: 2, codes: [P.formsReadAll], hint: "عرض عقود بقية الفريق" },
      { level: 3, codes: [P.contractsManage], hint: "إنشاء العقود وتعديلها" },
    ],
  },
  {
    key: "disciplinary",
    label: "الإنذارات التأديبية",
    hint: "إصدار الإنذارات وتوثيقها",
    group: "الطلبات والنماذج",
    levels: [
      { level: 1, codes: [P.documentsReadAll, P.sectionDocuments] },
      { level: 2, codes: [P.disciplinaryManage], hint: "إصدار إنذار" },
      { level: 3, codes: [P.disciplinaryManage], hint: "تعديل الإنذارات" },
    ],
  },

  /* ── الكاشير والمالية ───────────────────────────────────────── */
  {
    key: "cashier_self",
    label: "تقفيل ورديتي",
    hint: "التقفيل الذي يرفعه الكاشير عن وردية نفسه",
    group: "الكاشير والمالية",
    levels: [{ level: 1, codes: [P.cashierSubmit], hint: "رفع تقفيل ورديته" }],
  },
  {
    key: "cashier_closing",
    label: "تقفيلات الفريق",
    hint: "تقفيلات بقية الكاشيرين ومراجعتها واعتمادها",
    group: "الكاشير والمالية",
    levels: [
      {
        level: 1,
        codes: [P.cashierReadAll, P.sectionCashierClosing],
        hint: "عرض تقفيلات الفريق",
      },
      { level: 3, codes: [P.cashierReview], hint: "تعديل تقفيل مرفوع" },
      {
        level: 4,
        codes: [P.cashierReview],
        hint: "اعتماد التقفيل أو الاعتراض عليه",
      },
    ],
  },
  {
    key: "vouchers",
    label: "سندات القبض والصرف (المشتريات والمدفوعات)",
    hint: "سندات الصرف للمشتريات وسندات القبض",
    group: "الكاشير والمالية",
    levels: [
      { level: 1, codes: [P.sectionCashierClosing], hint: "عرض السندات" },
      { level: 2, codes: [P.vouchersManage], hint: "إصدار سند" },
      { level: 3, codes: [P.vouchersManage], hint: "تعديل السندات" },
    ],
  },
  {
    key: "payroll",
    label: "مسير الرواتب",
    hint: "توليد المسير الشهري واعتماده",
    group: "الكاشير والمالية",
    levels: [
      { level: 1, codes: [P.sectionPayroll] },
      { level: 2, codes: [P.payrollManage], hint: "توليد مسير كمسوّدة" },
      { level: 3, codes: [P.payrollManage], hint: "تعديل المسيّرات وإعادة توليدها" },
      { level: 4, codes: [P.payrollManage], hint: "اعتماد المسير الشهري" },
    ],
  },
  {
    key: "salary",
    label: "تعريف الرواتب والبدلات",
    hint: "الراتب الأساسي والبدلات لكل موظف",
    group: "الكاشير والمالية",
    levels: [
      { level: 1, codes: [P.sectionPayroll], hint: "رؤية قسم الرواتب" },
      { level: 3, codes: [P.salaryManage], hint: "تعريف الراتب وتعديله" },
    ],
  },

  /* ── المخزون والمشتريات ─────────────────────────────────────── */
  {
    key: "inventory_movements",
    label: "حركة المخزون (إدخال/إخراج/جرد)",
    hint: "الحركة اليومية للأصناف بما فيها المشتريات الداخلة",
    group: "المخزون والمشتريات",
    levels: [
      { level: 1, codes: [P.inventoryRead, P.sectionInventory] },
      { level: 2, codes: [P.inventoryWrite], hint: "تسجيل حركة إدخال/إخراج/جرد" },
      { level: 3, codes: [P.inventoryItemsManage], hint: "تصحيح الحركات المسجّلة" },
    ],
  },
  {
    key: "inventory_items",
    label: "أصناف المخزون",
    hint: "بطاقات الأصناف وأسعارها وحدودها الدنيا",
    group: "المخزون والمشتريات",
    levels: [
      { level: 1, codes: [P.inventoryRead, P.sectionInventory] },
      {
        level: 3,
        codes: [P.inventoryItemsManage],
        hint: "إضافة وتعديل الأصناف",
      },
    ],
  },

  /* ── الموظفون والمستندات ────────────────────────────────────── */
  {
    key: "employees",
    label: "ملفات الموظفين",
    hint: "بيانات الموظف الأساسية وملفه",
    group: "الموظفون والمستندات",
    levels: [
      { level: 1, codes: [P.sectionEmployeeFile], hint: "عرض ملفه الشخصي" },
      {
        level: 2,
        codes: [P.employeesRead],
        hint: "عرض ملفات بقية الموظفين",
      },
      {
        level: 3,
        codes: [P.employeesWrite],
        hint: "إضافة وتعديل وتعطيل الموظفين",
      },
    ],
  },
  {
    key: "documents",
    label: "النماذج والمستندات القابلة للطباعة",
    hint: "حزمة النماذج الرسمية وسجل ما صُدر منها",
    group: "الموظفون والمستندات",
    levels: [
      { level: 1, codes: [P.documentsReadAll, P.sectionDocuments] },
      { level: 2, codes: [P.documentsPrint], hint: "إصدار وطباعة نموذج" },
      {
        level: 3,
        codes: [P.documentsReadAll],
        hint: "تعديل سجل الإصدار",
      },
    ],
  },
  {
    key: "reports",
    label: "التقارير",
    hint: "تقارير الحضور والرواتب والمخزون وتصديرها",
    group: "الموظفون والمستندات",
    levels: [{ level: 1, codes: [P.reportsView, P.sectionReports] }],
  },

  /* ── إدارة النظام ───────────────────────────────────────────── */
  {
    key: "branches",
    label: "الفروع",
    hint: "بيانات الفروع ونطاق البصمة الجغرافي",
    group: "إدارة النظام",
    levels: [
      { level: 1, codes: [P.branchesRead] },
      { level: 3, codes: [P.branchesWrite], hint: "إضافة وتعديل الفروع" },
    ],
  },
  {
    key: "settings",
    label: "الإعدادات والكيانات الأساسية",
    hint: "الأقسام والمسميات وبنود الراتب وهوية المطبوعات",
    group: "إدارة النظام",
    levels: [
      { level: 1, codes: [P.sectionSettings] },
      {
        level: 3,
        codes: [P.settingsManage],
        hint: "إضافة وتعديل الكيانات والإعدادات",
      },
    ],
  },
  {
    key: "audit",
    label: "سجل التدقيق",
    hint: "من فعل ماذا ومتى في النظام",
    group: "إدارة النظام",
    levels: [{ level: 1, codes: [P.auditRead] }],
  },
  {
    key: "access_control",
    label: "إدارة الصلاحيات",
    hint: "قواعد الصلاحيات لكل موظف وقسم ومسمى وظيفي",
    group: "إدارة النظام",
    levels: [
      { level: 1, codes: [P.permissionsManage], hint: "عرض القواعد فقط" },
      {
        level: 3,
        codes: [P.permissionsManage],
        hint: "إنشاء وتعديل قواعد الصلاحيات",
      },
    ],
  },

  /* ── النقدية والخزينة وإقفال الشهر ───────────────────────────── */
  {
    key: "cash_expenses",
    label: "المصاريف والمشتريات النقدية",
    hint: "سجل موحّد لكل فاتورة تُدفع نقداً — تُسجَّل مرة وتُخصم مرة",
    group: "الكاشير والمالية",
    levels: [
      {
        level: 1,
        codes: [P.cashExpensesRead, P.sectionCashBook],
        hint: "عرض السجل والمتبقي النقدي والرصيد الشهري",
      },
      {
        level: 2,
        codes: [P.cashExpensesWrite],
        hint: "تسجيل فاتورة مصروف أو شراء نقدي",
      },
      {
        level: 3,
        codes: [P.cashExpensesWrite],
        hint: "تعديل فواتير السجل",
      },
    ],
  },
  {
    key: "settlements",
    label: "تسوية الشبكات وتطبيقات التوصيل",
    hint: "مبيعات كل جهة مقابل المستلم في البنك، والعمولة والنسبة والضريبة",
    group: "الكاشير والمالية",
    levels: [
      {
        level: 1,
        codes: [P.settlementsRead, P.sectionCashBook],
        hint: "عرض التسويات وعمولاتها",
      },
      { level: 2, codes: [P.settlementsManage], hint: "تسجيل تسوية جديدة" },
      {
        level: 3,
        codes: [P.settlementsManage],
        hint: "تعديل التسويات قبل تأكيدها",
      },
      {
        level: 4,
        codes: [P.settlementsConfirm],
        hint: "تأكيد وصول المبلغ للبنك وإقفال التسوية",
      },
    ],
  },

  /*
   * ثلاثة بنود مستقلة بخانة صح واحدة لكل بند (لا سلّم درجات فيها):
   * من مُنح البند رآه وعمل به، ومن لم يُمنح لا يرى الزر أصلاً — والخادم
   * يرفض الطلب على كل حال. الأونر يملكها افتراضياً ويمنحها من يشاء.
   */
  {
    key: "monthly_summary",
    label: "عرض ملخص الإقفال",
    hint: "ملخّص إقفال الشهر (الإجمالي، المصاريف، الصافي) والرصيد الشهري",
    group: "إقفال الشهر والترحيل",
    levels: [
      {
        level: 1,
        codes: [P.monthlySummaryView, P.sectionCashBook],
        hint: "عرض ملخّص الإقفال الشهري وحده دون أي قرار",
      },
    ],
  },
  {
    key: "monthly_carry_forward",
    label: "اعتماد الترحيل الشهري",
    hint: "ترحيل صافي الشهر تلقائياً إلى بداية الشهر الجديد",
    group: "إقفال الشهر والترحيل",
    levels: [
      {
        level: 1,
        codes: [P.monthlyCarryForward, P.monthlySummaryView, P.sectionCashBook],
        hint: "إظهار زر «اعتماد الترحيل» والضغط عليه",
      },
    ],
  },
  {
    key: "monthly_reset",
    label: "تصفير الرصيد الشهري",
    hint: "بدء الشهر الجديد من صفر بلا ترحيل",
    group: "إقفال الشهر والترحيل",
    levels: [
      {
        level: 1,
        codes: [P.monthlyReset, P.monthlySummaryView, P.sectionCashBook],
        hint: "إظهار زر «تصفير» والضغط عليه",
      },
    ],
  },
];

export const MODULE_INDEX = new Map(MODULE_CATALOG.map((item) => [item.key, item]));

/**
 * درجة الحذف لكل بند فيه حذف فعلي في الخادم. البنود غير المذكورة هنا لا
 * تعرض خانة حذف أصلاً (لا يوجد فيها مسار حذف: التقارير، سجل التدقيق،
 * حضوري الشخصي، جداول الدوام، تعريف الراتب).
 *
 * `codes` هي الرموز التي يحتاجها مسار الحذف نفسه. وهي في الغالب الرموز
 * ذاتها التي يحتاجها التعديل، لأن النظام لا يملك رمزاً ذرّياً منفصلاً
 * للحذف؛ ولذلك يأتي فحص `requireModuleDelete` في المسار ليفصل الحذف عن
 * التعديل فصلاً حقيقياً بدل الاعتماد على الرمز.
 */
export const MODULE_DELETE_GRADE: Record<string, { codes: string[]; hint: string }> = {
  attendance_records: { codes: [P.attendanceManualWrite], hint: "حذف سجل حضور" },
  leaves: { codes: [P.formsApprove], hint: "حذف طلبات الإجازة" },
  advances: { codes: [P.formsApprove], hint: "حذف طلبات السلف" },
  overtime: { codes: [P.formsApprove], hint: "حذف طلبات الأوفرتايم" },
  bonuses: { codes: [P.bonusesManage], hint: "حذف المكافآت" },
  custody: { codes: [P.custodyManage], hint: "حذف سجلات العهد" },
  contracts: { codes: [P.contractsManage], hint: "حذف العقود" },
  disciplinary: { codes: [P.disciplinaryManage], hint: "حذف الإنذارات" },
  cashier_closing: { codes: [P.cashierReview], hint: "حذف تقفيل مرفوع" },
  vouchers: { codes: [P.vouchersManage], hint: "حذف السندات" },
  payroll: { codes: [P.payrollManage], hint: "حذف مسير راتب محفوظ" },
  inventory_movements: { codes: [P.inventoryItemsManage], hint: "حذف حركة مخزون" },
  inventory_items: { codes: [P.inventoryItemsManage], hint: "حذف صنف من المخزون" },
  employees: { codes: [P.employeesWrite], hint: "حذف ملف موظف بالكامل" },
  documents: { codes: [P.documentsReadAll], hint: "حذف سجلات الإصدار وتنظيف السجل" },
  branches: { codes: [P.branchesWrite], hint: "حذف فرع" },
  settings: { codes: [P.settingsManage], hint: "حذف كيان أساسي" },
  access_control: { codes: [P.permissionsManage], hint: "حذف قواعد الصلاحيات" },
  cash_expenses: {
    codes: [P.cashExpensesWrite],
    hint: "حذف فاتورة من سجل المصاريف النقدية",
  },
  settlements: {
    codes: [P.settlementsManage],
    hint: "حذف تسوية لم تُؤكَّد بعد",
  },
};

/** هل لهذا البند خانة حذف أصلاً؟ */
export function isDeleteAvailable(moduleKey: string): boolean {
  return Object.hasOwn(MODULE_DELETE_GRADE, moduleKey);
}

/** الرموز التي يحتاجها مسار الحذف في هذا البند. */
export function deleteCodesForModule(moduleKey: string): string[] {
  return MODULE_DELETE_GRADE[moduleKey]?.codes ?? [];
}

/**
 * هل تُستنتج صلاحية الحذف من رموز يملكها الموظف بدوره؟ تُستخدم كأساس عند
 * غياب قاعدة صريحة، حتى لا تنكسر الأدوار القائمة قبل هذه الشاشة.
 */
export function derivedModuleDelete(moduleKey: string, owned: Set<string>): boolean {
  const codes = deleteCodesForModule(moduleKey);
  return codes.length > 0 && codes.some((code) => owned.has(code));
}

/** الدرجات المتاحة فعلاً لبند ما، مرتّبة تصاعدياً (قد تكون غير متصلة). */
export function availableLevels(moduleKey: string): AccessLevel[] {
  const module = MODULE_INDEX.get(moduleKey);
  if (!module) return [];
  return module.levels.map((entry) => entry.level).sort((a, b) => a - b);
}

/** أعلى درجة متاحة لبند ما، أو 0 إن كان البند غير معروف. */
export function maxAvailableLevel(moduleKey: string): number {
  const levels = availableLevels(moduleKey);
  return levels.length === 0 ? 0 : levels[levels.length - 1];
}

/** هل هذه الدرجة متاحة لهذا البند؟ */
export function isLevelAvailable(moduleKey: string, level: number): boolean {
  return availableLevels(moduleKey).includes(level as AccessLevel);
}

/**
 * الرموز التي تُمنح عند بلوغ درجة ما — **تراكمية**: تضم رموز كل الدرجات
 * المتاحة الأدنى منها أو المساوية لها، تطبيقاً لقاعدة «الأعلى يُفعّل ما دونه».
 */
export function codesForModuleLevel(moduleKey: string, level: number): string[] {
  const module = MODULE_INDEX.get(moduleKey);
  if (!module) return [];
  const codes = new Set<string>();
  for (const entry of module.levels) {
    if (entry.level <= level) for (const code of entry.codes) codes.add(code);
  }
  return [...codes];
}

/**
 * الرموز التي **تتجاوز** درجة ممنوحة في بند: رموز كل درجة أعلى منها، مع
 * رموز الحذف إن لم يُمنح الحذف. تُستخدم لسحب ما يمنحه الدور فوق سقف القاعدة.
 */
export function codesAboveModuleLevel(
  moduleKey: string,
  level: number,
  canDelete: boolean,
): string[] {
  const module = MODULE_INDEX.get(moduleKey);
  if (!module) return [];
  const codes = new Set<string>();
  for (const entry of module.levels) {
    if (entry.level > level) for (const code of entry.codes) codes.add(code);
  }
  if (!canDelete) for (const code of deleteCodesForModule(moduleKey)) codes.add(code);
  return [...codes];
}

/**
 * الدرجة المستنتجة من مجموعة رموز يملكها الموظف أصلاً (دوره + تخصيصاته
 * الفردية القديمة). تُحتسب كأعلى درجة يملك الموظف رمزاً واحداً على الأقل من
 * رموزها، حتى لا تنكسر الأدوار القائمة التي لا تملك كل رموز الدرجات الأدنى.
 */
export function derivedModuleLevel(moduleKey: string, owned: Set<string>): number {
  const module = MODULE_INDEX.get(moduleKey);
  if (!module) return 0;
  let best = 0;
  for (const entry of module.levels) {
    if (entry.level <= best) continue;
    if (entry.codes.some((code) => owned.has(code))) best = entry.level;
  }
  return best;
}

/** الحد الأدنى المطلوب من البيانات لعرض القاموس في الواجهة. */
export function accessCatalogPayload() {
  return {
    scopes: ACCESS_SCOPES,
    levels: ACCESS_LEVELS,
    deleteGrade: ACCESS_DELETE_GRADE,
    modules: MODULE_CATALOG.map((module) => ({
      key: module.key,
      label: module.label,
      hint: module.hint,
      group: module.group,
      levels: module.levels.map((entry) => ({
        level: entry.level,
        hint: entry.hint ?? "",
      })),
      delete: {
        available: isDeleteAvailable(module.key),
        hint: MODULE_DELETE_GRADE[module.key]?.hint ?? "",
      },
    })),
  };
}
