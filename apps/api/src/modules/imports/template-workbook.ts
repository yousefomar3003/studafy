/**
 * The Excel template a school fills in to import its students and their parents (the "Import data"
 * step, docs/modules/student-import-mapping-guide.md "Excel template").
 *
 * One workbook, in the admin's language:
 *   - "Students" / "الطلاب": one header row, then nothing -- examples live on the instructions sheet,
 *     so a forgotten example row is never imported. Headers are spellings the import recognises
 *     (packages/student-import/src/fields.ts aliases, or a record field's label), so the upload maps
 *     itself. Required columns are highlighted (a parent's phone is required for every parent the row
 *     names); every column carries a note saying what goes in it.
 *     Dropdowns offer the status and relationship words, and the school's own grades and sections of
 *     the current academic year. ID-like and date columns are text, so Excel keeps leading zeros and
 *     never turns 2016-03-15 into a serial number.
 *   - "Instructions" / "التعليمات": how to fill it in.
 *   - "Example" / "مثال": a worked example of two families, never imported.
 *   - "Lists": the dropdown values, hidden.
 *
 * The school's published student record fields are extra columns after the fixed ones (document
 * fields excepted: their files are uploaded on the Records tab). Nothing about any person is in the
 * file: only the school's grade, section and field names.
 *
 * exceljs is loaded on first use, so it costs the API nothing until someone downloads a template.
 */

import { PARENT_RELATIONSHIPS, STUDENT_STATUSES } from "@studafy/student-import";

import type { ImportRecordField, StudentImportField } from "@studafy/student-import";
import type { TransactionSql } from "postgres";

export type TemplateLanguage = "en" | "ar";

/** Rows the dropdowns and formats cover: the import's 10,000-row cap plus the header. */
const LAST_ROW = 10_001;

interface TemplateColumn {
  field: StudentImportField;
  /** Highlighted header. For a parent's phone: required whenever that parent is given. */
  required?: boolean;
  /** Text format: keeps leading zeros, and stops Excel turning dates into serial numbers. */
  text?: boolean;
  width: number;
}

const COLUMNS: readonly TemplateColumn[] = [
  { field: "admission_number", required: true, text: true, width: 16 },
  { field: "first_name", required: true, width: 16 },
  { field: "middle_name", width: 16 },
  { field: "last_name", required: true, width: 16 },
  { field: "date_of_birth", text: true, width: 14 },
  { field: "status", width: 12 },
  { field: "grade", width: 14 },
  { field: "section", width: 10 },
  { field: "family", text: true, width: 12 },
  { field: "parent_name", width: 22 },
  { field: "parent_relationship", width: 14 },
  { field: "parent_phone", required: true, text: true, width: 18 },
  { field: "parent_email", width: 24 },
  { field: "parent2_name", width: 22 },
  { field: "parent2_relationship", width: 14 },
  { field: "parent2_phone", required: true, text: true, width: 18 },
  { field: "parent2_email", width: 24 },
  { field: "email", width: 24 },
  { field: "preferred_name", width: 16 },
];

/** Header text per language. Each is the field's own name or one of its recognised aliases. */
const HEADERS: Readonly<Record<TemplateLanguage, Readonly<Record<StudentImportField, string>>>> = {
  en: {
    admission_number: "Student number",
    first_name: "First name",
    middle_name: "Middle name",
    last_name: "Last name",
    date_of_birth: "Date of birth",
    status: "Status",
    grade: "Grade",
    section: "Section",
    family: "Family number",
    parent_name: "Parent 1 name",
    parent_relationship: "Parent 1 relationship",
    parent_phone: "Parent 1 phone",
    parent_email: "Parent 1 email",
    parent2_name: "Parent 2 name",
    parent2_relationship: "Parent 2 relationship",
    parent2_phone: "Parent 2 phone",
    parent2_email: "Parent 2 email",
    email: "Student email",
    preferred_name: "Preferred name",
  },
  ar: {
    admission_number: "رقم الطالب",
    first_name: "الاسم الأول",
    middle_name: "الاسم الأوسط",
    last_name: "اسم العائلة",
    date_of_birth: "تاريخ الميلاد",
    status: "الحالة",
    grade: "الصف",
    section: "الشعبة",
    family: "رقم العائلة",
    parent_name: "اسم ولي الأمر 1",
    parent_relationship: "صلة القرابة 1",
    parent_phone: "هاتف ولي الأمر 1",
    parent_email: "بريد ولي الأمر 1",
    parent2_name: "اسم ولي الأمر 2",
    parent2_relationship: "صلة القرابة 2",
    parent2_phone: "هاتف ولي الأمر 2",
    parent2_email: "بريد ولي الأمر 2",
    email: "بريد الطالب",
    preferred_name: "الاسم المفضل",
  },
};

