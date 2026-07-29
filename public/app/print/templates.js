/**
 * قوالب النماذج القابلة للطباعة (13 نموذجاً). كل قالب يستقبل حزمة البيانات
 * القادمة من `GET /api/documents/data` ويرجع عناصر DOM جاهزة للطباعة.
 * الصياغة القانونية عامة، ويظهر معها إشعار «ليست استشارة قانونية».
 */

import { formatDate, formatMoney, label } from "../api.js";

const WEEKDAYS = [
  "الأحد",
  "الاثنين",
  "الثلاثاء",
  "الأربعاء",
  "الخميس",
  "الجمعة",
  "السبت",
];

/**
 * نص أيام الراحة في المطبوعات: أيام أسبوعية متكرّرة، أو تواريخ محدّدة
 * داخل الشهر حسب نمط جدول الموظف.
 */
function restDaysText(schedule) {
  if (!schedule?.daysOffPerMonth) return "—";
  const count = `${schedule.daysOffPerMonth} أيام شهرياً`;

  if (schedule.offMode === "dates") {
    const dates = schedule.offDates ?? [];
    return dates.length > 0
      ? `${count} (بتواريخ محدّدة: ${dates.map((date) => formatDate(date)).join("، ")})`
      : `${count} (بتواريخ محدّدة)`;
  }

  if (!schedule.offDays) return count;
  const days = schedule.offDays
    .split(",")
    .map((day) => WEEKDAYS[Number(day.trim())] ?? day)
    .join("، ");
  return `${count} (${days})`;
}

const LEAVE_TYPES = {
  annual: "سنوية",
  sick: "مرضية",
  unpaid: "بدون راتب",
  emergency: "اضطرارية",
  other: "أخرى",
};

const WARNING_LEVELS = {
  notice: "تنبيه شفهي موثَّق",
  first: "إنذار أول",
  second: "إنذار ثانٍ",
  final: "إنذار نهائي",
  suspension: "إيقاف عن العمل",
};

const CUSTODY_TYPES = {
  device: "جهاز",
  uniform: "زي رسمي",
  key: "مفاتيح",
  other: "أخرى",
};

const dash = (value) =>
  value === null || value === undefined || value === "" ? "—" : String(value);

/* ── عناصر بناء مشتركة ─────────────────────────────────────────── */

export function pairs(rows) {
  const table = document.createElement("table");
  table.className = "sheet__pairs";
  const body = document.createElement("tbody");

  for (const [key, value] of rows) {
    const tr = document.createElement("tr");
    const th = document.createElement("th");
    th.textContent = key;
    const td = document.createElement("td");
    td.textContent = dash(value);
    tr.append(th, td);
    body.append(tr);
  }

  table.append(body);
  return table;
}

function section(title, paragraphs) {
  const wrap = document.createElement("section");
  wrap.className = "sheet__terms";
  const heading = document.createElement("h2");
  heading.textContent = title;
  wrap.append(heading);
  for (const text of paragraphs) {
    const paragraph = document.createElement("p");
    paragraph.textContent = text;
    wrap.append(paragraph);
  }
  return wrap;
}

/** بنود مرقّمة بصياغة «البند: النص». */
function clauses(items) {
  const list = document.createElement("ol");
  list.className = "sheet__clauses";
  for (const item of items) {
    const li = document.createElement("li");
    if (Array.isArray(item)) {
      const strong = document.createElement("strong");
      strong.textContent = `${item[0]}: `;
      li.append(strong, document.createTextNode(item[1]));
    } else {
      li.textContent = item;
    }
    list.append(li);
  }
  return list;
}

export function signatures(labels) {
  const wrap = document.createElement("div");
  wrap.className = "sheet__signs";
  for (const text of labels) {
    const box = document.createElement("div");
    box.className = "sheet__sign";
    const caption = document.createElement("p");
    caption.textContent = text;
    const line = document.createElement("span");
    line.className = "sheet__line";
    box.append(caption, line);
    wrap.append(box);
  }
  return wrap;
}

export function legalNotice(text) {
  if (!text) return null;
  const box = document.createElement("p");
  box.className = "sheet__legal";
  box.textContent = text;
  return box;
}

function note(text) {
  if (!text) return null;
  const paragraph = document.createElement("p");
  paragraph.className = "sheet__note";
  paragraph.textContent = text;
  return paragraph;
}

function table(headers, rows, className = "sheet__table") {
  const element = document.createElement("table");
  element.className = className;

  const thead = document.createElement("thead");
  const headRow = document.createElement("tr");
  for (const text of headers) {
    const th = document.createElement("th");
    th.textContent = text;
    headRow.append(th);
  }
  thead.append(headRow);

  const tbody = document.createElement("tbody");
  for (const row of rows) {
    const tr = document.createElement("tr");
    if (row.className) tr.className = row.className;
    for (const cell of row.cells ?? row) {
      const td = document.createElement("td");
      td.textContent = dash(cell);
      tr.append(td);
    }
    tbody.append(tr);
  }

  element.append(thead, tbody);
  return element;
}

/** سطور تعريف الموظف المشتركة في معظم النماذج. */
function employeeRows(data) {
  const employee = data.employee ?? {};
  const branch = data.branch ?? {};
  return [
    ["اسم الموظف", employee.fullName],
    ["الرقم الوظيفي", employee.employeeCode],
    ["الجنسية", employee.nationality],
    ["رقم الهوية / الإقامة", employee.nationalId],
    ["المسمى الوظيفي", employee.jobTitle],
    ["القسم", employee.department],
    ["الفرع", branch.name],
    ["المدير المسؤول", branch.managerName],
    ["تاريخ المباشرة", employee.hiredAt ? formatDate(employee.hiredAt) : "—"],
  ];
}

