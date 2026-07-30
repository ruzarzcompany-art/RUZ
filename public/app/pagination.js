/**
 * تقسيم الصفحات المشترك لجداول التطبيق.
 *
 * كل جدول يبقى كما هو — نفس الأعمدة ونفس الصفوف ونفس الأزرار — وهذه الوحدة
 * تكتفي بعرض شريحة من الصفوف وتضيف شريط تنقّل أسفل الجدول: أرقام الصفحات مع
 * «السابق/التالي»، قائمة اختيار عدد الصفوف، ونص المدى المعروض.
 *
 * الشريط يُبنى مرة واحدة بعد `.table-wrap` الخاص بالجدول (بلا لمس الـHTML)،
 * ويُعاد رسمه مع كل تحديث للبيانات. لأن كل بحث أو فلترة تُنتج نداء عرض جديداً،
 * فإن `render` يعود إلى الصفحة الأولى افتراضياً — وهو المطلوب حتى لا يجد
 * المستخدم نفسه في صفحة رقم 4 من نتيجة صفحة واحدة.
 */

/** الخيارات المتاحة في قائمة «صفوف الصفحة». */
export const PAGE_SIZE_OPTIONS = [5, 10, 25];

/** عدد الصفوف الافتراضي في كل صفحة — موحَّد لكل جداول التطبيق بلا استثناء. */
export const DEFAULT_PAGE_SIZE = 5;

function pageCount(total, size) {
  return Math.max(1, Math.ceil(total / size));
}

/**
 * أرقام الصفحات المعروضة: كلها إن كانت قليلة، وإلا الأولى والأخيرة ومحيط
 * الصفحة الحالية مع «…» في الفجوات حتى لا يطول الشريط بلا حد.
 */
function pageWindow(current, last) {
  if (last <= 7) return Array.from({ length: last }, (_, index) => index + 1);

  const wanted = new Set([1, last, current]);
  for (const page of [current - 1, current + 1]) {
    if (page >= 1 && page <= last) wanted.add(page);
  }

  const out = [];
  let previous = 0;
  for (const page of [...wanted].sort((a, b) => a - b)) {
    if (previous && page - previous > 1) out.push("…");
    out.push(page);
    previous = page;
  }
  return out;
}

/**
 * يُنشئ مُقسِّم صفحات لجدول واحد.
 *
 * @param {string} tableId معرّف عنصر `<table>`
 * @param {{unit?: string, pageSize?: number, sizes?: number[]}} [options]
 *   `unit` كلمة العدّ في نص المدى («صنف»، «حركة»...). عدد الصفوف الافتراضي
 *   يأتي من `DEFAULT_PAGE_SIZE` ولا يُمرَّر جدولاً جدولاً، حتى تبقى القيمة
 *   موحَّدة في كل الشاشات ويكفي تغييرها من مكان واحد.
 */
