import { DataGrid } from "@studafy/ui";
import { useQuery } from "@tanstack/react-query";
import { Link, useParams } from "react-router-dom";

import { useFormatters, useTranslation } from "../../../lib/i18n";
import { REFUND_KIND_LABEL_KEYS, REFUND_STATUS_LABEL_KEYS } from "../adjustments/labels";
import { fetchStudentRefunds } from "../adjustments/queries";
import { invoiceStatusLabel, invoiceStatusTone } from "../invoices/labels";
import { PAYMENT_MODE_LABEL_KEYS, PAYMENT_STATUS_LABEL_KEYS, paymentStatusTone } from "../labels";
import { fetchPaymentsPage } from "../payments/queries";

import {
  fetchFinanceStudent,
  fetchStudentInstallments,
  fetchStudentInvoices,
  financeStudentQueryKey,
} from "./queries";

import "./student-finance.css";

import type { Installment } from "./queries";
import type { Refund } from "../adjustments/queries";
import type { Invoice } from "../invoices/queries";
import type { PaymentListItem } from "../queries";
import type { DataGridColumn } from "@studafy/ui";

/** Outstanding per currency over invoices still owed (not drafts, not cancelled). */
function outstandingByCurrency(invoices: readonly Invoice[]): string {
  const sums = new Map<string, { minor: number; unit: number }>();
  for (const invoice of invoices) {
    if (invoice.erpnext_status !== "submitted") continue;
    const sum = sums.get(invoice.currency) ?? { minor: 0, unit: invoice.currency_minor_unit };
    sum.minor += invoice.outstanding_amount_minor;
    sums.set(invoice.currency, sum);
  }
  if (sums.size === 0) return "0";
  return [...sums.entries()]
    .map(([currency, sum]) => `${(sum.minor / 10 ** sum.unit).toFixed(sum.unit)} ${currency}`)
    .join(" · ");
}

/**
 * One student's account (`/portal/finance/students/:studentId`), gated by `billing:read`: what
 * they owe, their invoices, installment plan, payments, and every refund or correction asked for
 * them. Identity comes from the finance student endpoint, so finance staff (no `student:read`)
 * can open it; a withdrawn student's account still opens, since a balance may still be owed.
 */
