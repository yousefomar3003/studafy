---
title: "Keep your own lists"
description: "Keep data Studafy has no section for, such as bus routes, library loans, clinic visits or lockers, as your own lists, linked to students, parents, staff or classes."
keywords:
  [
    "lists",
    "custom list",
    "table",
    "spreadsheet",
    "bus route",
    "library",
    "clinic",
    "locker",
    "uniform",
    "alumni",
    "import",
    "csv",
    "sensitive",
    "export",
  ]
title_ar: "احتفظ بقوائمك الخاصة"
description_ar: "احتفظ بالبيانات التي لا يوجد لها قسم في Studafy، مثل خطوط الحافلات وإعارات المكتبة وزيارات العيادة والخزائن، في قوائم خاصة بك مرتبطة بالطلاب أو أولياء الأمور أو الموظفين أو الشعب."
keywords_ar:
  [
    "قوائم",
    "قائمة مخصصة",
    "جدول",
    "جدول بيانات",
    "خط الحافلة",
    "المكتبة",
    "العيادة",
    "خزانة",
    "الزي المدرسي",
    "الخريجون",
    "استيراد",
    "تصدير",
    "بيانات حساسة",
  ]
roles: [ORG_ADMIN, PRINCIPAL]
order: 7
---

# Keep your own lists

Some of what a school keeps has no section in Studafy: bus routes, library
loans, clinic visits, lockers, uniform orders, alumni. Keep these as **lists**.
A list is a table you design: you choose its columns, and each row can point to
a student, a parent, a member of staff or a class.

Org admins and principals create and change lists. Who works in a list depends
on the list's audience (see below). Parents and students never see lists.

## Create a list

Open **Lists** in the sidebar and click `New list`.

1. Give the list an English and an Arabic name, and a description if you want.
2. Choose its **audience**:
   - **Admins only**: org admins.
   - **School leadership**: org admins and principals.
   - **All staff**: everyone on the school's staff, teachers included.

   You can only choose an audience you belong to.

3. Choose what rows may be linked to: students, parents, staff, classes, or
   nothing.
4. Add columns. Each column has a type (text, long text, number, date, choice,
   multiple choice, yes/no, phone or email), an English and an Arabic label,
   and can be **Required**.

You can rename a list, change its audience, reorder columns and archive a
column later. Archiving hides a column but keeps what was entered in it. A
column's type, and whether it is sensitive, cannot change once it exists: add a
new column instead.

A school can keep up to 50 lists. Each list can have up to 30 columns and 5,000
rows, and a school can have up to 20,000 rows across all its lists.

## Work in a list

Open a list to see its rows as a table. Search across the rows, filter by one
column, and sort by any column. Click `Add row` to add one, and choose who or
what it is about if the list allows links. Edit or delete a row from the table.

`Export CSV` downloads the list as a spreadsheet. Sensitive columns are never
in the export.

Each student, parent, staff and class page has a small **Lists** panel showing
the rows linked to them, from the lists you are allowed to see.

## Sensitive columns

Mark a column **Sensitive** for anything like an ID number or a medical note. A
sensitive column:

- is encrypted, and shows masked everywhere (for example `•••• 1234`);
- needs an extra step to see in full: click `Reveal`. Only org admins and
  principals can reveal, and every reveal is recorded with who looked, when,
  and at which cell;
- is never searched, filtered, sorted on or exported.

## Create a list from a spreadsheet

When you import a sheet Studafy does not recognise, choose
`Create a custom list from this sheet`. You can also start from
`Import a sheet` on the Lists page.

1. The first line of the sheet names the columns. Studafy guesses each
   column's type from its values and suggests marking a column sensitive when
   it looks like an ID number or medical information. Check the names, types
   and sensitivity, and leave out any columns you do not need.
2. To link rows to people or classes, choose the column that holds one of your
   school's own keys: a Studafy member ID, an admission number, an employee
   number or a class code. Only an exact match links a row. Studafy never
   matches by name, email, phone or ID number.
3. Click `Preview`. The preview shows every row, what it would be linked to,
   and every row that matched nothing. You can choose to leave out the rows
   that did not match. Cells that do not fit their column's type are left
   empty, and the preview lists their lines.
4. Click `Create list`. Nothing is saved until you do. If something changed
   since the preview, preview again.

## Privacy

A row linked to a person is part of that person's data. It is included when
they ask for a copy of their data, and deleted when their data is erased. When
a school closes its account, every list is deleted.
