import { Button, DataGrid, useCursorPagination } from "@studafy/ui";
import { useCallback } from "react";
import { Link } from "react-router-dom";

import { useFormatters, useTranslation } from "../../../lib/i18n";

import { invoiceBatchStatusLabel, invoiceBatchStatusTone } from "./labels";
import { fetchInvoiceBatchesPage } from "./queries";

import "./invoices.css";

import type { InvoiceBatch } from "./queries";
import type { DataGridColumn } from "@studafy/ui";

/**
 * Past invoice batch runs (`/portal/finance/invoices/batches`), gated by `billing:read`, newest
 * first. Each opens its own page with the per-student results, so a run started yesterday, or one
 * where some students failed, can be found again after leaving the batch page.
 */
export default function InvoiceBatchHistoryPage() {
  const { t } = useTranslation();
  const { formatDate } = useFormatters();
  const fetchPage = useCallback(
    (cursor: string | undefined) => fetchInvoiceBatchesPage(cursor),
    [],
  );
  const { items, loading, error, hasNextPage, hasPreviousPage, goToNextPage, goToPreviousPage } =
    useCursorPagination(fetchPage);

  const columns: DataGridColumn<InvoiceBatch>[] = [
    {
      id: "created_at",
      header: t("finance.invoices.history.started"),
      renderCell: (row) => (
        <Link to={`/portal/finance/invoices/batches/${row.id}`}>
          {formatDate(new Date(row.created_at), { dateStyle: "medium", timeStyle: "short" })}
        </Link>
      ),
    },
    {
      id: "period",
      header: t("finance.invoices.history.period"),
      renderCell: (row) => row.period_title,
    },
    {
      id: "structure",
      header: t("finance.invoices.history.feeStructure"),
      renderCell: (row) => row.fee_structure_erpnext_name,
    },
    {
      id: "status",
      header: t("finance.common.status"),
      renderCell: (row) => (
        <span className="invoices-status-pill" data-tone={invoiceBatchStatusTone(row.status)}>
          {invoiceBatchStatusLabel(row.status, t)}
        </span>
      ),
    },
    {
      id: "counts",
      header: t("finance.invoices.history.results"),
      renderCell: (row) =>
        t("finance.invoices.history.counts", {
          succeeded: row.succeeded_count,
          total: row.total_count,
          failed: row.failed_count,
        }),
    },
  ];

  return (
    <>
      <div className="invoices-list__header">
        <div>
          <h1>{t("finance.invoices.history.title")}</h1>
          <p>{t("finance.invoices.history.intro")}</p>
        </div>
        <Link to="/portal/finance/invoices/batches/new">
          <Button variant="secondary">{t("finance.invoices.list.generate")}</Button>
        </Link>
      </div>

      <DataGrid
        caption={t("finance.invoices.history.caption")}
        columns={columns}
        rows={items}
        getRowId={(row) => row.id}
        getRowLabel={(row) => row.period_title}
        loading={loading}
        empty={
          error ? t("finance.invoices.history.loadError") : t("finance.invoices.history.empty")
        }
      />

      <div className="invoices-list__pagination">
        <Button variant="secondary" disabled={!hasPreviousPage} onClick={goToPreviousPage}>
          {t("finance.common.previous")}
        </Button>
        <Button variant="secondary" disabled={!hasNextPage} onClick={goToNextPage}>
          {t("finance.common.next")}
        </Button>
      </div>
    </>
  );
}