const currencyOf = (data) => data.salary?.currency || data.company?.currency || "SAR";

/* ── 1) عقد عمل ────────────────────────────────────────────────── */

function contract(data) {
  const currency = currencyOf(data);
  const reference = data.reference ?? {};
  const salary = data.salary ?? {};
  const schedule = data.schedule ?? {};
  const basic = reference.basicSalary ?? salary.basicSalary ?? 0;
  const allowances = reference.allowancesTotal ?? salary.allowancesTotal ?? 0;
  const probation = reference.probationMonths ?? 3;
  const workingHours =
    reference.workingHours ||
    (schedule.dailyHours
      ? `${schedule.dailyHours} ساعات يومياً من ${schedule.shiftStart} إلى ${schedule.shiftEnd}`
      : "8 ساعات يومياً / 6 أيام أسبوعياً");
  const daysOff = schedule.daysOffPerMonth ?? 4;

  const nodes = [
    pairs([
      ["رقم العقد", reference.contractNumber],
      ["تاريخ بداية العقد", reference.startDate ?? data.today],
      ["تاريخ نهاية العقد", reference.endDate ?? "غير محدّد (عقد غير محدّد المدة)"],
      ...employeeRows(data),
    ]),
    section("الطرفان", [
      `الطرف الأول (صاحب العمل): ${data.company?.companyName ?? ""}` +
        (data.company?.commercialRegister
          ? `، سجل تجاري رقم ${data.company.commercialRegister}`
          : "") +
        (data.company?.address ? `، وعنوانه: ${data.company.address}` : "") +
        ".",
      `الطرف الثاني (الموظف): ${data.employee?.fullName ?? ""}` +
        (data.employee?.nationality ? `، الجنسية: ${data.employee.nationality}` : "") +
        (data.employee?.nationalId
          ? `، بموجب الهوية/الإقامة رقم ${data.employee.nationalId}`
          : "") +
        ".",
      "اتفق الطرفان وهما بكامل الأهلية المعتبرة شرعاً ونظاماً على ما يلي:",
    ]),
    clauses([
      [
        "البند الأول — التمهيد",
        "يُعدّ التمهيد أعلاه وبيانات الطرفين جزءاً لا يتجزأ من هذا العقد ومكمّلاً لأحكامه.",
      ],
      [
        "البند الثاني — طبيعة العمل",
        `يعمل الطرف الثاني لدى الطرف الأول بوظيفة «${data.employee?.jobTitle ?? "—"}» في ${
          data.branch?.name ?? "أحد فروع المنشأة"
        }، ويلتزم بأداء المهام الموكلة إليه بنفسه وبالعناية المهنية المعتادة، ووفق التعليمات واللوائح الداخلية للمنشأة.`,
      ],
      [
        "البند الثالث — مدة العقد وفترة التجربة",
        `${
          reference.endDate
            ? `مدة هذا العقد محدّدة تبدأ من ${reference.startDate ?? data.today} وتنتهي في ${reference.endDate}`
            : `هذا العقد غير محدّد المدة ويبدأ من ${reference.startDate ?? data.today}`
        }، ويخضع الطرف الثاني لفترة تجربة مدتها ${probation} شهراً يجوز لأي من الطرفين فسخ العقد خلالها دون تعويض ودون إشعار مسبق.`,
      ],
      [
        "البند الرابع — الأجر والبدلات",
        `يستحق الطرف الثاني أجراً أساسياً شهرياً مقداره ${formatMoney(basic, currency)}، مضافاً إليه بدلات مقدارها ${formatMoney(
          allowances,
          currency,
        )}، ليصبح إجمالي الأجر الشهري ${formatMoney(
          (Number(basic) || 0) + (Number(allowances) || 0),
          currency,
        )}، يُصرف في نهاية كل شهر ميلادي بعد خصم ما يستحق نظاماً.`,
      ],
      [
        "البند الخامس — ساعات العمل والراحة",
        `ساعات العمل: ${workingHours}، ويستحق الطرف الثاني ${daysOff} أيام راحة في الشهر${
          schedule.breakMinutes ? `، وفترة راحة يومية مدتها ${schedule.breakMinutes} دقيقة` : ""
        }، ولا تُحتسب ساعات العمل الإضافي إلا بموافقة مسبقة من المسؤول المباشر وتُصرف وفق النظام${
          salary.overtimeMultiplier ? ` بمعامل ${salary.overtimeMultiplier}` : ""
        }.`,
      ],
      [
        "البند السادس — الإجازات",
        "يستحق الطرف الثاني الإجازة السنوية والإجازات المرضية والرسمية وفق ما تقرره أنظمة العمل السارية ولائحة المنشأة، وتُنظّم مواعيدها بما لا يخلّ بسير العمل.",
      ],
      [
        "البند السابع — التزامات الموظف",
        "يلتزم الطرف الثاني بالمحافظة على أدوات وممتلكات المنشأة، وبقواعد السلامة والصحة المهنية ومعايير النظافة الغذائية، وبعدم إفشاء أسرار العمل والوصفات والأسعار وبيانات العملاء، وبعدم العمل لدى الغير في نشاط منافس أثناء سريان العقد.",
      ],
      [
        "البند الثامن — العهد والممتلكات",
        "كل ما يُسلَّم للطرف الثاني من أجهزة أو زي أو مفاتيح أو مبالغ يُعدّ عهدة في حكمه، ويلتزم بإعادتها بحالتها عند انتهاء العلاقة العمالية.",
      ],
      [
        "البند التاسع — الجزاءات",
        "يخضع الطرف الثاني للائحة الجزاءات المعتمدة في المنشأة، ولا يجوز توقيع أي جزاء عليه إلا بعد إبلاغه بالمخالفة وسماع أقواله وتدوينها كتابةً.",
      ],
      [
        "البند العاشر — انتهاء العقد",
        "ينتهي هذا العقد بانتهاء مدته أو باتفاق الطرفين أو بإشعار كتابي وفق المدد النظامية، مع حفظ حق كل طرف في المستحقات المترتبة له حتى تاريخ الانتهاء.",
      ],
      [
        "البند الحادي عشر — تسوية الخلافات",
        "يُسعى لتسوية أي خلاف ينشأ عن تنفيذ هذا العقد ودياً، وإلا كان الاختصاص للجهة المختصة بنظر المنازعات العمالية في بلد التشغيل.",
      ],
      [
        "البند الثاني عشر — نسخ العقد",
        "حُرِّر هذا العقد من نسختين، تسلّم كل طرف نسخة للعمل بمقتضاها.",
      ],
    ]),
  ];

  if (reference.terms) nodes.push(section("شروط إضافية", [reference.terms]));
  return nodes;
}

