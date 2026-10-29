---
title: "Issue a refund"
description: "Request a refund against a paid invoice and have a second person approve it before the credit note is issued."
keywords:
  [
    "refund",
    "issue refund",
    "request refund",
    "approve refund",
    "reject refund",
    "credit note",
    "maker checker",
    "overpayment",
    "withdrawal",
  ]
title_ar: "إصدار استرداد"
description_ar: "اطلب استرداد مبلغ من فاتورة مدفوعة، ثم يعتمده شخص آخر قبل إصدار إشعار الدائن."
keywords_ar:
  [
    "استرداد",
    "استرجاع مبلغ",
    "طلب استرداد",
    "اعتماد الاسترداد",
    "رفض الاسترداد",
    "إشعار دائن",
    "موافقة",
    "دفعة زائدة",
    "انسحاب طالب",
    "تصحيح خطأ",
  ]
roles: [FINANCE, ORG_ADMIN]
action: issue-refund
order: 4
---

# Issue a refund

Every refund needs two people. One requests it, and a **different** user with
refund approval rights approves it. Only then does ERPNext issue the credit
note. Finance staff request refunds; the school admin approves or rejects
them.

## Request a refund

1. Open `Finance`, click `Refunds →`, then `Request refund`.
2. Under **Invoice**, search by student name or invoice number and pick the
   invoice. Only submitted invoices with a paid amount are listed. The form
   shows what has been paid to date.
3. Enter the **Amount**. It cannot be more than what was paid on the invoice.
4. Pick the **Reason**: `Overpayment`, `Withdrawal`, `Discount adjustment` or
   `Error correction`. Add **Notes** if they help the approver.
5. Click `Review refund`, check the summary, then click `Request refund`.

The refund is now `Pending approval`. Nothing has been paid back yet.

## Approve or reject a refund

The approver opens `Finance`, then `Refunds →`. Refunds waiting for a decision
show `Approve` and `Reject` on their row.

- **Approve:** click `Approve`, check the invoice, amount and reason, then
  click `Approve refund`. The refund goes to ERPNext as a credit note. This
  cannot be undone from Studafy.
- **Reject:** click `Reject`, enter the **Reason** (required), then click
  `Reject`.

You cannot approve or reject a refund you requested yourself: both buttons
are disabled on your own requests.

## Refund statuses

| Status                 | Meaning                                            |
| ---------------------- | -------------------------------------------------- |
| `Pending approval`     | Requested, waiting for a different user to decide. |
| `Submitted to ERPNext` | Approved and sent to ERPNext as a credit note.     |
| `Completed`            | ERPNext has issued the credit note.                |
| `Rejected`             | The approver turned it down, with a reason.        |
