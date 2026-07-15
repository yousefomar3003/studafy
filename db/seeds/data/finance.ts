// Finance read-models. The double-entry ledger lives in ERPNext (see migration 000015); these tables
// are local caches of already-computed ERPNext documents plus the identity crosswalk. "Invoices",
// "receipts/payments", and "fee templates" are invoice_cache, payment_cache, and fee_schedule_cache
// respectively — there are no first-class invoice tables. erpnext_payload keeps its '{}' default.
import { seedDate, uuid } from "../support";

import type { FullCtx, Sql } from "../support";

export async function seedFinance(sql: Sql, ctx: FullCtx): Promise<void> {
  const { schoolId, currencyId, students, academicYearId, terms } = ctx;
  const billedStudents = students.slice(0, 4);
  const lastSyncedAt = seedDate(-1);

  const invoices = billedStudents.map((student, index) => ({
    id: uuid(),
    studentId: student.studentId,
    docname: `ACC-SINV-2026-${String(index + 1).padStart(5, "0")}`,
    total: 500_000,
    outstanding: index % 2 === 0 ? 0 : 250_000,
    status: index % 2 === 0 ? "Paid" : "Unpaid",
  }));
  await sql`
    INSERT INTO app.invoice_cache ${sql(
      invoices.map((invoice) => ({
        id: invoice.id,
        school_id: schoolId,
        student_id: invoice.studentId,
        currency_id: currencyId,
        erpnext_docname: invoice.docname,
        erpnext_status: invoice.status,
        total_amount_minor: invoice.total,
        outstanding_amount_minor: invoice.outstanding,
        issued_date: "2026-07-01",
        due_date: "2026-07-31",
        last_synced_at: lastSyncedAt,
      })),
      "id",
      "school_id",
      "student_id",
      "currency_id",
      "erpnext_docname",
      "erpnext_status",
      "total_amount_minor",
      "outstanding_amount_minor",
      "issued_date",
      "due_date",
      "last_synced_at",
    )}
  `;

  // Receipts for the invoices that were paid in full.
  const paidInvoices = invoices.filter((invoice) => invoice.outstanding === 0);
  await sql`
    INSERT INTO app.payment_cache ${sql(
      paidInvoices.map((invoice, index) => ({
        id: uuid(),
        school_id: schoolId,
        student_id: invoice.studentId,
        currency_id: currencyId,
        erpnext_docname: `ACC-PE-2026-${String(index + 1).padStart(5, "0")}`,
        erpnext_status: "Submitted",
        amount_minor: invoice.total,
        payment_date: "2026-07-05",
        last_synced_at: lastSyncedAt,
      })),
      "id",
      "school_id",
      "student_id",
      "currency_id",
      "erpnext_docname",
      "erpnext_status",
      "amount_minor",
      "payment_date",
      "last_synced_at",
    )}
  `;

  await sql`
    INSERT INTO app.fee_schedule_cache ${sql({
      id: uuid(),
      school_id: schoolId,
      academic_year_id: academicYearId,
      term_id: terms[0]!.id,
      currency_id: currencyId,
      erpnext_docname: "EDU-FS-2026-00001",
      erpnext_status: "Submitted",
      title: "Term 1 Tuition",
      total_amount_minor: 500_000,
      last_synced_at: lastSyncedAt,
    })}
  `;

  // Identity crosswalk for the cached invoices.
  await sql`
    INSERT INTO app.erpnext_id_mappings ${sql(
      invoices.map((invoice) => ({
        id: uuid(),
        school_id: schoolId,
        entity: "invoice",
        studafy_id: invoice.id,
        erpnext_docname: invoice.docname,
      })),
      "id",
      "school_id",
      "entity",
      "studafy_id",
      "erpnext_docname",
    )}
  `;
}