/* ── 2) اتفاقية سرية (NDA) ─────────────────────────────────────── */

function nda(data) {
  return [
    pairs([
      ["تاريخ الاتفاقية", data.today],
      ...employeeRows(data),
    ]),
    section("أطراف الاتفاقية", [
      `أُبرمت هذه الاتفاقية بين ${data.company?.companyName ?? "المنشأة"} (الطرف المفصح) و${
        data.employee?.fullName ?? ""
      } (الطرف المتلقّي)، بمناسبة عمله لدى المنشأة واطّلاعه على معلوماتها السرية.`,
    ]),
    clauses([
      [
        "تعريف المعلومات السرية",
        "تشمل — دون حصر — الوصفات ومقادير الأطباق وطرق التحضير والتتبيل، وقوائم الموردين وأسعار الشراء، وهياكل التكاليف وهوامش الربح، وبيانات العملاء والطلبات، والخطط التسويقية والتوسعية، وأنظمة التشغيل ونقاط البيع وكلمات المرور، وبيانات الموظفين ورواتبهم، وأي معلومة تُوصف بأنها سرية أو يُفهم من طبيعتها أنها كذلك.",
      ],
      [
        "التزام السرية",
        "يتعهد الطرف المتلقّي بالحفاظ على سرية المعلومات، وبعدم إفشائها أو نسخها أو تصويرها أو نقلها لأي شخص داخل المنشأة أو خارجها إلا بحكم ضرورة العمل وبقدرها.",
      ],
      [
        "حصر الاستخدام",
        "تُستخدم المعلومات السرية لأغراض أداء مهام العمل فقط، ولا يجوز استخدامها لمصلحة شخصية أو لمصلحة الغير أو في مشروع منافس.",
      ],
      [
        "وسائل التواصل والتصوير",
        "يُحظر تصوير المطبخ أو الوصفات أو المستندات الداخلية ونشرها على وسائل التواصل الاجتماعي دون إذن كتابي مسبق من الإدارة.",
      ],
      [
        "إعادة المستندات",
        "يلتزم الطرف المتلقّي عند انتهاء علاقته بالمنشأة بإعادة كل ما في حوزته من مستندات أو ملفات أو نسخ إلكترونية، وبحذف ما نُسخ منها على أجهزته الخاصة.",
      ],
      [
        "مدة الالتزام",
        "يسري هذا الالتزام من تاريخ التوقيع ويستمر بعد انتهاء العلاقة العمالية بالنسبة للمعلومات التي تبقى محتفظة بطابعها السري.",
      ],
      [
        "الاستثناءات",
        "لا يشمل الالتزام المعلومات التي تصبح متاحة للجمهور بغير خطأ من الطرف المتلقّي، أو التي يُلزمه بالإفصاح عنها حكم أو أمر من جهة مختصة، على أن يُشعر المنشأة بذلك فوراً وبالقدر الممكن.",
      ],
      [
        "أثر الإخلال",
        "يُعدّ إخلال الطرف المتلقّي بهذه الاتفاقية مخالفة جسيمة تستوجب المساءلة النظامية، ولا يمنع ذلك المنشأة من المطالبة بالتعويض عن الأضرار المترتبة على الإفشاء وفق الأنظمة السارية.",
      ],
    ]),
  ];
}

/* ── 3) نموذج تعيين موظف ───────────────────────────────────────── */

function appointment(data) {
  const currency = currencyOf(data);
  const salary = data.salary ?? {};
  const schedule = data.schedule ?? {};

  return [
    pairs([
      ["تاريخ النموذج", data.today],
      ...employeeRows(data),
      ["البريد الإلكتروني", data.employee?.email],
      ["رقم الجوال", data.employee?.phone],
    ]),
    section("قرار التعيين", [
      `بناءً على ما تقتضيه مصلحة العمل، واستناداً إلى المقابلة الشخصية والمؤهلات المقدَّمة، تقرر تعيين ${
        data.employee?.fullName ?? ""
      } بوظيفة «${data.employee?.jobTitle ?? "—"}» في ${
        data.branch?.name ?? "المنشأة"
      }، وذلك اعتباراً من ${
        data.employee?.hiredAt ? formatDate(data.employee.hiredAt) : data.today
      }.`,
    ]),
    pairs([
      ["الراتب الأساسي", formatMoney(salary.basicSalary ?? 0, currency)],
      ["بدل السكن", formatMoney(salary.housingAllowance ?? 0, currency)],
      ["بدل النقل", formatMoney(salary.transportAllowance ?? 0, currency)],
      ["بدلات أخرى", formatMoney(salary.otherAllowances ?? 0, currency)],
      ["إجمالي الأجر الشهري", formatMoney(salary.totalPackage ?? 0, currency)],
      [
        "الوردية",
        schedule.shiftStart ? `${schedule.shiftStart} — ${schedule.shiftEnd}` : "—",
      ],
      ["ساعات العمل اليومية", schedule.dailyHours ? `${schedule.dailyHours} ساعة` : "—"],
      ["أيام الراحة", restDaysText(schedule)],
    ]),
    clauses([
      [
        "الإقرار",
        "أقر أنا الموظف باستلام نسخة من هذا النموذج، وبأني اطّلعت على مهام وظيفتي ولائحة العمل والجزاءات المعتمدة في المنشأة، وأتعهد بالالتزام بها.",
      ],
      [
        "المستندات المطلوبة",
        "يلتزم الموظف بتسليم صورة الهوية/الإقامة والشهادات والشهادة الصحية (إن كان عمله في تداول الأغذية) قبل مباشرة العمل أو خلال المدة التي تحددها الإدارة.",
      ],
      [
        "فترة التجربة",
        "يخضع التعيين لفترة تجربة وفق ما ينص عليه عقد العمل الموقّع بين الطرفين.",
      ],
    ]),
  ];
}