export function createPager(tableId, options = {}) {
  const {
    unit = "صف",
    pageSize = DEFAULT_PAGE_SIZE,
    sizes = PAGE_SIZE_OPTIONS,
  } = options;

  const state = {
    page: 1,
    size: sizes.includes(pageSize) ? pageSize : DEFAULT_PAGE_SIZE,
    items: [],
    renderRow: null,
    bar: null,
    range: null,
    numbers: null,
    previous: null,
    next: null,
  };

  const table = () => document.getElementById(tableId);

  function navButton(text, step) {
    const node = document.createElement("button");
    node.type = "button";
    node.className = "btn btn--ghost btn--xs pager__nav";
    node.textContent = text;
    node.addEventListener("click", () => {
      state.page += step;
      draw();
    });
    return node;
  }

  /** يبني الشريط عند أول رسم، أو يعيد بناءه إن أُزيل من الصفحة. */
  function ensureBar() {
    if (state.bar?.isConnected) return state.bar;

    const node = table();
    if (!node) return null;

    const bar = document.createElement("div");
    bar.className = "pager";
    bar.dataset.for = tableId;
    bar.hidden = true;

    const range = document.createElement("span");
    range.className = "pager__range";
    range.setAttribute("role", "status");

    const pages = document.createElement("div");
    pages.className = "pager__pages";
    const previous = navButton("السابق", -1);
    const numbers = document.createElement("span");
    numbers.className = "pager__numbers";
    const next = navButton("التالي", 1);
    pages.append(previous, numbers, next);

    const size = document.createElement("label");
    size.className = "pager__size";
    const sizeLabel = document.createElement("span");
    sizeLabel.textContent = "صفوف الصفحة";
    const select = document.createElement("select");
    select.className = "pager__select";
    for (const value of sizes) {
      const option = document.createElement("option");
      option.value = String(value);
      option.textContent = String(value);
      select.append(option);
    }
    select.value = String(state.size);
    select.addEventListener("change", () => {
      state.size = Number(select.value) || DEFAULT_PAGE_SIZE;
      // تغيير حجم الصفحة يُعيد القراءة من أولها حتى لا يقع المستخدم في فراغ
      state.page = 1;
      draw();
    });
    size.append(sizeLabel, select);

    bar.append(range, pages, size);
    (node.closest(".table-wrap") ?? node).insertAdjacentElement("afterend", bar);

    Object.assign(state, { bar, range, numbers, previous, next, select });
    return bar;
  }

  function paintBar(total, last, start, shown) {
    const bar = ensureBar();
    if (!bar) return;

    // لا معنى لشريط تنقّل أمام جدول فارغ — رسالة «لا توجد بيانات» تكفي
    bar.hidden = total === 0;
    if (total === 0) return;

    const from = start + 1;
    const to = start + shown;
    state.range.textContent = `عرض ${from}–${to} من ${total} ${unit}`;

    state.previous.disabled = state.page <= 1;
    state.next.disabled = state.page >= last;

    state.numbers.textContent = "";
    for (const entry of pageWindow(state.page, last)) {
      if (entry === "…") {
        const gap = document.createElement("span");
        gap.className = "pager__gap";
        gap.textContent = "…";
        state.numbers.append(gap);
        continue;
      }

      const node = document.createElement("button");
      node.type = "button";
      node.className = "btn btn--ghost btn--xs pager__page";
      node.textContent = String(entry);
      node.setAttribute("aria-label", `صفحة ${entry}`);
      if (entry === state.page) {
        node.classList.add("is-active");
        node.setAttribute("aria-current", "page");
      }
      node.addEventListener("click", () => {
        state.page = entry;
        draw();
      });
      state.numbers.append(node);
    }

    if (state.select) state.select.value = String(state.size);
  }

  /** يرسم صفوف الصفحة الحالية داخل `tbody` ثم يحدّث الشريط. */
  function draw() {
    const node = table();
    const body = node?.querySelector("tbody");
    if (!body) return;

    const total = state.items.length;
    const last = pageCount(total, state.size);
    state.page = Math.min(Math.max(1, state.page), last);

    const start = (state.page - 1) * state.size;
    const slice = state.items.slice(start, start + state.size);

    body.textContent = "";
    slice.forEach((item, index) => {
      const rendered = state.renderRow?.(item, start + index);
      for (const one of Array.isArray(rendered) ? rendered : [rendered]) {
        if (one) body.append(one);
      }
    });

    paintBar(total, last, start, slice.length);
  }

  return {
    /**
     * يعرض قائمة صفوف. `renderRow(item, index)` يُعيد `<tr>` أو مصفوفة صفوف
     * (للجداول التي يسبق كل مجموعة فيها صف عنوان).
     *
     * `page`: `"first"` (الافتراضي، وهو سلوك البحث والفلترة) أو `"last"`
     * لإظهار آخر صفحة — يفيد بعد إضافة سطر جديد — أو `"keep"` للبقاء مكانك.
     */
    render(items, renderRow, { page = "first" } = {}) {
      state.items = Array.isArray(items) ? items : [];
      if (renderRow) state.renderRow = renderRow;
      if (page === "first") state.page = 1;
      else if (page === "last") state.page = pageCount(state.items.length, state.size);
      draw();
    },

    /** يُفرِّغ الجدول ويُخفي الشريط (مسارات الخطأ أو انعدام الصلاحية). */
    clear() {
      state.items = [];
      state.page = 1;
      draw();
    },

    /** الصفحة المعروضة حالياً (للاختبار والتشخيص). */
    get page() {
      return state.page;
    },

    /** عدد الصفوف في الصفحة كما اختاره المستخدم. */
    get size() {
      return state.size;
    },
  };
}
