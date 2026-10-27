import { Card, Input, Select } from "@studafy/ui";
import { useState } from "react";
import { Link } from "react-router-dom";

import { useFormatters, useTranslation } from "../../../lib/i18n";
import { PlatformPageHeader } from "../PlatformNav";
import { useSchoolsListQuery } from "../queries";

import { useMoney } from "./format";
import { useInvoicesQuery, useLicenseFinanceQuery, usePendingReceiptsQuery } from "./queries";
import { useDebounced } from "./useDebounced";

import "../platform.css";
import "./licensing.css";

import type { InvoiceFilter, InvoiceListFilters, InvoiceListItem } from "./queries";

const FILTERS: readonly InvoiceFilter[] = [
  "all",
  "unpaid",
  "partially_paid",
  "overdue",
  "issued",
  "paid",
  "void",
];

/**
 * License payments (`/portal/platform/payments`): this month's receipts, what is outstanding and
 * overdue, the transfer receipts schools uploaded that wait to be matched, and every invoice --
 * filtered by state, school and issue date. An invoice opens on its own page to record a transfer.
 */
export default function PaymentsPage() {
  const { t } = useTranslation();
  const [filters, setFilters] = useState<InvoiceListFilters>({
    status: "unpaid",
    schoolId: "",
    from: "",
    to: "",
  });
  const invoices = useInvoicesQuery(filters);
  // The school list is paged, so the picker searches it rather than listing every school.
  const [schoolSearch, setSchoolSearch] = useState("");
  const settledSearch = useDebounced(schoolSearch.trim(), 300);
  const schools = useSchoolsListQuery({ search: settledSearch, status: "", page: 0 });
  const [schoolName, setSchoolName] = useState("");
  const schoolOptions = (schools.data?.schools ?? []).map((school) => ({
    value: school.id,
    label: school.name,
  }));
  if (filters.schoolId && !schoolOptions.some((o) => o.value === filters.schoolId)) {
    schoolOptions.unshift({ value: filters.schoolId, label: schoolName });
  }

  return (
    <>
      <PlatformPageHeader
        title={t("platformLicensing.payments.title")}
        description={t("platformLicensing.payments.description")}
      />
      <FinanceTotals />
      <PendingReceipts />

      <section aria-labelledby="invoice-list">
        <h2 id="invoice-list">{t("platformLicensing.payments.invoicesTitle")}</h2>
        <div className="platform-toolbar licensing-form-grid">
          <Select
            label={t("platformLicensing.payments.statusFilter")}
            value={filters.status}
            onChange={(status) => setFilters((prev) => ({ ...prev, status }))}
            options={FILTERS.map((value) => ({
              value,
              label: t(`platformLicensing.invoiceFilter.${value}`),
            }))}
          />
          <Input
            label={t("platformLicensing.payments.schoolSearch")}
            type="search"
            value={schoolSearch}
            onChange={(event) => setSchoolSearch(event.target.value)}
          />
          <Select
            label={t("platformLicensing.payments.schoolFilter")}
            value={filters.schoolId}
            onChange={(schoolId) => {
              setSchoolName(schoolOptions.find((o) => o.value === schoolId)?.label ?? "");
              setFilters((prev) => ({ ...prev, schoolId }));
            }}
            options={[
              { value: "", label: t("platformLicensing.payments.allSchools") },
              ...schoolOptions,
            ]}
          />
          <Input
            label={t("platformLicensing.payments.fromFilter")}
            type="date"
            value={filters.from}
            onChange={(event) => setFilters((prev) => ({ ...prev, from: event.target.value }))}
          />
          <Input
            label={t("platformLicensing.payments.toFilter")}
            type="date"
            value={filters.to}
            onChange={(event) => setFilters((prev) => ({ ...prev, to: event.target.value }))}
          />
        </div>
        {invoices.isPending ? <p role="status">{t("site.common.loading")}</p> : null}
        {invoices.isError ? <p role="alert">{t("platformLicensing.common.loadError")}</p> : null}
        {invoices.data && invoices.data.length === 0 ? (
          <p className="platform-muted">{t("platformLicensing.payments.empty")}</p>
        ) : null}
        {invoices.data && invoices.data.length > 0 ? (
          <InvoiceTable invoices={invoices.data} />
        ) : null}
      </section>
    </>
  );
}