/* ── 4) إنذار تأديبي ───────────────────────────────────────────── */

function warning(data) {
  const currency = currencyOf(data);
  const action = data.reference ?? {};

  return [
    pairs([
      ["تاريخ الإنذار", action.createdAt ? formatDate(action.createdAt) : data.today],
      ["درجة الإنذار", WARNING_LEVELS[action.level] ?? label(action.level ?? "")],
      ...employeeRows(data),
    ]),
    pairs([
      ["تاريخ الواقعة", action.incidentDate],
      ["نوع المخالفة", action.violationType ? label(action.violationType) : "—"],
      ["وصف الواقعة", action.incidentDescription],
      ["الإجراء المتخذ", action.actionTaken],
      [
        "الخصم المالي",
        action.deductionAmount ? formatMoney(action.deductionAmount, currency) : "لا يوجد",
      ],
      ["الحالة", label(action.status ?? "issued")],
    ]),
    clauses([
      [
        "التنبيه",
        "يُوجَّه إليك هذا الإنذار بسبب الواقعة الموضحة أعلاه، والتي تُعدّ مخالفة للتعليمات ولائحة العمل المعتمدة في المنشأة.",
      ],
      [
        "المطلوب",
        "الالتزام بعدم تكرار المخالفة، والتقيّد بتعليمات المسؤول المباشر وبأنظمة العمل والسلامة والنظافة.",
      ],
      [
        "أثر التكرار",
        "في حال تكرار المخالفة تُتخذ الإجراءات التالية في سلّم الجزاءات، وقد تصل إلى إنهاء العلاقة العمالية وفق الأنظمة السارية.",
      ],
      [
        "حق الاعتراض",
        "يحق للموظف تدوين أقواله وملاحظاته على هذا الإنذار في الحقل المخصص أدناه، وتقديم اعتراضه للموارد البشرية خلال المدة النظامية.",
      ],
    ]),
    section("أقوال الموظف / ملاحظاته", [
      "..................................................................................................................",
      "..................................................................................................................",
    ]),
    note(action.notes ? `ملاحظات إدارية: ${action.notes}` : ""),
  ].filter(Boolean);
}

/* ── 5) إقرار استلام راتب ──────────────────────────────────────── */

function salaryReceipt(data) {
  const slip = data.reference;
  const currency = slip?.currency ?? currencyOf(data);
  const nodes = [
    pairs([
      ["الشهر", data.month],
      ["تاريخ الإقرار", data.today],
      ...employeeRows(data),
    ]),
  ];

  if (slip) {
    nodes.push(
      table(
        ["البند", "القيمة"],
        [
          ["الراتب الأساسي", formatMoney(slip.basicSalary, currency)],
          ["إجمالي البدلات", formatMoney(slip.allowancesTotal, currency)],
          [`الأوفرتايم (${slip.overtimeHours ?? 0} ساعة)`, formatMoney(slip.overtimeAmount, currency)],
          ["المكافآت", formatMoney(slip.bonusesAmount, currency)],
          ["السلف المخصومة", formatMoney(-(slip.advancesAmount ?? 0), currency)],
          [
            `خصم الساعات (${slip.deductedHours ?? 0} ساعة)`,
            formatMoney(-(slip.hoursDeductionAmount ?? 0), currency),
          ],
          ["خصومات أخرى", formatMoney(-(slip.otherDeductions ?? 0), currency)],
          {
            className: "is-total",
            cells: ["صافي المستحق", formatMoney(slip.netPay, currency)],
          },
        ],
      ),
    );
  } else {
    nodes.push(
      note("لا يوجد مسير راتب محفوظ لهذا الشهر — يُكتب المبلغ يدوياً قبل التوقيع."),
      pairs([
        ["صافي المبلغ المستلم", "................................"],
        ["طريقة الصرف", "نقداً / تحويل بنكي"],
      ]),
    );
  }

  nodes.push(
    clauses([
      [
        "الإقرار",
        `أقر أنا ${data.employee?.fullName ?? ""}، رقم الهوية/الإقامة ${
          data.employee?.nationalId ?? "—"
        }، باستلامي كامل مستحقاتي المالية عن شهر ${data.month ?? "—"} بالمبلغ الموضح أعلاه${
          slip ? ` وقدره ${formatMoney(slip.netPay, currency)}` : ""
        }.`,
      ],
      [
        "إبراء عن المدة",
        "وأقر بأنه لم يبقَ لي أي مطالبة مالية تجاه المنشأة تخص هذا الشهر تحديداً، مع بقاء حقوقي النظامية عن المدد الأخرى محفوظة.",
      ],
      [
        "صحة البيانات",
        "وأقر بصحة بيانات الحساب البنكي الذي تُحوَّل إليه مستحقاتي، وأتحمّل مسؤولية أي خطأ في بياناته.",
      ],
    ]),
  );

  return nodes;
}

