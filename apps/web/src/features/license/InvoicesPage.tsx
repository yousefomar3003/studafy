import { Select, Table } from "@studafy/ui";
import { useState } from "react";
import { Link } from "react-router-dom";

import { useFormatters, useTranslation } from "../../lib/i18n";
import { useMoney } from "../platform/licensing/format";

import { LicenseHeader } from "./LicenseHeader";
import { useInvoicesQuery, usePaymentsQuery } from "./queries";

import type { InvoiceFilter, InvoiceListItem } from "./queries";

import "./license.css";

const FILTERS: readonly InvoiceFilter[] = ["all", "unpaid", "overdue", "paid", "void"];

export function InvoiceStatusPill({
  invoice,
}: {
  invoice: Pick<InvoiceListItem, "status" | "overdue">;
}) {
  const { t } = useTranslation();
  if (invoice.overdue) {
    return (
      <span className="license-pill" data-tone="danger">
        {t("schoolLicense.invoiceStatus.overdue")}
      </span>
    );
  }
  const tone =
    invoice.status === "paid" ? "success" : invoice.status === "void" ? undefined : "warning";
  return (
    <span className="license-pill" data-tone={tone}>
      {t(`schoolLicense.invoiceStatus.${invoice.status}`)}
    </span>
  );
}

/**
 * Invoices and payments (`/portal/license/invoices`): every license invoice with its due date and
 * balance, and the history of payments Studafy recorded. An invoice opens on its own page with how
 * to pay it and where to upload the transfer receipt.
 */
export default function InvoicesPage() {
  const { t } = useTranslation();
  const { formatDate } = useFormatters();
  const money = useMoney();
  const [filter, setFilter] = useState<InvoiceFilter>("all");
  const invoices = useInvoicesQuery(filter);
  const payments = usePaymentsQuery();
  const date = (iso: string) => formatDate(new Date(iso), { dateStyle: "medium" });

  return (
    <>
      <LicenseHeader
        title={t("schoolLicense.invoices.title")}
        description={t("schoolLicense.invoices.description")}
      />
      <div className="license-toolbar">
        <Select
          label={t("schoolLicense.invoices.filter")}
          value={filter}
          onChange={setFilter}
          options={FILTERS.map((value) => ({
            value,
            label: t(`schoolLicense.invoiceFilter.${value}`),
          }))}
        />
      </div>
      <Table caption={t("schoolLicense.invoices.listTitle")} hideCaption>
        <Table.Header>
          <Table.Row>
            <Table.HeaderCell>{t("schoolLicense.invoices.columns.number")}</Table.HeaderCell>
            <Table.HeaderCell>{t("schoolLicense.invoices.columns.issued")}</Table.HeaderCell>
            <Table.HeaderCell>{t("schoolLicense.invoices.columns.due")}</Table.HeaderCell>
            <Table.HeaderCell>{t("schoolLicense.invoices.columns.total")}</Table.HeaderCell>
            <Table.HeaderCell>{t("schoolLicense.invoices.columns.balance")}</Table.HeaderCell>
            <Table.HeaderCell>{t("schoolLicense.invoices.columns.status")}</Table.HeaderCell>
          </Table.Row>
        </Table.Header>
        <Table.Body
          columnCount={6}
          loading={invoices.isPending}
          empty={
            invoices.isError
              ? t("schoolLicense.common.loadError")
              : t("schoolLicense.invoices.empty")
          }
        >
          {(invoices.data ?? []).map((invoice) => (
            <Table.Row key={invoice.id}>
              <Table.Cell>
                <Link to={`/portal/license/invoices/${invoice.id}`}>{invoice.number}</Link>
              </Table.Cell>
              <Table.Cell>{date(invoice.issueDate)}</Table.Cell>
              <Table.Cell>{date(invoice.dueDate)}</Table.Cell>
              <Table.Cell>
                <span className="license-amount">
                  {money(invoice.totalMinor, invoice.currencyCode, invoice.minorUnit)}
                </span>
              </Table.Cell>
              <Table.Cell>
                <span className="license-amount">
                  {money(invoice.balanceMinor, invoice.currencyCode, invoice.minorUnit)}
                </span>
              </Table.Cell>
              <Table.Cell>
                <InvoiceStatusPill invoice={invoice} />
              </Table.Cell>
            </Table.Row>
          ))}
        </Table.Body>
      </Table>

      <section className="license-section" aria-labelledby="license-payments">
        <h2 id="license-payments">{t("schoolLicense.payments.title")}</h2>
        <PaymentsTable
          payments={payments.data ?? []}
          loading={payments.isPending}
          error={payments.isError}
        />
      </section>
    </>
  );
}

export function PaymentsTable({
  payments,
  loading = false,
  error = false,
}: {
  payments: readonly {
    id: string;
    receivedAt: string;
    bankReference: string;
    amountMinor: number;
    currencyCode: string;
    voidedAt: string | null;
    voidReason: string | null;
  }[];
  loading?: boolean;
  error?: boolean;
}) {
  const { t } = useTranslation();
  const { formatDate } = useFormatters();
  const money = useMoney();
  return (
    <Table caption={t("schoolLicense.payments.title")} hideCaption>
      <Table.Header>
        <Table.Row>
          <Table.HeaderCell>{t("schoolLicense.payments.columns.received")}</Table.HeaderCell>
          <Table.HeaderCell>{t("schoolLicense.payments.columns.reference")}</Table.HeaderCell>
          <Table.HeaderCell>{t("schoolLicense.payments.columns.amount")}</Table.HeaderCell>
          <Table.HeaderCell>{t("schoolLicense.payments.columns.status")}</Table.HeaderCell>
        </Table.Row>
      </Table.Header>
      <Table.Body
        columnCount={4}
        loading={loading}
        empty={error ? t("schoolLicense.common.loadError") : t("schoolLicense.payments.empty")}
      >
        {payments.map((payment) => (
          <Table.Row key={payment.id}>
            <Table.Cell>
              {formatDate(new Date(payment.receivedAt), { dateStyle: "medium" })}
            </Table.Cell>
            <Table.Cell>{payment.bankReference}</Table.Cell>
            <Table.Cell>
              <span className="license-amount">
                {money(payment.amountMinor, payment.currencyCode)}
              </span>
            </Table.Cell>
            <Table.Cell>
              {payment.voidedAt
                ? t("schoolLicense.payments.voided", { reason: payment.voidReason ?? "" })
                : t("schoolLicense.payments.recorded")}
            </Table.Cell>
          </Table.Row>
        ))}
      </Table.Body>
    </Table>
  );
}
