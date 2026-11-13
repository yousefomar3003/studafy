---
title: "Finance workflows"
description: "The end-to-end billing cycle: fee structures, invoice batches, payments, refunds, scholarships, expenses, and reports."
keywords:
  [
    "finance",
    "fees",
    "fee structure",
    "invoice",
    "batch",
    "payment",
    "refund",
    "scholarship",
    "discount",
    "expense",
    "reports",
    "reconciliation",
  ]
title_ar: "سير العمل المالي"
description_ar: "دورة الفوترة كاملة من هياكل الرسوم ودفعات الفواتير إلى المدفوعات والمبالغ المستردة والمنح والمصروفات والتقارير."
keywords_ar:
  [
    "المالية",
    "الرسوم",
    "الرسوم الدراسية",
    "هيكل الرسوم",
    "فاتورة",
    "فواتير",
    "دفعة",
    "استرداد",
    "منحة",
    "خصم",
    "مصروفات",
    "تقارير",
    "مطابقة",
  ]
roles: [FINANCE]
order: 1
---

# Finance workflows

Finance moves through a fixed sequence. Fee structures define what families
are charged, invoice batches apply them, payments and adjustments clear what is
owed, expenses track what the school spends, and reports close the loop. The
Finance dashboard links to every page in the workflow.

Billing data lives in ERPNext, which Studafy manages on your behalf. Statuses
you see here mirror ERPNext (for example `Draft`, `Submitted`, `Cancelled`).

## 1. Fee structures

Finance → Fee structures. A fee structure bundles fee components (category,
amount, optional description) for a program and academic year.

1. `New fee structure` (or pick an existing structure to edit it).
2. Give it a **Title**, **Academic year**, **Program** (the ERPNext program
   grouping, e.g. "Grade 5"), and a 3-letter **Currency** code.
   For a structure that belongs to one student, pick the **Student**: open the
   list and choose them, or type a name to narrow it. The title becomes the
   student's name (you can still change it). Leave it empty for a whole grade
   or program. You can change the student even after the structure is
   submitted.
3. Add components with `Add component`. The **Invoice preview** panel shows
   the invoice the structure produces; for a structure with a student, their
   approved scholarships are taken off, with the student's own total.
4. `Create fee structure` (or `Save changes`).

A new structure is created `Draft` in ERPNext. Once it is `Submitted` or
`Cancelled` it is immutable — create a new structure instead of editing.
Invoice generation only offers submitted structures. A submitted structure has a
`Bill students with this structure` button that opens Generate invoices with it
already selected, and with its student preselected.

## 2. Generate invoices

Finance → `Invoices →` → `Generate invoices`. Step by step:
[Create an invoice batch](/help/create-invoice-batch).

1. Pick a `Submitted` fee structure. The option shows its total and currency.
2. Enter a **Period title** (e.g. "Spring 2026 Term 1") and optionally a due date.
3. Choose the target: every enrolled student in the school, students in
   specific active classes, or **Specific students**. For specific students,
   open the list and pick each one (type a name to narrow it); remove a pick
   with its `×`.
4. `Start batch`.

The batch runs in the background — you can leave the page. The progress panel
tracks `Total`, `Created`, `Already existed`, and `Failed`, and you can filter
the results by status. `Start another batch` to run it again (for example for
a second period).

Individual invoices appear on Finance → Invoices, searchable by student or
invoice number and filterable by `Draft`, `Submitted`, or `Cancelled`.

## 3. Record payments

Finance → `Payments →` → `Record payment`. Step by step:
[Record a payment](/help/record-payment).

1. Search for the **Invoice**. Only submitted invoices with an outstanding
   balance are payable.
2. Enter the **Amount**. The form tells you when it is a full payment, a
   partial payment (and what will remain outstanding), or more than the
   outstanding balance. ERPNext rejects an overpayment, so lower the amount.
3. Pick a **Payment method**: Cash, Bank transfer, or Card (external). ERPNext
   requires a **Reference number** for bank transfer and card.
4. Optionally set reference/ posting dates and remarks, then `Record payment`.

Payments are sent to ERPNext and confirmed in the background. The success
panel shows `Pending` while awaiting confirmation, then `Open receipt` once it
is confirmed. Payments are idempotent — double-submitting cannot record the
same payment twice. If a submission may already have been recorded, you are
told to check the payment history before retrying.

## 4. Refunds

### Request a refund

Finance → `Refunds →` → `Request refund`. Step by step, including approval:
[Issue a refund](/help/issue-refund).

1. Pick an **Invoice** that has a paid amount (the form shows "Paid to date").
2. Enter the **Amount** (cannot exceed what was paid), pick a **Reason**
   (`Overpayment`, `Withdrawal`, `Discount adjustment`, or `Error correction`),
   and add notes if useful.
3. `Review refund`, then `Request refund`.

The refund is created **Pending approval**. A different user with refund
approval rights (the school admin) must click `Approve` on the refunds list
before ERPNext issues the credit note; you cannot approve your own request.
Track the request through `Submitted to ERPNext` and `Completed`, or
`Rejected` (a rejection always carries a reason), on the refunds list.

## 5. Scholarships

A scholarship takes a percentage (for example 10%) or a fixed amount (for
example 150 JOD) off a student's fees: every fee, or one fee category such as
Tuition.

### Create a scholarship

Finance → Scholarships → `New scholarship`. Give it a **Name**, pick
**Percentage** or **Fixed amount**, enter the value (and **Currency** for a
fixed amount), and optionally a **Fee category**, spelled exactly as in the fee
structure. A scholarship can't be edited once created; deactivate it and create
a new one instead.

### Award it to a student

Finance → Scholarships → `Award to a student`. Pick the scholarship, pick the
student from the list (type a name to narrow it), add why they qualify, then
`Request approval`. You can also pick students straight away in
`New scholarship`; each one is sent for approval when the scholarship is
created.

The award is created **Awaiting approval**. Only the school admin can approve
or reject it (a rejection needs a reason, which finance sees), and can later
revoke an approved award. Once approved, the discount appears on the student's
invoices generated from then on; invoices already issued don't change. Several
scholarships add up, but never take an invoice below zero.

## 6. Expenses

Finance → Expenses → `Record an expense`.

1. Pick a **Document type**: Purchase invoice, Expense claim, or Journal entry.
   The form relabels its fields to match ERPNext for the type (Supplier /
   Employee / Reference, and the matching account field).
2. Enter the **Amount**, **Currency**, and optionally the **Expense date**,
   **Description**, and a receipt image or PDF.
3. `Record expense`.

Expenses post to ERPNext directly on submit.

## 7. Reports and reconciliation

Finance → Reports. Four report types, each with its own filters, preview, and
download:

- **Aging** — outstanding balances by age bucket.
- **Collections** — collections vs. amounts due.
- **General ledger** — the full ledger.
- **Family statement** — per-student/family statements.

Downloads run in the background; you are notified in the Reports center when a
file is ready. Use these alongside the overdue installments list (Finance →
`View all overdue installments`) and the dashboard tiles (collections vs due,
aging buckets, recent payments) to close the month.

## Order of operations

Do not skip steps: fee structures before invoices, invoices before payments,
payments before refunds.