/* ── 6) سند قبض / سند صرف ──────────────────────────────────────── */

function voucher(data, isReceipt) {
  const currency = currencyOf(data);
  const record = data.reference ?? {};
  const blank = "................................";

  return [
    pairs([
      ["رقم السند", record.voucherNumber ?? blank],
      ["التاريخ", record.voucherDate ?? data.today],
      ["المبلغ", record.amount !== undefined ? formatMoney(record.amount, currency) : blank],
      ["طريقة الدفع", record.method ? label(record.method) : "نقداً / شبكة / تحويل"],
      [
        isReceipt ? "المبلغ مستلم من" : "المبلغ مصروف إلى",
        record.beneficiaryName || data.employee?.fullName || blank,
      ],
      ["الرقم الوظيفي", data.employee?.employeeCode],
      ["الفرع", data.branch?.name],
      ["البيان", record.description ?? blank],
    ]),
    clauses([
      isReceipt
        ? [
            "إقرار الاستلام",
            "استلمت المنشأة المبلغ الموضح أعلاه وقيّدته في حسابها، ويُعدّ هذا السند مخالصة عن المبلغ المذكور فيه فقط.",
          ]
        : [
            "إقرار الصرف",
            "استلمت المبلغ الموضح أعلاه نقداً/بموجب تحويل، ويُعدّ هذا السند مخالصة عن هذا المبلغ فقط ولا يمس أي مستحقات أخرى.",
          ],
      [
        "المرفقات",
        "تُرفق بهذا السند المستندات المؤيّدة (فاتورة، إشعار تحويل، تقرير) إن وُجدت.",
      ],
    ]),
  ];
}

/* ── 7) نموذج إخراج عهدة ───────────────────────────────────────── */

function custody(data) {
  const currency = currencyOf(data);
  const item = data.reference ?? {};

  return [
    pairs([
      ["تاريخ التسليم", item.issuedAt ?? data.today],
      ...employeeRows(data),
    ]),
    table(
      ["الوصف", "النوع", "الرقم التسلسلي", "الكمية", "القيمة التقديرية", "الحالة"],
      [
        [
          item.itemName ?? "................................",
          CUSTODY_TYPES[item.itemType] ?? label(item.itemType ?? "other"),
          item.serialNumber || "—",
          item.quantity ?? 1,
          item.estimatedValue !== undefined
            ? formatMoney(item.estimatedValue, currency)
            : "—",
          item.conditionNote || "جديدة / سليمة",
        ],
      ],
    ),
    pairs([
      ["تاريخ الإرجاع المتوقّع", item.dueReturnAt ?? "—"],
      ["تاريخ الإرجاع الفعلي", item.returnedAt ?? "—"],
      ["حالة العهدة", item.status ? label(item.status) : "مسلَّمة"],
    ]),
    clauses([
      [
        "إقرار الاستلام",
        "أقر باستلامي العهدة الموضحة أعلاه بحالتها المبيّنة، وأتعهد باستخدامها في أغراض العمل فقط والمحافظة عليها.",
      ],
      [
        "المسؤولية",
        "أتحمّل مسؤولية فقدان العهدة أو تلفها نتيجة الإهمال أو سوء الاستخدام، ويحق للمنشأة خصم قيمتها من مستحقاتي وفق الأنظمة السارية.",
      ],
      [
        "الإرجاع",
        "أتعهد بإعادة العهدة عند الطلب أو عند انتهاء علاقتي بالمنشأة أو انتقالي إلى فرع آخر، وقبل استلام مخالصة نهاية الخدمة.",
      ],
    ]),
  ];
}

/* ── 8) طلب إجازة رسمي ─────────────────────────────────────────── */

function leave(data) {
  const request = data.reference ?? {};
  const blank = "................................";

  return [
    pairs([
      ["تاريخ الطلب", request.createdAt ? formatDate(request.createdAt) : data.today],
      ...employeeRows(data),
    ]),
    pairs([
      ["نوع الإجازة", LEAVE_TYPES[request.leaveType] ?? label(request.leaveType ?? "annual")],
      ["من تاريخ", request.startDate ?? blank],
      ["إلى تاريخ", request.endDate ?? blank],
      ["عدد الأيام", request.days ?? blank],
      ["السبب", request.reason ?? blank],
      ["حالة الطلب", request.status ? label(request.status) : "قيد الدراسة"],
      ["ملاحظة القرار", request.decisionNote || "—"],
    ]),
    clauses([
      [
        "تعهد الموظف",
        "أتعهد بتسليم مهامي وعهدي قبل بدء الإجازة، وبالعودة للعمل في التاريخ المحدد، وبإشعار المنشأة فوراً بأي عارض يمنع العودة.",
      ],
      [
        "بيانات التواصل",
        `يمكن التواصل معي أثناء الإجازة على الرقم: ${data.employee?.phone ?? blank}.`,
      ],
      [
        "الاعتماد",
        "لا تُعدّ الإجازة سارية إلا بعد اعتمادها من المسؤول المباشر والموارد البشرية.",
      ],
    ]),
  ];
}

/* ── 9) طلب سلفة مالية ─────────────────────────────────────────── */