const NOTES: Readonly<Record<TemplateLanguage, Partial<Record<StudentImportField, string>>>> = {
  en: {
    admission_number: "Required. Your school's own number for the student.",
    first_name: "Required.",
    last_name: "Required.",
    date_of_birth: "Year-month-day, for example 2016-03-15.",
    status: "Pick from the list. Blank means applicant.",
    grade: "Pick from the list. The student is placed in this grade's section.",
    section:
      "Pick from the list. Leave blank if the grade has only one section. Unknown names are " +
      "reported, never created.",
    family:
      "Any number you choose. Brothers and sisters get the same family number, so you type " +
      "their parents once, on one of their rows.",
    parent_name: "Give a name or an email (or both), the relationship and a phone number.",
    parent_relationship: "Pick from the list.",
    parent_phone:
      "Required for every parent you type, for example +965 5000 1234. Leave it blank on a " +
      "brother's or sister's row that leaves the parent blank.",
    parent_email: "Optional. Parents without an email sign in with the ID Studafy gives them.",
    parent2_relationship: "Pick from the list.",
    parent2_phone: "Required when you type a second parent.",
    parent2_email: "Optional.",
    email: "Optional. Students without an email sign in with the ID Studafy gives them.",
  },
  ar: {
    admission_number: "مطلوب. رقم الطالب الخاص بمدرستك.",
    first_name: "مطلوب.",
    last_name: "مطلوب.",
    date_of_birth: "سنة-شهر-يوم، مثل 2016-03-15.",
    status: "اختر من القائمة. الفارغ يعني متقدم.",
    grade: "اختر من القائمة. يوضع الطالب في شعبة هذا الصف.",
    section:
      "اختر من القائمة. اتركها فارغة إذا كان للصف شعبة واحدة. الأسماء غير الموجودة يُبلّغ عنها ولا تُنشأ.",
    family:
      "أي رقم تختاره. الإخوة والأخوات يأخذون رقم العائلة نفسه، فتكتب أولياء أمورهم مرة واحدة في أحد صفوفهم.",
    parent_name: "اكتب الاسم أو البريد (أو كليهما)، وصلة القرابة ورقم الهاتف.",
    parent_relationship: "اختر من القائمة.",
    parent_phone:
      "مطلوب لكل ولي أمر تكتبه، مثل ‎+965 5000 1234. اتركه فارغًا في صف الأخ أو الأخت الذي تُترك فيه أعمدة ولي الأمر فارغة.",
    parent_email:
      "اختياري. ولي الأمر الذي ليس لديه بريد يسجّل الدخول بالرقم الذي يعطيه له Studafy.",
    parent2_relationship: "اختر من القائمة.",
    parent2_phone: "مطلوب عند كتابة ولي أمر ثانٍ.",
    parent2_email: "اختياري.",
    email: "اختياري. الطالب الذي ليس لديه بريد يسجّل الدخول بالرقم الذي يعطيه له Studafy.",
  },
};

/** Dropdown words. The Arabic ones are read back as these values by the import (record.ts). */
const STATUS_WORDS: Readonly<Record<TemplateLanguage, readonly string[]>> = {
  en: STUDENT_STATUSES,
  ar: ["منتظم", "متقدم", "موقوف", "متخرج", "منسحب", "مؤرشف"],
};

const RELATIONSHIP_WORDS: Readonly<Record<TemplateLanguage, readonly string[]>> = {
  en: PARENT_RELATIONSHIPS,
  ar: ["أم", "أب", "وصي", "زوج الأم", "زوجة الأب", "جد", "جدة", "أخ", "أخت", "أخرى"],
};

const SHEET_NAMES: Readonly<
  Record<
    TemplateLanguage,
    { students: string; instructions: string; example: string; lists: string }
  >
> = {
  en: { students: "Students", instructions: "Instructions", example: "Example", lists: "Lists" },
  ar: { students: "الطلاب", instructions: "التعليمات", example: "مثال", lists: "Lists" },
};

