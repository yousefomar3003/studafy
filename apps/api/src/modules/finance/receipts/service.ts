import { ERROR_CODES } from "@studafy/constants";

import { CodedHttpException } from "../../../coded-http-exception";
import { getPayment } from "../payments/service";

import type { ReceiptInput } from "./render";
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

  const [details] = await tx<
    {
      school_name: string;
      student_name: string;
      admission_number: string;
      family_name: string | null;
    }[]
  >`
    SELECT school.name AS school_name,
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
    WHERE student.school_id = ${schoolId}::uuid AND student.id = ${payment.student_id}::uuid
  `;

  return {
    locale,
    schoolName: details?.school_name ?? "",
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