function advance(data) {
  const currency = currencyOf(data);
  const request = data.reference ?? {};
  const blank = "................................";
  const months = Math.max(1, Math.round(Number(request.installmentMonths ?? 1)));
  const installment =
    request.amount !== undefined ? Number(request.amount ?? 0) / months : null;

  return [
    pairs([
      ["تاريخ الطلب", request.requestDate ?? data.today],
      ...employeeRows(data),
      ["الراتب الأساسي", formatMoney(data.salary?.basicSalary ?? 0, currency)],
    ]),
    pairs([
      [
        "المبلغ المطلوب",
        request.amount !== undefined ? formatMoney(request.amount, currency) : blank,
      ],
      ["سبب الطلب", request.reason ?? blank],
      ["عدد أشهر التقسيط", `${months}`],
      [
        "قيمة القسط الشهري",
        installment === null ? blank : formatMoney(installment, currency),
      ],
      ["أول شهر خصم", request.deductionMonth ?? blank],
      ["الخصم من الراتب", request.deductFromPayroll === false ? "لا" : "نعم"],
      ["حالة الطلب", request.status ? label(request.status) : "قيد الدراسة"],
      ["ملاحظة القرار", request.decisionNote || "—"],
    ]),
    clauses([
      [
        "إقرار وتعهد",
        `أقر بأني تقدمت بطلب سلفة مالية بالمبلغ الموضح أعلاه، وأتعهد بسدادها بخصمها من راتبي على ${months} قسطاً شهرياً${
          request.deductionMonth ? ` بدءاً من شهر ${request.deductionMonth}` : ""
        } وفق ما تقره المنشأة.`,
      ],
      [
        "الاستحقاق الفوري",
        "في حال انتهاء علاقتي بالمنشأة قبل سداد كامل السلفة، تُخصم المتبقي منها من مستحقاتي النهائية.",
      ],
      [
        "الحد النظامي",
        "لا يُخصم من الأجر أكثر من الحد الذي تجيزه الأنظمة السارية شهرياً.",
      ],
    ]),
  ];
}

/* ── 10) نموذج أوفر تايم ───────────────────────────────────────── */

function overtime(data) {
  const currency = currencyOf(data);
  const request = data.reference ?? {};
  const hourly =
    data.salary?.basicSalary && data.salary?.contractHoursPerMonth
      ? data.salary.basicSalary / data.salary.contractHoursPerMonth
      : null;
  const multiplier = data.salary?.overtimeMultiplier ?? 1.5;
  const blank = "................................";

  return [
    pairs([
      ["تاريخ النموذج", data.today],
      ...employeeRows(data),
    ]),
    pairs([
      ["تاريخ العمل الإضافي", request.workDate ?? blank],
      ["عدد الساعات", request.hours !== undefined ? `${request.hours} ساعة` : blank],
      ["سبب العمل الإضافي", request.reason ?? blank],
      ["أجر الساعة الأساسي", hourly === null ? "—" : formatMoney(hourly, currency)],
      ["معامل ساعة الأوفرتايم", multiplier],
      [
        "القيمة التقديرية",
        hourly !== null && request.hours
          ? formatMoney(hourly * multiplier * request.hours, currency)
          : blank,
      ],
      ["حالة الطلب", request.status ? label(request.status) : "قيد الاعتماد"],
      ["ملاحظة القرار", request.decisionNote || "—"],
    ]),
    clauses([
      [
        "الإقرار",
        "أقر بأن ساعات العمل الإضافي المذكورة أعلاه أُديت فعلياً بناءً على طلب المسؤول المباشر ولمصلحة العمل.",
      ],
      [
        "الاعتماد المسبق",
        "لا تُحتسب ساعات العمل الإضافي ولا تُصرف قيمتها إلا إذا كانت باعتماد مسبق من المسؤول المباشر.",
      ],
      [
        "طريقة الصرف",
        "تُصرف قيمة العمل الإضافي مع راتب الشهر التالي أو تُعوَّض بأيام راحة وفق ما يُتفق عليه والأنظمة السارية.",
      ],
    ]),
  ];
}

/* ── 11) نموذج مكافأة ──────────────────────────────────────────── */

function bonus(data) {
  const currency = currencyOf(data);
  const record = data.reference ?? {};
  const blank = "................................";

  return [
    pairs([
      ["تاريخ النموذج", data.today],
      ...employeeRows(data),
    ]),
    pairs([
      [
        "مبلغ المكافأة",
        record.amount !== undefined ? formatMoney(record.amount, currency) : blank,
      ],
      ["تاريخ الاستحقاق", record.bonusDate ?? data.today],
      ["سبب المكافأة", record.reason ?? blank],
      ["حالة المكافأة", record.status ? label(record.status) : "معتمدة"],
    ]),
    section("قرار المكافأة", [
      `تقديراً للجهود المبذولة والأداء المتميّز، تقرر منح ${
        data.employee?.fullName ?? ""
      } مكافأة مالية بالمبلغ الموضح أعلاه، تُصرف مع راتب الشهر الذي يقرره القسم المالي.`,
    ]),
    clauses([
      [
        "طبيعة المكافأة",
        "هذه المكافأة تقديرية غير دورية، ولا تُعدّ جزءاً من الأجر الأساسي، ولا يترتب على صرفها استحقاق مكافآت مماثلة مستقبلاً.",
      ],
      [
        "الاستقطاعات",
        "تخضع المكافأة لما يترتب عليها نظاماً من استقطاعات إن وُجدت.",
      ],
    ]),
  ];
}

/* ── 12) كشف حضور شهري للتوقيع اليدوي ──────────────────────────── */

