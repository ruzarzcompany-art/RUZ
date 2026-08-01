/**
 * حركات المخزون كخيار واحد: النوع وسببه معاً.
 *
 * الشاشتان (لوحة التحكم وتطبيق الموظف) كانتا تعرضان حقلين مكدّسين — «نوع
 * الحركة» و«السبب» — فيختار المستخدم النوع ثم يعود ليختار سبباً يوافقه.
 * هذا الملف يجمع التوليفات المقبولة في قائمة واحدة، فيصبح الاختيار سطراً
 * واحداً ويُستنتج السبب من الخيار نفسه بلا حقل ثانٍ.
 *
 * التوليفات هي مصدر واحد للشاشتين كي لا تفترقا، والقيمتان المرسلتان إلى
 * الخادم (`movementType` و`reason`) تبقيان كما هما فلا تغيير في المسار ولا
 * في البيانات المحفوظة.
 */

/** فاصل القيمة المركّبة: `in:purchase`. */
const SEPARATOR = ":";

/**
 * التوليفات المعروضة، مرتّبة كما تُقرأ في القائمة. المجموعة (`group`) تُصبح
 * عنواناً داخل القائمة فيسهل الوصول إلى الإخراج دون قراءة كل السطور.
 */
const MOVEMENT_ACTIONS = [
  { movementType: "in", reason: "purchase", group: "إدخال", label: "شراء (فاتورة)" },
  { movementType: "in", reason: "transfer", group: "إدخال", label: "تحويل من فرع آخر" },
  { movementType: "in", reason: "other", group: "إدخال", label: "إدخال لسبب آخر" },
  { movementType: "out", reason: "consumption", group: "إخراج", label: "استهلاك" },
  { movementType: "out", reason: "waste", group: "إخراج", label: "هدر / تالف" },
  { movementType: "out", reason: "transfer", group: "إخراج", label: "تحويل إلى فرع آخر" },
  { movementType: "out", reason: "other", group: "إخراج", label: "إخراج لسبب آخر" },
  { movementType: "count", reason: "stocktake", group: "جرد", label: "إثبات الكمية المعدودة" },
  { movementType: "manufacture", reason: "manufacture", group: "تصنيع", label: "تحويل خام إلى منتج" },
].map((action) => ({ ...action, value: `${action.movementType}${SEPARATOR}${action.reason}` }));

/** الخيار الافتراضي: شراء، وهو أكثر ما يُسجَّل. */
const DEFAULT_ACTION = MOVEMENT_ACTIONS[0];

/**
 * القيمتان المرسلتان إلى الخادم من الخيار المختار. القيمة غير المعروفة تُقرأ
 * على الافتراضي بدل أن تُرسل حركة بلا نوع.
 */
export function parseAction(value) {
  const action = MOVEMENT_ACTIONS.find((item) => item.value === value) ?? DEFAULT_ACTION;
  return { movementType: action.movementType, reason: action.reason };
}

/**
 * يبني القائمة الواحدة بمجموعاتها، ويُبقي اختيار المستخدم إن كان ما زال
 * موجوداً وإلا يعود إلى الافتراضي.
 */
export function fillActionPicker(select) {
  if (!select) return DEFAULT_ACTION.value;

  const previous = select.value;
  select.textContent = "";

  let group = null;
  let holder = null;
  for (const action of MOVEMENT_ACTIONS) {
    if (action.group !== group) {
      group = action.group;
      holder = document.createElement("optgroup");
      holder.label = group;
      select.append(holder);
    }

    const option = document.createElement("option");
    option.value = action.value;
    option.textContent = action.label;
    holder.append(option);
  }

  const known = MOVEMENT_ACTIONS.some((action) => action.value === previous);
  select.value = known ? previous : DEFAULT_ACTION.value;
  return select.value;
}
