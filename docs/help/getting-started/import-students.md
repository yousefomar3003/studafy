---
title: "Import students from a CSV file"
description: "Upload a spreadsheet of students, match its columns, check the preview, and confirm the import."
keywords:
  [
    "import",
    "csv",
    "spreadsheet",
    "excel",
    "bulk",
    "upload students",
    "template",
    "column mapping",
    "error report",
    "parent email",
  ]
title_ar: "استيراد الطلاب من ملف CSV"
description_ar: "ارفع جدول بيانات بالطلاب، وطابق أعمدته، وراجع المعاينة، ثم أكّد الاستيراد."
keywords_ar:
  [
    "استيراد",
    "استيراد الطلاب",
    "ملف CSV",
    "جدول بيانات",
    "إكسل",
    "رفع ملف",
    "إضافة جماعية",
    "قالب",
    "مطابقة الأعمدة",
    "تقرير الأخطاء",
    "بريد ولي الأمر",
  ]
roles: [ORG_ADMIN]
action: import-students
order: 5
---

# Import students from a CSV file

Nothing is saved until you confirm. Every upload is checked first, and you see
exactly what the import would do before it runs. Only the school admin can
import students.

## Open the import page

From your `Home` page, click `Manage students →`, then `Import CSV`.

## Prepare the file

Click `Download CSV template` for a file with the expected columns.

- **Required:** Admission number, Student email, First name, Last name.
- **Optional:** Middle name, Preferred name, Date of birth (`YYYY-MM-DD`),
  Status, Parent email, Parent name, Parent relationship.
- Status is one of `applicant`, `enrolled`, `suspended`, `graduated`,
  `withdrawn` or `archived`. A blank status makes a new student an applicant.
- Parent relationship is one of `mother`, `father`, `guardian`,
  `step_parent`, `grandparent`, `sibling` or `other`. Give Parent email and
  Parent relationship together, or leave both out.

Your school's student record fields can be extra columns. Document fields
cannot be imported: upload those files on each student's Records tab.

## Upload and match columns

1. Choose your file under **Student CSV file**.
2. Under **Match your columns**, check which column of your file feeds each
   field. Studafy suggests a match and shows how sure it is. Pick `Not mapped`
   for a field your file does not have.
3. If you change a match, click `Apply mapping` to check the file again. To
   reuse the mapping next time, give it a name under **Save as (optional)**.

## Check the errors

The validation report shows **Rows in file**, **Valid rows** and **Rows with
errors**. Each error gives the line, the field and what is wrong. Click
`Download error report` to fix them in your spreadsheet, then
`Upload a different file`. Rows with errors are never imported.

## Preview the changes

**Preview changes** shows what confirming would do, row by row: new students,
updated students (an admission number that already exists), rows with no
change, rows skipped because of a conflict, new parent accounts, and parents to
link by hand. Use **Show** to filter the rows.

## Confirm the import

Click `Confirm import (N students)`. The import runs in the background; you
can leave the page. When it finishes you see how many students, parent
accounts and guardian links were created. Click `Back to students` or
`Import another file`.

## Parents in the import

- A parent email that is new to Studafy creates a parent account and links it
  to the student. Brothers and sisters in the same file who share a new parent
  email get one parent account between them.
- A parent email that already belongs to an account is **never matched**. The
  student is still imported, but without a parent link, and the preview counts
  them under **Parents to link by hand**. Link them yourself afterwards (see
  [Link a parent to a student](/help/link-parent)).