function attendanceSheet(data) {
  const sheet = data.attendanceSheet;
  const rows = (sheet?.days ?? []).map((day) => ({
    className: day.isOffDay ? "is-off" : "",
    cells: [
      day.date.slice(8),
      WEEKDAYS[day.weekday] ?? "",
      day.checkIn ?? (day.isOffDay ? "راحة" : ""),
      day.checkOut ?? "",
      day.hours ? day.hours.toFixed(2) : "",
      "",
      "",
    ],
  }));

  const nodes = [
    pairs([
      ["الشهر", sheet?.month ?? data.month],
      ...employeeRows(data),
      ["المنطقة الزمنية", data.timezone],
    ]),
    table(
      ["التاريخ", "اليوم", "الحضور", "الانصراف", "الساعات", "توقيع الموظف", "ملاحظات"],
      rows,
      "sheet__table sheet__attend",
    ),
    pairs([
      ["إجمالي الساعات المسجّلة", `${sheet?.totalHours ?? 0} ساعة`],
      ["عدد أيام الحضور", sheet?.workedDays ?? 0],
      ["أيام الراحة المستحقة", restDaysText(data.schedule)],
    ]),
    note(
      "الأوقات مأخوذة من سجلات النظام بتوقيت الفرع (وقت الخادم). يُوقّع الموظف أمام كل يوم، " +
        "وأي تعديل يدوي على الكشف يجب أن يوثَّق في النظام أيضاً.",
    ),
  ];

  return nodes.filter(Boolean);
}

/* ── 13) ملف تحضير و الانصراف (كل الموظفين) ────────────────────── */

function rosterSheet(data) {
  const sheet = data.rosterSheet;
  const rows = (sheet?.rows ?? []).map((line, index) => ({
    cells: [
      String(index + 1),
      line.employeeCode,
      line.fullName,
      line.nationalId || "",
      // خانات تُعبّأ باليد: الحضور والتوقيع، الانصراف والتوقيع، الملاحظات
      "",
      "",
      "",
      "",
      "",
    ],
  }));

  const nodes = [
    pairs([
      ["التاريخ", formatDate(sheet?.date ?? data.today)],
      ["الفرع", sheet?.branch?.name ?? "كل الفروع"],
      ["عدد الموظفين", rows.length],
      ["المنطقة الزمنية", data.timezone],
    ]),
    table(
      [
        "م",
        "الرقم الوظيفي",
        "الاسم",
        "الإقامة",
        "وقت الحضور",
        "توقيع الحضور",
        "وقت الانصراف",
        "توقيع الانصراف",
        "ملاحظات",
      ],
      rows,
      "sheet__table sheet__roster",
    ),
    note(
      "يُعبَّأ هذا الكشف باليد في الفرع: يكتب الموظف وقت حضوره ويوقّع، ثم وقت انصرافه ويوقّع. " +
        "الكشف الورقي مرجع مساند فقط؛ الوقت الرسمي هو المسجَّل في النظام.",
    ),
  ];

  return nodes.filter(Boolean);
}

/* ── 14) تقفيل الكاشير (يوم واحد / كشف فترة) ────────────────────── */

const LINE_CATEGORY_LABELS = {
  network: "الشبكة",
  delivery_app: "تطبيقات التواصل",
};

/** بنود تصنيف واحد داخل مطبوعة التقفيل. */
function closingLinesTable(lines, category, currency) {
  const own = lines.filter((line) => line.category === category);
  if (own.length === 0) return null;

  const title = LINE_CATEGORY_LABELS[category] ?? category;
  const total = own.reduce((sum, line) => sum + Number(line.amount ?? 0), 0);
  const rows = own.map((line) => [
    line.label,
    line.reference || "",
    formatMoney(line.amount, currency),
  ]);
  rows.push([`إجمالي ${title}`, "", formatMoney(total, currency)]);

  return table([title, "المرجع", "المبلغ"], rows);
}

const SHIFT_LABELS = { morning: "صباحية", evening: "مسائية", full: "كامل اليوم" };

function cashierClosing(data) {
  const closing = data.cashier?.closings?.[0] ?? {};
  const currency = data.company?.currency || "SAR";
  const lines = closing.lines ?? [];

  const nodes = [
    pairs([
      ["تاريخ العمل", formatDate(closing.businessDate)],
      ["الوردية", SHIFT_LABELS[closing.shift] ?? closing.shift],
      ["الفرع", closing.branchName],
      ["الكاشير", `${closing.employeeCode ?? ""} ${closing.employeeName ?? ""}`.trim()],
      ["الحالة", label(closing.status)],
      ["عدد الفواتير", closing.invoiceCount],
    ]),
    pairs([
      ["عهدة بداية الوردية", formatMoney(closing.openingFloat ?? 0, currency)],
      ["إجمالي المبيعات", formatMoney(closing.totalSales ?? 0, currency)],
      ["مبيعات نقدية", formatMoney(closing.cashSales ?? 0, currency)],
      ["مبيعات شبكة (الإجمالي)", formatMoney(closing.cardSales ?? 0, currency)],
      ["شبكة foodics", formatMoney(closing.foodicsSales ?? 0, currency)],
      ["تحويلات", formatMoney(closing.transferSales ?? 0, currency)],
      ["تطبيقات التواصل (الإجمالي)", formatMoney(closing.deliverySales ?? 0, currency)],
      ["مبيعات أخرى", formatMoney(closing.otherSales ?? 0, currency)],
      ["الخصومات", formatMoney(closing.discounts ?? 0, currency)],
      ["المرتجعات", formatMoney(closing.refunds ?? 0, currency)],
      ["مصروفات نقدية", formatMoney(closing.expenses ?? 0, currency)],
      ["النقد المتوقّع في الدرج", formatMoney(closing.expectedCash ?? 0, currency)],
      ["النقد المعدود", formatMoney(closing.countedCash ?? 0, currency)],
      ["الفارق", formatMoney(closing.difference ?? 0, currency)],
    ]),
    closingLinesTable(lines, "network", currency),
    closingLinesTable(lines, "delivery_app", currency),
    closing.notes ? note(`ملاحظات الكاشير: ${closing.notes}`) : null,
    closing.reviewNote ? note(`ملاحظة المراجعة: ${closing.reviewNote}`) : null,
    note(
      "الفارق = النقد المعدود − النقد المتوقّع (سالب = عجز). إجمالي الشبكة يشمل شبكة foodics " +
        "وبنود الشبكة المُضافة، وإجمالي التوصيل هو مجموع بنود تطبيقات التواصل.",
    ),
  ];

  return nodes.filter(Boolean);
}

