import { Button, Card, DataGrid } from "@studafy/ui";
import { useQuery } from "@tanstack/react-query";
import { useState } from "react";

import { api } from "../../../lib/api";
import { buildCsv, downloadCsv } from "../../../lib/csv";
import { useTranslation } from "../../../lib/i18n";
import { PAYMENT_MODE_LABEL_KEYS } from "../labels";

import type { components } from "@studafy/api-client";
import type { DataGridColumn } from "@studafy/ui";
import type { FormEvent } from "react";

type Report = components["schemas"]["CollectionsByMethodReport"];
type Mode = "cash" | "bank_transfer" | "card_external" | "other";

const MODES: Mode[] = ["cash", "bank_transfer", "card_external", "other"];

interface PivotRow {
  key: string;
  label: string;
  currency: string;
  byMode: Record<Mode, number>;
  total: number;
  unit: number;
}

function today(): string {
  return new Date().toISOString().slice(0, 10);
}

/** Minor units at the currency's precision, from the decimal strings the API sends. */
function decimals(amount: string): number {
  return amount.split(".")[1]?.length ?? 0;
}

/** One row per day and currency, a column per method: the shape a cash-up sheet has. */
export function pivotCollections(
  rows: Report["rows"] | Report["totals"],
  labelOf: (row: Report["rows"][number] | Report["totals"][number]) => string,
): PivotRow[] {
  const pivot = new Map<string, PivotRow>();
  for (const row of rows) {
    const label = labelOf(row);
    const key = `${label}:${row.currency}`;
    const entry = pivot.get(key) ?? {
      key,
      label,
      currency: row.currency,
      byMode: { cash: 0, bank_transfer: 0, card_external: 0, other: 0 },
      total: 0,
      unit: decimals(row.amount),
    };
    entry.byMode[row.payment_mode ?? "other"] += row.amount_minor;
    entry.total += row.amount_minor;
    pivot.set(key, entry);
  }
  return [...pivot.values()];
}

function money(minor: number, unit: number, currency: string): string {
  return `${(minor / 10 ** unit).toFixed(unit)} ${currency}`;
}

/**
 * Money received per day and payment method (`GET /api/finance/reports/collections-by-method`),
 * from Studafy's own confirmed payments, so it runs while ERPNext is down. Defaults to today: the
 * daily cash-up. The CSV is built in the browser from the same rows the table shows.
 */
export default function CollectionsByMethodReportPanel() {
  const { t } = useTranslation();
  const [fromDate, setFromDate] = useState(today);
  const [toDate, setToDate] = useState(today);
  const [run, setRun] = useState<{ from: string; to: string } | null>(null);

  const query = useQuery({
    queryKey: ["finance", "reports", "collections-by-method", run?.from, run?.to],
    queryFn: async () => {
      const { data } = await api.GET("/api/finance/reports/collections-by-method", {
        params: { query: { from_date: run!.from, to_date: run!.to } },
      });
      if (!data) throw new Error("The report returned no data.");
      return data as Report;
    },
    enabled: run !== null,
  });

  const canRun = fromDate !== "" && toDate !== "" && fromDate <= toDate;
  const days = query.data
    ? pivotCollections(query.data.rows, (row) => ("date" in row ? row.date : ""))
    : [];
  const totals = query.data
    ? pivotCollections(query.data.totals, () =>
        t("financeReports.reports.collectionsByMethod.total"),
      )
    : [];
  const modeLabel = (mode: Mode) =>
    mode === "other"
      ? t("financeReports.reports.collectionsByMethod.other")
      : t(PAYMENT_MODE_LABEL_KEYS[mode]);

  const columns: DataGridColumn<PivotRow>[] = [
    {
      id: "day",
      header: t("financeReports.reports.collectionsByMethod.day"),
      renderCell: (row) => row.label,
    },
    ...MODES.map((mode): DataGridColumn<PivotRow> => ({
      id: mode,
      header: modeLabel(mode),
      align: "end",
      renderCell: (row) => money(row.byMode[mode], row.unit, row.currency),
    })),
    {
      id: "total",
      header: t("financeReports.reports.collectionsByMethod.total"),
      align: "end",
      renderCell: (row) => money(row.total, row.unit, row.currency),
    },
  ];

  function handleSubmit(event: FormEvent) {
    event.preventDefault();
    if (canRun) setRun({ from: fromDate, to: toDate });
  }

  function handleDownload() {
    if (!query.data || !run) return;
    const header = [
      t("financeReports.reports.collectionsByMethod.day"),
      t("finance.common.currency"),
      ...MODES.map(modeLabel),
      t("financeReports.reports.collectionsByMethod.total"),
    ];
    const lines = [...days, ...totals].map((row) => [
      row.label,
      row.currency,
      ...MODES.map((mode) => (row.byMode[mode] / 10 ** row.unit).toFixed(row.unit)),
      (row.total / 10 ** row.unit).toFixed(row.unit),
    ]);
    downloadCsv(`collections-${run.from}-${run.to}.csv`, buildCsv(header, lines));
  }

  return (
    <Card as="section" aria-label={t("financeReports.reports.center.tabs.collectionsByMethod")}>
      <Card.Body>
        <p>{t("financeReports.reports.collectionsByMethod.description")}</p>

        <form className="reports-panel__filters" onSubmit={handleSubmit}>
          <div className="sf-field">
            <label htmlFor="cbm-from-date">{t("financeReports.reports.filters.fromDate")}</label>
            <input
              id="cbm-from-date"
              type="date"
              value={fromDate}
              max={toDate || undefined}
              onChange={(event) => setFromDate(event.target.value)}
              required
            />
          </div>
          <div className="sf-field">
            <label htmlFor="cbm-to-date">{t("financeReports.reports.filters.toDate")}</label>
            <input
              id="cbm-to-date"
              type="date"
              value={toDate}
              min={fromDate || undefined}
              onChange={(event) => setToDate(event.target.value)}
              required
            />
          </div>
          <Button type="submit" loading={query.isFetching} disabled={!canRun}>
            {t("financeReports.reports.filters.runReport")}
          </Button>
        </form>

        {run === null ? (
          <p className="reports-panel__idle">
            {t("financeReports.reports.collectionsByMethod.idle")}
          </p>
        ) : query.isError ? (
          <p className="reports-panel__error" role="alert">
            {t("financeReports.reports.collectionsByMethod.error")}
          </p>
        ) : query.data && days.length === 0 ? (
          <p className="reports-panel__idle">
            {t("financeReports.reports.collectionsByMethod.empty")}
          </p>
        ) : query.data ? (
          <div className="reports-panel__results">
            <DataGrid
              caption={t("financeReports.reports.collectionsByMethod.caption")}
              columns={columns}
              rows={[...days, ...totals]}
              getRowId={(row) => row.key}
              getRowLabel={(row) => row.label}
              empty={t("financeReports.reports.collectionsByMethod.empty")}
            />
            <div>
              <Button type="button" variant="secondary" onClick={handleDownload}>
                {t("financeReports.reports.collectionsByMethod.download")}
              </Button>
            </div>
          </div>
        ) : null}
      </Card.Body>
    </Card>
  );
}