const INSTRUCTIONS: Readonly<Record<TemplateLanguage, readonly string[]>> = {
  en: [
    "How to import your students and their parents",
    "",
    "1. Fill in the Students sheet: one row per student. Keep the header row as it is.",
    "2. Student number, First name and Last name are required, and every parent you type needs a",
    "   phone number. Nobody needs an email.",
    "3. Give brothers and sisters the same Family number. Type their parents on one of their rows;",
    "   the other rows can leave the parent columns blank and still get the same parents.",
    "4. Grade and Section put the student in their class. Pick them from the lists.",
    "5. Save the file and upload it on the Import data page. You will see a preview before anything",
    "   is saved, and you can fix the file and upload it again as many times as you like.",
    "",
    "After the import, every student and parent has a Studafy ID (STU-… and PAR-…). Print their",
    "login slips from the import page: each slip has the ID and a one-time code. They sign in with",
    "them and choose their own password.",
    "",
    "The Example sheet shows two Hassan children and one Khaled child. It is never imported.",
  ],
  ar: [
    "كيف تستورد طلابك وأولياء أمورهم",
    "",
    "1. املأ ورقة الطلاب: صف واحد لكل طالب. اترك صف العناوين كما هو.",
    "2. المطلوب رقم الطالب والاسم الأول واسم العائلة، ورقم هاتف لكل ولي أمر تكتبه.",
    "   لا يحتاج أحد إلى بريد إلكتروني.",
    "3. أعطِ الإخوة والأخوات رقم العائلة نفسه. اكتب أولياء أمورهم في أحد صفوفهم،",
    "   ويمكن ترك أعمدة أولياء الأمور فارغة في الصفوف الأخرى وسيحصلون على أولياء الأمور أنفسهم.",
    "4. الصف والشعبة يضعان الطالب في فصله. اخترهما من القوائم.",
    "5. احفظ الملف وارفعه في صفحة استيراد البيانات. سترى معاينة قبل حفظ أي شيء،",
    "   ويمكنك تصحيح الملف ورفعه مرة أخرى كلما أردت.",
    "",
    "بعد الاستيراد يحصل كل طالب وولي أمر على رقم في Studafy (STU-… و PAR-…). اطبع بطاقات",
    "الدخول من صفحة الاستيراد: في كل بطاقة الرقم ورمز يُستخدم مرة واحدة. يسجّلون الدخول بهما",
    "ويختارون كلمة المرور الخاصة بهم.",
    "",
    "ورقة المثال تعرض طفلين من عائلة حسن وطفلًا من عائلة خالد. لا تُستورد أبدًا.",
  ],
};

const EXAMPLE_ROWS: Readonly<Record<TemplateLanguage, readonly (readonly string[])[]>> = {
  en: [
    ["ADM-001", "Ali", "Omar", "Hassan", "2016-03-15", "enrolled", "Grade 1", "A", "1"],
    ["ADM-002", "Sara", "Omar", "Hassan", "2018-09-02", "enrolled", "Grade 1", "B", "1"],
    ["ADM-003", "Lina", "", "Khaled", "2015-11-20", "enrolled", "Grade 2", "A", "2"],
  ],
  ar: [
    ["ADM-001", "علي", "عمر", "حسن", "2016-03-15", "منتظم", "الصف الأول", "أ", "1"],
    ["ADM-002", "سارة", "عمر", "حسن", "2018-09-02", "منتظم", "الصف الأول", "ب", "1"],
    ["ADM-003", "لينا", "", "خالد", "2015-11-20", "منتظم", "الصف الثاني", "أ", "2"],
  ],
};

const EXAMPLE_PARENTS: Readonly<Record<TemplateLanguage, readonly (readonly string[])[]>> = {
  en: [
    ["Mona Hassan", "mother", "+965 5000 1234", "", "Omar Hassan", "father", "+965 5000 5678", ""],
    ["", "", "", "", "", "", "", ""],
    ["Rana Khaled", "mother", "+965 5000 9012", "rana@example.com", "", "", "", ""],
  ],
  ar: [
    ["منى حسن", "أم", "+965 5000 1234", "", "عمر حسن", "أب", "+965 5000 5678", ""],
    ["", "", "", "", "", "", "", ""],
    ["رنا خالد", "أم", "+965 5000 9012", "rana@example.com", "", "", "", ""],
  ],
};

/** The school's grades and sections in the academic year the import places students into. */
async function loadGradesAndSections(
  tx: TransactionSql,
  schoolId: string,
): Promise<{ grades: string[]; sections: string[] }> {
  // The same year the import plan places into (packages/student-import/src/plan.ts loadPlacement).
  const rows = await tx<{ grade: string; section: string }[]>`
    WITH year AS (
      SELECT id FROM app.academic_years
      WHERE school_id = ${schoolId}::uuid AND status IN ('active', 'planned')
      ORDER BY (status = 'active') DESC,
               (CURRENT_DATE BETWEEN starts_on AND ends_on) DESC,
               starts_on ASC
      LIMIT 1
    )
    SELECT g.name AS grade, s.name AS section
    FROM app.sections AS s
    JOIN year ON year.id = s.academic_year_id
    JOIN app.grade_levels AS g ON g.id = s.grade_level_id AND g.school_id = s.school_id
    WHERE s.school_id = ${schoolId}::uuid
    ORDER BY g.sort_order, g.name, s.name
  `;
  return {
    grades: [...new Set(rows.map((row) => row.grade))],
    sections: [...new Set(rows.map((row) => row.section))],
  };
}