function FinanceTotals() {
  const { t } = useTranslation();
  const { formatNumber } = useFormatters();
  const money = useMoney();
  const finance = useLicenseFinanceQuery();
  if (!finance.data) return null;
  return (
    <section aria-labelledby="finance-totals">
      <h2 id="finance-totals" className="sf-visually-hidden">
        {t("platformLicensing.payments.totalsTitle")}
      </h2>
      {finance.data.totals.length === 0 ? (
        <p className="platform-muted">{t("platformLicensing.payments.noTotals")}</p>
      ) : null}
      {finance.data.totals.map((row) => (
        <div className="platform-stats" key={row.currencyCode}>
          <div className="platform-stat">
            <span className="platform-stat__label">
              {t("platformLicensing.payments.receivedThisMonth", { currency: row.currencyCode })}
            </span>
            <span className="platform-stat__value">
              {money(row.receivedThisMonthMinor, row.currencyCode, row.minorUnit)}
            </span>
          </div>
          <div className="platform-stat">
            <span className="platform-stat__label">
              {t("platformLicensing.payments.outstanding", { count: row.unpaidInvoices })}
            </span>
            <span className="platform-stat__value">
              {money(row.outstandingMinor, row.currencyCode, row.minorUnit)}
            </span>
          </div>
          <div className="platform-stat">
            <span className="platform-stat__label">
              {t("platformLicensing.payments.overdue", { count: row.overdueInvoices })}
            </span>
            <span className="platform-stat__value">
              {money(row.overdueMinor, row.currencyCode, row.minorUnit)}
            </span>
          </div>
        </div>
      ))}
      <p className="platform-muted">
        {t("platformLicensing.payments.pendingCount", {
          count: finance.data.pendingReceipts,
          formatted: formatNumber(finance.data.pendingReceipts),
        })}
      </p>
    </section>
  );
}

/** Receipts the schools uploaded, oldest first; each opens its invoice to match it. */
function PendingReceipts() {
  const { t } = useTranslation();
  const { formatDate } = useFormatters();
  const money = useMoney();
  const receipts = usePendingReceiptsQuery();
  if (!receipts.data || receipts.data.length === 0) return null;
  return (
    <Card as="section" aria-labelledby="pending-receipts">
      <Card.Header>
        <h2 id="pending-receipts">{t("platformLicensing.payments.receiptsTitle")}</h2>
      </Card.Header>
      <Card.Body>
        <ul
          className="licensing-history"
          aria-label={t("platformLicensing.payments.receiptsTitle")}
        >
          {receipts.data.map((receipt) => (
            <li key={receipt.id}>
              <div className="platform-cell-stack">
                <span>
                  {receipt.schoolName} · {receipt.invoiceNumber}
                </span>
                <span className="platform-muted">
                  {receipt.fileName} ·{" "}
                  {formatDate(new Date(receipt.createdAt), { dateStyle: "medium" })}
                  {receipt.note ? ` · “${receipt.note}”` : ""}
                </span>
                <span className="platform-muted">
                  {t("platformLicensing.payments.balanceDue", {
                    amount: money(receipt.invoiceBalanceMinor, receipt.currencyCode),
                  })}
                </span>
              </div>
              <Link to={`/portal/platform/payments/${receipt.schoolId}/${receipt.invoiceId}`}>
                {t("platformLicensing.payments.matchReceipt")}
              </Link>
            </li>
          ))}
        </ul>
      </Card.Body>
    </Card>
  );
}

function InvoiceTable({ invoices }: { invoices: InvoiceListItem[] }) {
  const { t } = useTranslation();
  const { formatDate } = useFormatters();
  const money = useMoney();
  return (
    <table className="platform-table">
      <caption className="sf-visually-hidden">
        {t("platformLicensing.payments.invoicesTitle")}
      </caption>
      <thead>
        <tr>
          <th scope="col">{t("platformLicensing.payments.columns.number")}</th>
          <th scope="col">{t("platformLicensing.payments.columns.school")}</th>
          <th scope="col">{t("platformLicensing.payments.columns.issued")}</th>
          <th scope="col">{t("platformLicensing.payments.columns.due")}</th>
          <th scope="col">{t("platformLicensing.payments.columns.total")}</th>
          <th scope="col">{t("platformLicensing.payments.columns.balance")}</th>
          <th scope="col">{t("platformLicensing.payments.columns.status")}</th>
        </tr>
      </thead>
      <tbody>
        {invoices.map((invoice) => (
          <tr key={invoice.id}>
            <td>
              <Link to={`/portal/platform/payments/${invoice.schoolId}/${invoice.id}`}>
                {invoice.number}
              </Link>
            </td>
            <td>{invoice.schoolName}</td>
            <td>{formatDate(new Date(invoice.issueDate), { dateStyle: "medium" })}</td>
            <td>{formatDate(new Date(invoice.dueDate), { dateStyle: "medium" })}</td>
            <td className="licensing-amount">
              {money(invoice.totalMinor, invoice.currencyCode, invoice.minorUnit)}
            </td>
            <td className="licensing-amount">
              {money(invoice.balanceMinor, invoice.currencyCode, invoice.minorUnit)}
            </td>
            <td>
              <InvoiceStatusPill status={invoice.status} overdue={invoice.overdue} />
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

export function InvoiceStatusPill({
  status,
  overdue,
}: {
  status: InvoiceListItem["status"];
  overdue: boolean;
}) {
  const { t } = useTranslation();
  return (
    <span className="platform-cell-stack">
      <span className="platform-pill" data-status={status}>
        {t(`platformLicensing.invoiceStatus.${status}`)}
      </span>
      {overdue ? (
        <span className="platform-pill" data-status="overdue">
          {t("platformLicensing.invoiceStatus.overdue")}
        </span>
      ) : null}
    </span>
  );
}
