---
title: "Set up payment plans and VAT"
description: "Split a fee structure into installments, and charge sales tax (VAT) on new invoices."
keywords:
  [
    "installments",
    "payment plan",
    "instalments",
    "fee schedule",
    "monthly fees",
    "term fees",
    "vat",
    "tax",
    "tax registration number",
    "tax exempt",
  ]
title_ar: "إعداد خطط الدفع وضريبة القيمة المضافة"
description_ar: "قسّم هيكل الرسوم إلى أقساط، وافرض ضريبة القيمة المضافة على الفواتير الجديدة."
keywords_ar:
  [
    "أقساط",
    "خطة دفع",
    "جدولة الرسوم",
    "رسوم شهرية",
    "رسوم فصلية",
    "ضريبة القيمة المضافة",
    "ضريبة",
    "الرقم الضريبي",
    "معفى من الضريبة",
    "نسبة الضريبة",
  ]
roles: [FINANCE, ORG_ADMIN]
action: add-fee-structure
order: 6
---

# Set up payment plans and VAT

## Split fees into installments

1. Open `Finance`, `Fees`, and select a fee structure. It must be submitted in
   ERPNext, and the students it is for must be saved on it.
2. Under **Payment plan**, pick the **Schedule**: by term, monthly, quarterly
   or yearly.
3. Add one **Due date** per installment, up to twelve.
4. Click `Create installments`.

ERPNext divides the structure's total over the due dates. The installments
show on each student's account, on the overdue list and on the dashboard.

## Charge VAT on fees

Only a school admin can change these settings; finance staff can read them.
Whether your fees are taxable depends on your country and the fee, so check
with your accountant first.

1. Open `Finance`, then search for `VAT` or open `Sales tax (VAT)` settings.
2. Tick `Charge tax on new invoices`.
3. Enter the **Rate**, the **ERPNext tax account** the tax posts to, and your
   **Tax registration number**. The number prints on invoices and receipts.
4. List the **Exempt fee categories**, one per line, for fees the rate does
   not apply to.
5. Tick `Fee amounts already include tax` if your fees are quoted with tax in
   them.
6. Click `Save tax settings`.

The rate applies to invoices generated from then on. Invoices already issued
do not change; correct one with a credit note.