function cashierClosingsRange(data) {
  const payload = data.cashier ?? {};
  const currency = data.company?.currency || "SAR";
  const closings = payload.closings ?? [];
  const totals = payload.totals ?? {};

  const rows = closings.map((closing) => [
    closing.businessDate,
    closing.branchName ?? "",
    `${closing.employeeCode ?? ""} ${closing.employeeName ?? ""}`.trim(),
    SHIFT_LABELS[closing.shift] ?? closing.shift,
    formatMoney(closing.totalSales ?? 0, currency),
    formatMoney(closing.cashSales ?? 0, currency),
    formatMoney(closing.cardSales ?? 0, currency),
    formatMoney(closing.foodicsSales ?? 0, currency),
    formatMoney(closing.deliverySales ?? 0, currency),
    formatMoney(closing.difference ?? 0, currency),
    label(closing.status),
  ]);

  // مجموع بنود التطبيقات والشبكات على كل تقفيلات الفترة
  const lineTotals = new Map();
  for (const closing of closings) {
    for (const line of closing.lines ?? []) {
      const key = `${line.category}|${line.label}`;
      lineTotals.set(key, (lineTotals.get(key) ?? 0) + Number(line.amount ?? 0));
    }
  }

  const lineRows = [...lineTotals.entries()].map(([key, amount]) => {
    const [category, name] = key.split("|");
    return [LINE_CATEGORY_LABELS[category] ?? category, name, formatMoney(amount, currency)];
  });

  const nodes = [
    pairs([
      ["من تاريخ", formatDate(payload.from)],
      ["إلى تاريخ", formatDate(payload.to)],
      ["الفرع", payload.branch?.name ?? "كل الفروع"],
      ["عدد التقفيلات", totals.count ?? closings.length],
    ]),
    table(
      [
        "التاريخ",
        "الفرع",
        "الكاشير",
        "الوردية",
        "الإجمالي",
        "نقدي",
        "شبكة",
        "foodics",
        "تطبيقات",
        "الفارق",
        "الحالة",
      ],
      rows,
    ),
    pairs([
      ["إجمالي المبيعات", formatMoney(totals.totalSales ?? 0, currency)],
      ["المبيعات النقدية", formatMoney(totals.cashSales ?? 0, currency)],
      ["مبيعات الشبكة", formatMoney(totals.cardSales ?? 0, currency)],
      ["شبكة foodics", formatMoney(totals.foodicsSales ?? 0, currency)],
      ["تطبيقات التواصل", formatMoney(totals.deliverySales ?? 0, currency)],
      ["التحويلات", formatMoney(totals.transferSales ?? 0, currency)],
      ["المصروفات النقدية", formatMoney(totals.expenses ?? 0, currency)],
      ["صافي الفروقات", formatMoney(totals.difference ?? 0, currency)],
      ["عدد الفواتير", totals.invoiceCount ?? 0],
    ]),
    lineRows.length > 0
      ? table(["التصنيف", "البند", "إجمالي الفترة"], lineRows)
      : null,
    closings.length === 0 ? note("لا توجد تقفيلات مرفوعة في هذه الفترة.") : null,
  ];

  return nodes.filter(Boolean);
}

/* ── الدليل ────────────────────────────────────────────────────── */

export const TEMPLATES = {
  contract: {
    signatures: ["الطرف الأول (المنشأة)", "الطرف الثاني (الموظف)", "شاهد"],
    render: contract,
  },
  nda: {
    signatures: ["الطرف المفصح (المنشأة)", "الطرف المتلقّي (الموظف)"],
    render: nda,
  },
  appointment: {
    signatures: ["الموظف", "مدير الفرع", "الموارد البشرية"],
    render: appointment,
  },
  warning: {
    signatures: ["الموظف (إقرار بالاستلام)", "المسؤول المباشر", "الموارد البشرية"],
    render: warning,
  },
  salary_receipt: {
    signatures: ["الموظف (المستلم)", "القسم المالي", "الموارد البشرية"],
    render: salaryReceipt,
  },
  receipt_voucher: {
    signatures: ["المستلم", "أمين الصندوق", "الاعتماد"],
    render: (data) => voucher(data, true),
  },
  payment_voucher: {
    signatures: ["المستفيد", "أمين الصندوق", "الاعتماد"],
    render: (data) => voucher(data, false),
  },
  custody: {
    signatures: ["الموظف (المستلم)", "المسلِّم", "مدير الفرع"],
    render: custody,
  },
  leave: {
    signatures: ["الموظف", "المسؤول المباشر", "الموارد البشرية"],
    render: leave,
  },
  advance: {
    signatures: ["الموظف", "المسؤول المباشر", "القسم المالي"],
    render: advance,
  },
  overtime: {
    signatures: ["الموظف", "المسؤول المباشر", "الموارد البشرية"],
    render: overtime,
  },
  bonus: {
    signatures: ["الموظف", "مدير الفرع", "الإدارة"],
    render: bonus,
  },
  attendance_sheet: {
    signatures: ["الموظف", "مدير الفرع", "الموارد البشرية"],
    render: attendanceSheet,
  },
  attendance_roster_sheet: {
    signatures: ["مسؤول التحضير", "مدير الفرع", "الموارد البشرية"],
    render: rosterSheet,
  },
  cashier_closing: {
    signatures: ["الكاشير", "مدير الفرع", "المراجعة المالية"],
    render: cashierClosing,
  },
  cashier_closings_range: {
    signatures: ["مُعِدّ الكشف", "مدير الفرع", "المراجعة المالية"],
    render: cashierClosingsRange,
  },
};
