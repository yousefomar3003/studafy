import { ERROR_CODES } from "@studafy/constants";

import { CodedHttpException } from "../../../coded-http-exception";
import { getPayment } from "../payments/service";
import { getRefund } from "../refunds/service";

import type { ReceiptInput, RefundReceiptInput } from "./render";
import type { TransactionSql } from "postgres";

/**
 * Everything one receipt shows, for a reader who may see it: finance staff (`allowAll`), or a
 * guardian linked to the payment's student. Anyone else gets the same 404 as a payment that does
 * not exist, so the endpoint cannot be used to probe for payments.
 *
 * Runs as studafy_admin with the tenant scope set: a guardian cannot read finance rows and FINANCE
 * cannot read students, and the receipt needs both.
 */
export async function loadReceipt(
  tx: TransactionSql,
  schoolId: string,
  paymentId: string,
  reader: { userId: string; allowAll: boolean },
  locale: "en" | "ar",
): Promise<ReceiptInput> {
  const payment = await getPayment(tx, schoolId, paymentId);

  if (!reader.allowAll) {
    const [linked] = await tx<{ ok: boolean }[]>`
      SELECT true AS ok
      FROM app.parent_child_links
      WHERE school_id = ${schoolId}::uuid
        AND student_id = ${payment.student_id}::uuid
        AND parent_user_id = ${reader.userId}::uuid
      LIMIT 1
    `;
    if (!linked) {
      throw new CodedHttpException(404, ERROR_CODES.PAYMENT_NOT_FOUND, "Payment not found");
    }
  }

  const details = await receiptParties(tx, schoolId, payment.student_id);

  return {
    locale,
    schoolName: details?.school_name ?? "",
    taxRegistrationNumber: details?.tax_registration_number ?? null,
    receiptNumber: payment.erpnext_payment_entry_id ?? payment.id,
    paymentDate: payment.payment_date,
    status: payment.status,
    studentName: details?.student_name ?? "",
    admissionNumber: details?.admission_number ?? "",
    familyName: details?.family_name ?? null,
    invoiceId: payment.erpnext_invoice_id,
    amount: payment.amount,
    currency: payment.currency,
    paymentMode: payment.payment_mode,
    generatedAt: new Date(),
  };
}

/** The school, student and family a receipt names. */
interface ReceiptParties {
  school_name: string;
  tax_registration_number: string | null;
  student_name: string;
  admission_number: string;
  family_name: string | null;
}

async function receiptParties(
  tx: TransactionSql,
  schoolId: string,
  studentId: string,
): Promise<ReceiptParties | undefined> {
  const [details] = await tx<ReceiptParties[]>`
    SELECT school.name AS school_name,
           (SELECT tax.registration_number FROM app.school_tax_settings AS tax
            WHERE tax.school_id = school.id) AS tax_registration_number,
           coalesce(student.preferred_name, student.first_name) || ' ' || student.last_name
             AS student_name,
           student.admission_number,
           (SELECT family.display_name
            FROM app.parent_child_links AS link
            JOIN app.families AS family
              ON family.id = link.family_id AND family.school_id = link.school_id
            WHERE link.school_id = student.school_id AND link.student_id = student.id
            ORDER BY family.created_at, family.id
            LIMIT 1) AS family_name
    FROM app.students AS student
    JOIN app.schools AS school ON school.id = student.school_id
    WHERE student.school_id = ${schoolId}::uuid AND student.id = ${studentId}::uuid
  `;

  return details;
}

/**
 * Everything a refund receipt shows: a refund the school handed back to the family (settlement
 * paid_out), for finance staff. A refund that handed nothing back (taken off the invoice, or kept
 * as credit) has no receipt. Runs like loadReceipt, as studafy_admin with the tenant scope set,
 * since the receipt reads both the refund and the student.
 */
export async function loadRefundReceipt(
  tx: TransactionSql,
  schoolId: string,
  refundId: string,
  locale: "en" | "ar",
): Promise<RefundReceiptInput> {
  const refund = await getRefund(tx, schoolId, refundId);
  if (
    refund.kind !== "credit_note" ||
    refund.status !== "completed" ||
    refund.settlement !== "paid_out" ||
    refund.payout_mode === "credit" ||
    !refund.erpnext_credit_note_id
  ) {
    throw new CodedHttpException(
      409,
      ERROR_CODES.REFUND_INVALID_STATUS,
      "Only a refund handed back to the family has a receipt",
    );
  }
  const details = await receiptParties(tx, schoolId, refund.student_id);
  // The day it was paid out at the school, not the server's UTC date (QA-044).
  const [day] = await tx<{ date: string }[]>`
    SELECT app.school_today(${refund.completed_at}::timestamptz)::text AS date
  `;

  return {
    locale,
    schoolName: details?.school_name ?? "",
    taxRegistrationNumber: details?.tax_registration_number ?? null,
    receiptNumber: refund.erpnext_credit_note_id,
    refundDate: day?.date ?? refund.completed_at!.slice(0, 10),
    studentName: details?.student_name ?? "",
    admissionNumber: details?.admission_number ?? "",
    familyName: details?.family_name ?? null,
    invoiceId: refund.erpnext_invoice_id,
    paidOutAmount: refund.paid_out_amount,
    refundAmount: refund.amount,
    currency: refund.currency,
    payoutMode: refund.payout_mode,
    reason: refund.reason_code,
    notes: refund.reason_notes,
    generatedAt: new Date(),
  };
}
