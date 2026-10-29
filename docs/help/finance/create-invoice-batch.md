---
title: "Create an invoice batch"
description: "Bill a whole school, some classes, or chosen students from one fee structure in a single background batch."
keywords:
  [
    "invoice batch",
    "generate invoices",
    "billing run",
    "bill students",
    "fee structure",
    "period title",
    "due date",
    "already existed",
  ]
title_ar: "إنشاء دفعة فواتير"
description_ar: "أصدر فواتير لكل المدرسة أو لصفوف محددة أو لطلاب مختارين من هيكل رسوم واحد في دفعة تعمل في الخلفية."
keywords_ar:
  [
    "دفعة فواتير",
    "إصدار الفواتير",
    "إنشاء فواتير",
    "فوترة الطلاب",
    "الرسوم الدراسية",
    "هيكل الرسوم",
    "تاريخ الاستحقاق",
    "الفصل الدراسي",
    "فاتورة",
    "فواتير",
  ]
roles: [FINANCE]
action: create-invoice-batch
order: 2
---

# Create an invoice batch

A batch creates one invoice per student from a fee structure. It runs in the
background, and running it twice never bills a student twice for the same
period.

## Before you start

- You need a **submitted** fee structure (Finance → `Fee structure builder →`).
  Drafts are not offered.
- Link students to their parents first where you can. A student with no family
  is still billed, but gets no sibling discount and no parent can see or pay
  the invoice in the app.

## Start the batch

1. Open `Finance`, click `Invoices →`, then `Generate invoices`. From a
   submitted fee structure you can also click
   `Bill students with this structure`, which preselects it.
2. Pick the **Fee structure**. Each option shows its total and currency.
3. Enter a **Period title**, for example "Spring 2026 Term 1", and optionally a
   **Due date**.
4. Under **Target students**, choose who to bill:
   - `Every enrolled student in the school` (the default),
   - `Students actively enrolled in specific classes`, then tick the classes,
   - or `Specific students`, then pick each student.
5. Click `Start batch`.

## If some students have no family

If any student in the batch has no guardian linked, Studafy asks first. Click
`Review unlinked students` to link them (see
[Link a parent to a student](/help/link-parent)), `Go back` to change the
batch, or `Generate anyway`.

## Follow the progress

The progress panel counts **Total**, **Created**, **Already existed** and
**Failed**. You can leave the page; the batch keeps running. Use
**Filter by status** to list the students in each group, with the invoice
created or the error for each one.

When the batch is `Completed` or `Failed`, click `Start another batch` for the
next one.

## Running a batch again

An invoice is identified by the student, the fee structure and the period
title. Run the same structure with the same period title again and students
already billed show as **Already existed**: they are not billed twice. Use a
new period title to bill a new period.
