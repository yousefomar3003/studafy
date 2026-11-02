---
title: "Record a payment"
description: "Record a cash, bank transfer or card payment against a family's invoice and get the receipt."
keywords:
  [
    "record payment",
    "payment",
    "pay invoice",
    "cash",
    "bank transfer",
    "card",
    "receipt",
    "partial payment",
    "reference number",
  ]
title_ar: "تسجيل دفعة"
description_ar: "سجّل دفعة نقدية أو تحويلًا بنكيًا أو دفعة بالبطاقة على فاتورة الأسرة واحصل على الإيصال."
keywords_ar:
  [
    "تسجيل دفعة",
    "دفعة",
    "سداد",
    "سداد فاتورة",
    "نقدًا",
    "كاش",
    "تحويل بنكي",
    "بطاقة",
    "إيصال",
    "دفعة جزئية",
    "رقم المرجع",
  ]
roles: [FINANCE]
action: record-payment
order: 3
---

# Record a payment

Use this for money the school received at the desk or by bank transfer.
Payments are sent to ERPNext, the accounting system Studafy runs for you, and
confirmed there.

## Open the payment form

Open `Finance`, click `Payments →`, then `Record payment`.

## Fill in the payment

1. Under **Invoice**, search by student name or invoice number and pick the
   invoice. Only submitted invoices with an outstanding balance are listed.
2. Enter the **Amount**. The form tells you whether it is a full payment or a
   partial payment, and what will remain outstanding. If the amount is more
   than the outstanding balance, lower it: ERPNext rejects overpayments.
3. Pick the **Payment method**: `Cash`, `Bank transfer` or `Card (external)`.
4. Enter the **Reference number** from the bank or card terminal. ERPNext
   requires it for bank transfer and card payments.
5. Optionally set the **Reference date**, the **Posting date** (defaults to
   today) and **Remarks**.
6. Click `Record payment`.

## Get the receipt

The payment first shows as `Pending` while ERPNext confirms it. The page
checks again on its own. Once it is `Confirmed`, click `Open receipt`.

If ERPNext rejects the payment, the status becomes `Failed`. Check the payment
history for the reason before trying again.

Click `Record another payment` for the next one, or `View payment history` to
see all payments.

## Avoid recording it twice

Clicking `Record payment` twice records the payment only once. If Studafy says
the submission may have already been recorded, check the payment history
before you try again.