export default function StudentFinancePage() {
  const { t } = useTranslation();
  const { formatDate } = useFormatters();
  const { studentId = "" } = useParams<{ studentId: string }>();
  const enabled = studentId !== "";

  const student = useQuery({
    queryKey: financeStudentQueryKey(studentId),
    queryFn: () => fetchFinanceStudent(studentId),
    enabled,
  });
  const invoices = useQuery({
    queryKey: [...financeStudentQueryKey(studentId), "invoices"],
    queryFn: () => fetchStudentInvoices(studentId),
    enabled,
  });
  const installments = useQuery({
    queryKey: [...financeStudentQueryKey(studentId), "installments"],
    queryFn: () => fetchStudentInstallments(studentId),
    enabled,
  });
  const payments = useQuery({
    queryKey: ["finance", "payments", "list", "student", studentId],
    queryFn: () => fetchPaymentsPage({ status: "", studentId }, 0),
    enabled,
  });
  const corrections = useQuery({
    queryKey: ["finance", "adjustments", "refunds", "student", studentId],
    queryFn: () => fetchStudentRefunds(studentId),
    enabled,
  });

  if (student.isPending) return <p role="status">{t("finance.common.loading")}</p>;
  if (student.isError) return <p role="alert">{t("finance.studentAccount.loadError")}</p>;
  const identity = student.data;

  const invoiceColumns: DataGridColumn<Invoice>[] = [
    {
      id: "number",
      header: t("finance.invoices.list.invoiceNumber"),
      renderCell: (row) => (
        <Link to={`/portal/finance/invoices/${row.id}`}>{row.erpnext_docname}</Link>
      ),
    },
    {
      id: "status",
      header: t("finance.common.status"),
      renderCell: (row) => (
        <span className="student-finance__pill" data-tone={invoiceStatusTone(row.erpnext_status)}>
          {invoiceStatusLabel(row.erpnext_status, t)}
        </span>
      ),
    },
    {
      id: "total",
      header: t("finance.common.total"),
      align: "end",
      renderCell: (row) => `${row.total_amount} ${row.currency}`,
    },
    {
      id: "outstanding",
      header: t("finance.common.outstanding"),
      align: "end",
      renderCell: (row) => `${row.outstanding_amount} ${row.currency}`,
    },
    { id: "due", header: t("finance.common.due"), renderCell: (row) => row.due_date ?? "—" },
  ];

  const installmentColumns: DataGridColumn<Installment>[] = [
    { id: "due", header: t("finance.common.due"), renderCell: (row) => row.due_date },
    {
      id: "total",
      header: t("finance.common.total"),
      align: "end",
      renderCell: (row) => `${row.total_amount} ${row.currency}`,
    },
    {
      id: "outstanding",
      header: t("finance.common.outstanding"),
      align: "end",
      renderCell: (row) => `${row.outstanding_amount} ${row.currency}`,
    },
    {
      id: "status",
      header: t("finance.common.status"),
      renderCell: (row) => t(`finance.studentAccount.installmentStatus.${row.status}`),
    },
  ];

  const paymentColumns: DataGridColumn<PaymentListItem>[] = [
    { id: "date", header: t("finance.common.date"), renderCell: (row) => row.payment_date },
    {
      id: "invoice",
      header: t("finance.common.invoice"),
      renderCell: (row) => row.erpnext_invoice_id ?? "—",
    },
    {
      id: "amount",
      header: t("finance.common.amount"),
      align: "end",
      renderCell: (row) => `${row.amount} ${row.currency}`,
    },
    {
      id: "method",
      header: t("finance.common.method"),
      renderCell: (row) => (row.payment_mode ? t(PAYMENT_MODE_LABEL_KEYS[row.payment_mode]) : "—"),
    },
    {
      id: "status",
      header: t("finance.common.status"),
      renderCell: (row) => (
        <span className="student-finance__pill" data-tone={paymentStatusTone(row.status)}>
          {t(PAYMENT_STATUS_LABEL_KEYS[row.status])}
        </span>
      ),
    },
  ];

  const correctionColumns: DataGridColumn<Refund>[] = [
    {
      id: "created",
      header: t("finance.common.date"),
      renderCell: (row) => (
        <Link to={`/portal/finance/adjustments/refunds/${row.id}`}>
          {formatDate(new Date(row.created_at))}
        </Link>
      ),
    },
    {
      id: "kind",
      header: t("finance.studentAccount.kind"),
      renderCell: (row) => t(REFUND_KIND_LABEL_KEYS[row.kind]),
    },
    {
      id: "invoice",
      header: t("finance.common.invoice"),
      renderCell: (row) => row.erpnext_invoice_id,
    },
    {
      id: "amount",
      header: t("finance.common.amount"),
      align: "end",
      renderCell: (row) => `${row.amount} ${row.currency}`,
    },
    {
      id: "status",
      header: t("finance.common.status"),
      renderCell: (row) => t(REFUND_STATUS_LABEL_KEYS[row.status]),
    },
  ];

  return (
    <div className="student-finance">
      <div className="student-finance__header">
        <div>
          <h1>{identity.name}</h1>
          <p>
            {identity.admission_number}
            {identity.status !== "enrolled"
              ? ` · ${t(`finance.studentAccount.status.${identity.status}`, identity.status)}`
              : ""}
            {identity.family_id ? (
              <>
                {" · "}
                <Link to={`/portal/finance/families/${identity.family_id}`}>
                  {identity.family_name}
                </Link>
              </>
            ) : (
              <>
                {" · "}
                <Link to="/portal/finance/unlinked">{t("finance.studentAccount.noFamily")}</Link>
              </>
            )}
          </p>
        </div>
        <dl className="student-finance__balance">
          <dt>{t("finance.studentAccount.owed")}</dt>
          <dd>{invoices.data ? outstandingByCurrency(invoices.data) : "…"}</dd>
        </dl>
      </div>

      <section aria-label={t("finance.studentAccount.invoices")}>
        <h2>{t("finance.studentAccount.invoices")}</h2>
        <DataGrid
          caption={t("finance.studentAccount.invoices")}
          columns={invoiceColumns}
          rows={invoices.data ?? []}
          getRowId={(row) => row.id}
          getRowLabel={(row) => row.erpnext_docname}
          loading={invoices.isPending}
          empty={
            invoices.isError
              ? t("finance.invoices.list.loadError")
              : t("finance.studentAccount.noInvoices")
          }
        />
      </section>

      <section aria-label={t("finance.studentAccount.installments")}>
        <h2>{t("finance.studentAccount.installments")}</h2>
        <DataGrid
          caption={t("finance.studentAccount.installments")}
          columns={installmentColumns}
          rows={installments.data ?? []}
          getRowId={(row) => row.id}
          getRowLabel={(row) => row.due_date}
          loading={installments.isPending}
          empty={
            installments.isError
              ? t("finance.studentAccount.installmentsError")
              : t("finance.studentAccount.noInstallments")
          }
        />
      </section>

      <section aria-label={t("finance.studentAccount.payments")}>
        <h2>{t("finance.studentAccount.payments")}</h2>
        <DataGrid
          caption={t("finance.studentAccount.payments")}
          columns={paymentColumns}
          rows={payments.data?.items ?? []}
          getRowId={(row) => row.id}
          getRowLabel={(row) => row.payment_date}
          loading={payments.isPending}
          empty={
            payments.isError
              ? t("finance.payments.list.loadError")
              : t("finance.studentAccount.noPayments")
          }
        />
      </section>

      <section aria-label={t("finance.studentAccount.corrections")}>
        <h2>{t("finance.studentAccount.corrections")}</h2>
        <DataGrid
          caption={t("finance.studentAccount.corrections")}
          columns={correctionColumns}
          rows={corrections.data ?? []}
          getRowId={(row) => row.id}
          getRowLabel={(row) => row.erpnext_invoice_id}
          loading={corrections.isPending}
          empty={
            corrections.isError
              ? t("finance.studentAccount.correctionsError")
              : t("finance.studentAccount.noCorrections")
          }
        />
      </section>
    </div>
  );
}
