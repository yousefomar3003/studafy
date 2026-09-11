---
title: "Finance workflows"
description: "The end-to-end billing cycle: fee structures, invoice batches, payments, scholarships, refunds, expenses, and reports."
keywords:
  [
    "finance",
    "fees",
    "fee structure",
    "invoice",
    "batch",
    "payment",
    "scholarship",
    "refund",
    "expense",
    "reports",
    "reconciliation",
  ]
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
3. Add components with `Add component`. The **Invoice preview** panel shows an
   estimate for a sample student, including any confirmed scholarship
   discounts.
4. `Create fee structure` (or `Save changes`).

A new structure is created `Draft` in ERPNext. Once it is `Submitted` or
`Cancelled` it is immutable — create a new structure instead of editing.
Invoice generation only offers submitted structures.

## 2. Generate invoices

Finance → Invoices → `Generate invoices`.

1. Pick a `Submitted` fee structure. The option shows its total and currency.
2. Enter a **Period title** (e.g. "Spring 2026 Term 1") and optionally a due date.
3. Choose the target: every enrolled student in the school, or students in
   specific active classes.
4. `Start batch`.

The batch runs in the background — you can leave the page. The progress panel
tracks `Total`, `Created`, `Already existed`, and `Failed`, and you can filter
the results by status. `Start another batch` to run it again (for example for
a second period).

Individual invoices appear on Finance → Invoices, searchable by student or
invoice number and filterable by `Draft`, `Submitted`, or `Cancelled`.

## 3. Record payments

Finance → Payments → `Record a payment`.

1. Search for the **Invoice**. Only submitted invoices with an outstanding
   balance are payable.
2. Enter the **Amount**. The form tells you when it is a full payment, a
   partial payment (and what will remain outstanding), or an overpayment —
   ERPNext rejects overpayments, so it stops you.
3. Pick a **Payment method**: Cash, Bank transfer, or Card (external). Bank
   transfer and card need a **Reference number**.
4. Optionally set reference/ posting dates and remarks, then `Record payment`.

Payments are sent to ERPNext and confirmed in the background. The success
panel shows `Pending` while awaiting confirmation, then links a receipt.
Payments are idempotent — double-submitting cannot record the same payment
twice. If a submission was already recorded, you are told to check the payment
history before retrying.

## 4. Scholarships and refunds

### Award a scholarship or discount

Finance → Scholarships → `New award`.

1. Pick the **Student** and the **Scholarship / discount**.
2. The effect line shows exactly what applies, e.g. "50 JOD off the 'Tuition'
   fee category on every future invoice."
3. `Review award`, confirm, and the award is created **Pending confirmation**.

A different user must confirm a pending award before it affects any invoice.
This separation is deliberate — one person cannot both create and confirm.

### Request a refund

Finance → Refunds → `Request a refund`.

1. Pick an **Invoice** that has a paid amount (the form shows "Paid to date").
2. Enter the **Amount** (cannot exceed what was paid), pick a **Reason**
   (`Overpayment`, `Withdrawal`, `Discount adjustment`, or `Error correction`),
   and add notes if useful.
3. `Review refund`, then confirm.

The refund is created **Pending approval**. A different user with refund
approval rights must approve it before ERPNext issues the credit note. Track
the request through `Approved`, `Submitted to ERPNext`, `Completed`, and the
failure states `Rejected` and `Failed` on the refunds list.

## 5. Expenses

Finance → Expenses → `Record an expense`.

1. Pick a **Document type**: Purchase invoice, Expense claim, or Journal entry.
   The form relabels its fields to match ERPNext for the type (Supplier /
   Employee / Reference, and the matching account field).
2. Enter the **Amount**, **Currency**, and optionally the **Expense date**,
   **Description**, and a receipt image or PDF.
3. `Record expense`.

Expenses post to ERPNext directly on submit.

## 6. Reports and reconciliation

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
payments before refunds. Scholarships apply to future invoices, so award them
before the relevant batch is generated if they must affect that billing
period.
