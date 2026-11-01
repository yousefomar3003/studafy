---
title: "Correct an invoice or a payment"
description: "Cancel an invoice billed by mistake, issue a credit note, write off a balance, or reverse a payment recorded by mistake."
keywords:
  [
    "cancel invoice",
    "void invoice",
    "credit note",
    "write off",
    "bad debt",
    "reverse payment",
    "undo payment",
    "wrong payment",
    "correction",
    "approval",
  ]
title_ar: "تصحيح فاتورة أو دفعة"
description_ar: "ألغِ فاتورة صدرت خطأً، أو أصدر إشعارًا دائنًا، أو اشطب رصيدًا، أو ألغِ دفعة سُجّلت خطأً."
keywords_ar:
  [
    "إلغاء فاتورة",
    "إشعار دائن",
    "شطب",
    "دين معدوم",
    "إلغاء دفعة",
    "التراجع عن دفعة",
    "دفعة خاطئة",
    "تصحيح",
    "اعتماد",
    "فاتورة خاطئة",
  ]
roles: [FINANCE, ORG_ADMIN]
order: 5
---

# Correct an invoice or a payment

Every correction needs two people, as refunds do. Finance staff ask for it,
and a **different** user with refund approval rights (the school admin)
approves it in `Finance`, `Refunds →`. Nothing changes in ERPNext until then.
You always give a reason; the approver sees it and it stays in the audit trail.

## Which correction to use

| What happened                                     | Use               |
| ------------------------------------------------- | ----------------- |
| An invoice was billed by mistake and nothing paid | Cancel invoice    |
| An invoice was billed too high, or a fee changed  | Credit note       |
| A balance will not be collected                   | Write off balance |
| A payment was recorded by mistake                 | Reverse payment   |
| Money has to go back to the family                | Request a refund  |

## Cancel an invoice

1. Open the invoice from `Finance`, `Invoices`.
2. Click `Cancel invoice`. It is only offered while nothing has been paid on
   the invoice. Once money or a credit note is against it, use a credit note.
3. Enter the reason and click `Ask to cancel`.

When it is approved, ERPNext cancels the invoice and the family no longer owes
it.

## Issue a credit note or write off a balance

1. Open the invoice and click `Credit note` or `Write off balance`.
2. The refund form opens on that invoice. A write-off starts at the whole
   outstanding balance and cannot be more than what is still owed.
3. Check the amount and reason, click `Review refund`, then confirm.

## Reverse a payment

1. Open `Finance`, `Payments` and find the payment. Search by payment or
   invoice number, or by the student's name.
2. Click `Reverse` on its row, enter the reason, then click `Ask to reverse`.

When it is approved, ERPNext cancels the payment, it shows as `Reversed`, and
its invoice is owed again.

## Follow a request

Every request has its own page: open it from `Finance`, `Refunds →`, from the
invoice's `Refunds and corrections` list, or from the student's account. The
page shows what was asked, why, when it was decided, and what approval does.