/** A1-style column letters for a 1-based column number. */
function columnLetter(column: number): string {
  let letters = "";
  for (let n = column; n > 0; n = Math.floor((n - 1) / 26)) {
    letters = String.fromCharCode(65 + ((n - 1) % 26)) + letters;
  }
  return letters;
}

interface ValidationTarget {
  dataValidations: { add: (address: string, validation: Record<string, unknown>) => void };
}

export async function buildStudentImportTemplate(
  tx: TransactionSql,
  schoolId: string,
  language: TemplateLanguage,
  recordFields: readonly ImportRecordField[],
): Promise<Uint8Array> {
  const { default: ExcelJS } = await import("exceljs");
  const { grades, sections } = await loadGradesAndSections(tx, schoolId);
  const rtl = language === "ar";
  const names = SHEET_NAMES[language];

  const workbook = new ExcelJS.Workbook();
  workbook.creator = "Studafy";
  const students = workbook.addWorksheet(names.students, {
    views: [{ rightToLeft: rtl, state: "frozen", ySplit: 1 }],
  });
  const instructions = workbook.addWorksheet(names.instructions, {
    views: [{ rightToLeft: rtl }],
  });
  const example = workbook.addWorksheet(names.example, { views: [{ rightToLeft: rtl }] });
  const lists = workbook.addWorksheet(names.lists, { state: "veryHidden" });

  // Hidden lists the dropdowns point at (a range, so no 255-character inline limit applies).
  const listColumns: Record<string, readonly string[]> = {
    A: STATUS_WORDS[language],
    B: RELATIONSHIP_WORDS[language],
    C: grades,
    D: sections,
  };
  const listRange: Record<string, string | null> = {};
  for (const [letter, values] of Object.entries(listColumns)) {
    values.forEach((value, index) => {
      lists.getCell(`${letter}${index + 1}`).value = value;
    });
    listRange[letter] =
      values.length === 0 ? null : `'${names.lists}'!$${letter}$1:$${letter}$${values.length}`;
  }
  const dropdowns: Partial<Record<StudentImportField, string | null>> = {
    status: listRange.A,
    parent_relationship: listRange.B,
    parent2_relationship: listRange.B,
    grade: listRange.C,
    section: listRange.D,
  };

  const recordColumns = recordFields.filter((field) => field.field_type !== "document");
  const headers = [
    ...COLUMNS.map((column) => HEADERS[language][column.field]),
    ...recordColumns.map((field) => (rtl ? field.label_ar : field.label_en)),
  ];
  const header = students.getRow(1);
  header.values = headers;
  header.font = { bold: true };
  header.alignment = { vertical: "middle", wrapText: true };
  header.height = 30;

  const validated = students as unknown as ValidationTarget;
  COLUMNS.forEach((column, index) => {
    const number = index + 1;
    const sheetColumn = students.getColumn(number);
    sheetColumn.width = column.width;
    if (column.text) sheetColumn.numFmt = "@";
    const cell = header.getCell(number);
    if (column.required) {
      cell.fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FFFFE699" } };
    }
    const note = NOTES[language][column.field];
    if (note) cell.note = note;
    const list = dropdowns[column.field];
    if (list) {
      const letter = columnLetter(number);
      validated.dataValidations.add(`${letter}2:${letter}${LAST_ROW}`, {
        type: "list",
        allowBlank: true,
        formulae: [list],
        // A warning, not a stop: a school may type a value the import still accepts (e.g. "Mom").
        showErrorMessage: false,
      });
    }
  });
  recordColumns.forEach((field, index) => {
    const sheetColumn = students.getColumn(COLUMNS.length + index + 1);
    sheetColumn.width = 18;
    sheetColumn.numFmt = "@";
  });

  instructions.getColumn(1).width = 100;
  INSTRUCTIONS[language].forEach((line, index) => {
    const cell = instructions.getCell(`A${index + 1}`);
    cell.value = line;
    if (index === 0) cell.font = { bold: true, size: 14 };
  });

  // The worked example, in the Students sheet's column order, up to the last parent column.
  const exampleColumns = COLUMNS.slice(
    0,
    COLUMNS.findIndex((column) => column.field === "parent2_email") + 1,
  );
  const exampleHeader = example.getRow(1);
  exampleHeader.values = exampleColumns.map((column) => HEADERS[language][column.field]);
  exampleHeader.font = { bold: true };
  exampleColumns.forEach((column, index) => {
    example.getColumn(index + 1).width = column.width;
    if (column.text) example.getColumn(index + 1).numFmt = "@";
  });
  EXAMPLE_ROWS[language].forEach((row, index) => {
    example.getRow(index + 2).values = [...row, ...EXAMPLE_PARENTS[language][index]!];
  });

  return new Uint8Array(await workbook.xlsx.writeBuffer());
}
