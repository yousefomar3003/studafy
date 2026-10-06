import { ApiError } from "@studafy/api-client";
import { PAGINATION_MAX_LIMIT } from "@studafy/shared-schemas";
import { Button, Card, DataGrid, Select, useToast } from "@studafy/ui";
import { keepPreviousData, useQuery } from "@tanstack/react-query";
import { useState } from "react";
import { Link } from "react-router-dom";

import { ExportCsvButton } from "../../../components/ExportCsvButton";
import { collectCursorPages } from "../../../lib/data-transfer";
import { useTranslation } from "../../../lib/i18n";
import { fetchActiveClasses } from "../../admin/announcements/queries";
import { fetchFeeStructures } from "../fees/queries";

import {
  invoiceBatchItemStatusLabel,
  invoiceBatchItemStatusTone,
  invoiceBatchStatusLabel,
} from "./labels";
import { useCreateInvoiceBatch } from "./mutations";
import { fetchInvoiceBatch, fetchInvoiceBatchItemsPage, invoiceBatchQueryKey } from "./queries";

import "./invoices.css";

import type { InvoiceBatch, InvoiceBatchItem, InvoiceBatchItemStatus } from "./queries";
import type { ExportColumn } from "../../../lib/data-transfer";
import type { ClassOption } from "../../admin/announcements/queries";
import type { FeeStructure } from "../fees/queries";
import type { DataGridColumn, SelectOption } from "@studafy/ui";
import type { TFunction } from "i18next";
import type { FormEvent } from "react";

function apiErrorMessage(error: unknown, fallback: string): string {
  return error instanceof ApiError ? (error.detail ?? error.title) : fallback;
}

/**
 * Batch invoice generation (`/portal/finance/invoices/batches/new`), gated by `billing:update` —
 * the write gate `POST /api/finance/invoices/batches` itself requires. A small state machine keyed
 * on whether a batch has been created yet: the form (fee structure, period, due date, target), then
 * the progress panel once `useCreateInvoiceBatch` returns a batch id.
 */
export default function InvoiceBatchPage() {
  const { t } = useTranslation();
  const [batchId, setBatchId] = useState<string | null>(null);

  return (
    <>
      <p className="invoices-detail__back">
        <Link to="/portal/finance/invoices">{t("finance.invoices.backToInvoices")}</Link>
      </p>
      <h1>{t("finance.invoices.batch.title")}</h1>

      {batchId ? (
        <BatchProgress batchId={batchId} onReset={() => setBatchId(null)} />
      ) : (
        <BatchForm onCreated={setBatchId} />
      )}
    </>
  );
}

// ---------------------------------------------------------------------------
// Form
// ---------------------------------------------------------------------------

interface BatchFormProps {
  onCreated: (batchId: string) => void;
}

function BatchForm({ onCreated }: BatchFormProps) {
  const { t } = useTranslation();
  const { show } = useToast();
  const createBatch = useCreateInvoiceBatch();

  const feeStructuresQuery = useQuery({
    queryKey: ["finance", "fee-structures", "all"],
    queryFn: () => fetchFeeStructures(""),
  });
  const classesQuery = useQuery({
    queryKey: ["academics", "classes", "active"],
    queryFn: fetchActiveClasses,
  });

  const [feeStructureErpnextName, setFeeStructureErpnextName] = useState("");
  const [periodTitle, setPeriodTitle] = useState("");
  const [dueDate, setDueDate] = useState("");
  const [targetMode, setTargetMode] = useState<"all" | "classes">("all");
  const [selectedClassIds, setSelectedClassIds] = useState<Set<string>>(new Set());

  // Only a submitted structure has confirmed components ERPNext will actually invoice against — a
  // draft is still editable and a cancelled one is dead, matching `feeStructureStatusTone`'s own
  // "only draft is editable" note in `../fees/labels.ts`.
  const structures = (feeStructuresQuery.data ?? []).filter(
    (structure: FeeStructure) => structure.erpnext_status === "submitted",
  );
  const structureOptions: SelectOption<string>[] = [
    {
      value: "",
      label: structuresPlaceholder(feeStructuresQuery.isPending, structures.length, t),
    },
    ...structures.map((structure) => ({
      value: structure.erpnext_name,
      label: `${structure.title} (${structure.total_amount} ${structure.currency})`,
    })),
  ];

  const classes = (classesQuery.data ?? []) as ClassOption[];

  function toggleClass(classId: string) {
    setSelectedClassIds((current) => {
      const next = new Set(current);
      if (next.has(classId)) next.delete(classId);
      else next.add(classId);
      return next;
    });
  }

  const canSubmit =
    feeStructureErpnextName !== "" &&
    periodTitle.trim() !== "" &&
    (targetMode === "all" || selectedClassIds.size > 0);

  function handleSubmit(event: FormEvent) {
    event.preventDefault();
    if (!canSubmit) return;

    createBatch.mutate(
      {
        fee_structure_erpnext_name: feeStructureErpnextName,
        period_title: periodTitle.trim(),
        due_date: dueDate || undefined,
        target_class_ids: targetMode === "classes" ? Array.from(selectedClassIds) : undefined,
      },
      {
        onSuccess: (batch) => onCreated(batch.id),
        onError: (error) => {
          show({
            variant: "error",
            title: t("finance.invoices.batch.startError"),
            description: apiErrorMessage(error, t("finance.common.checkFormAndRetry")),
          });
        },
      },
    );
  }

  return (
    <Card as="section" aria-label={t("finance.invoices.batch.formLabel")}>
      <Card.Body>
        <form onSubmit={handleSubmit} className="invoices-batch__form">
          <Select
            label={t("finance.invoices.batch.feeStructure")}
            options={structureOptions}
            value={feeStructureErpnextName}
            onChange={setFeeStructureErpnextName}
            disabled={feeStructuresQuery.isPending}
            required
          />

          <div className="sf-field">
            <label htmlFor="invoice-batch-period">{t("finance.invoices.batch.periodTitle")}</label>
            <input
              id="invoice-batch-period"
              type="text"
              value={periodTitle}
              onChange={(event) => setPeriodTitle(event.target.value)}
              placeholder={t("finance.invoices.batch.periodPlaceholder")}
              maxLength={200}
              required
            />
          </div>

          <div className="sf-field">
            <label htmlFor="invoice-batch-due-date">{t("finance.invoices.batch.dueDate")}</label>
            <input
              id="invoice-batch-due-date"
              type="date"
              value={dueDate}
              onChange={(event) => setDueDate(event.target.value)}
            />
          </div>

          <fieldset className="invoices-batch__target">
            <legend>{t("finance.invoices.batch.target")}</legend>
            <label className="invoices-batch__target-option">
              <input
                type="radio"
                name="invoice-batch-target-mode"
                checked={targetMode === "all"}
                onChange={() => setTargetMode("all")}
              />
              {t("finance.invoices.batch.targetAll")}
            </label>
            <label className="invoices-batch__target-option">
              <input
                type="radio"
                name="invoice-batch-target-mode"
                checked={targetMode === "classes"}
                onChange={() => setTargetMode("classes")}
              />
              {t("finance.invoices.batch.targetClasses")}
            </label>

            {targetMode === "classes" ? (
              <div
                className="invoices-batch__classes"
                role="group"
                aria-label={t("finance.invoices.batch.classes")}
              >
                {classesQuery.isPending ? (
                  <p>{t("finance.invoices.batch.loadingClasses")}</p>
                ) : classes.length === 0 ? (
                  <p>{t("finance.invoices.batch.noClasses")}</p>
                ) : (
                  classes.map((klass) => (
                    <label key={klass.id} className="invoices-batch__class-option">
                      <input
                        type="checkbox"
                        checked={selectedClassIds.has(klass.id)}
                        onChange={() => toggleClass(klass.id)}
                      />
                      {klass.code}
                    </label>
                  ))
                )}
              </div>
            ) : null}
          </fieldset>

          <div className="invoices-batch__form-actions">
            <Button type="submit" loading={createBatch.isPending} disabled={!canSubmit}>
              {t("finance.invoices.batch.start")}
            </Button>
          </div>
        </form>
      </Card.Body>
    </Card>
  );
}

function structuresPlaceholder(isPending: boolean, count: number, t: TFunction): string {
  if (isPending) return t("finance.invoices.batch.loadingStructures");
  if (count === 0) return t("finance.invoices.batch.noStructures");
  return t("finance.invoices.batch.selectStructure");
}

// ---------------------------------------------------------------------------
// Progress
// ---------------------------------------------------------------------------

interface BatchProgressProps {
  batchId: string;
  onReset: () => void;
}

/** Batches still being worked are polled every 3s, mirroring
 * `admin/invitations/BulkInviteProgressPanel` — this is what keeps a 1,000-student run cheap on
 * the client: the item table is cursor-paginated (20 rows at a time), never one giant list. */
const IN_FLIGHT_STATUSES = new Set<InvoiceBatch["status"]>(["pending", "processing"]);
const POLL_INTERVAL_MS = 3000;

function BatchProgress({ batchId, onReset }: BatchProgressProps) {
  const { t } = useTranslation();
  const [statusFilter, setStatusFilter] = useState<InvoiceBatchItemStatus | "">("");
  const [cursor, setCursor] = useState<string | undefined>(undefined);
  const [cursorHistory, setCursorHistory] = useState<(string | undefined)[]>([]);

  const batchQuery = useQuery({
    queryKey: invoiceBatchQueryKey(batchId),
    queryFn: () => fetchInvoiceBatch(batchId),
    refetchInterval: (query) =>
      query.state.data && IN_FLIGHT_STATUSES.has(query.state.data.status)
        ? POLL_INTERVAL_MS
        : false,
  });

  const itemsQuery = useQuery({
    queryKey: [...invoiceBatchQueryKey(batchId), "items", statusFilter, cursor],
    queryFn: () => fetchInvoiceBatchItemsPage(batchId, cursor, statusFilter),
    placeholderData: keepPreviousData,
    refetchInterval: () =>
      batchQuery.data && IN_FLIGHT_STATUSES.has(batchQuery.data.status) ? POLL_INTERVAL_MS : false,
  });

  const batch = batchQuery.data;
  const processed = batch
    ? batch.succeeded_count + batch.already_existed_count + batch.failed_count
    : 0;
  const progressPercent =
    batch && batch.total_count > 0 ? Math.round((processed / batch.total_count) * 100) : 0;

  const statusOptions: SelectOption<InvoiceBatchItemStatus | "">[] = [
    { value: "", label: t("finance.common.allStatuses") },
    { value: "pending", label: invoiceBatchItemStatusLabel("pending", t) },
    { value: "succeeded", label: invoiceBatchItemStatusLabel("succeeded", t) },
    { value: "already_existed", label: invoiceBatchItemStatusLabel("already_existed", t) },
    { value: "failed", label: invoiceBatchItemStatusLabel("failed", t) },
  ];

  const columns: DataGridColumn<InvoiceBatchItem>[] = [
    {
      id: "student_name",
      header: t("finance.common.student"),
      renderCell: (row) => row.student_name,
    },
    {
      id: "admission_number",
      header: t("finance.common.admissionNumber"),
      renderCell: (row) => row.admission_number,
    },
    {
      id: "status",
      header: t("finance.common.status"),
      renderCell: (row) => (
        <span className="invoices-status-pill" data-tone={invoiceBatchItemStatusTone(row.status)}>
          {invoiceBatchItemStatusLabel(row.status, t)}
        </span>
      ),
    },
    {
      id: "result",
      header: t("finance.invoices.batch.result"),
      renderCell: (row) => row.erpnext_docname ?? row.error_message ?? "—",
    },
  ];

  const exportColumns: ExportColumn<InvoiceBatchItem>[] = [
    { header: t("finance.common.student"), value: (row) => row.student_name },
    { header: t("finance.common.admissionNumber"), value: (row) => row.admission_number },
    {
      header: t("finance.common.status"),
      value: (row) => invoiceBatchItemStatusLabel(row.status, t),
    },
    {
      header: t("finance.invoices.batch.result"),
      value: (row) => row.erpnext_docname ?? row.error_message,
    },
  ];

  return (
    <>
      {batch ? (
        <Card as="section" aria-label={t("finance.invoices.batch.progress")}>
          <Card.Body>
            <p role="status">
              {t("finance.invoices.batch.progressStatus", {
                status: invoiceBatchStatusLabel(batch.status, t),
                period: batch.period_title,
              })}
            </p>
            <dl className="invoices-batch__stats">
              <div>
                <dt>{t("finance.common.total")}</dt>
                <dd>{batch.total_count}</dd>
              </div>
              <div>
                <dt>{invoiceBatchItemStatusLabel("succeeded", t)}</dt>
                <dd>{batch.succeeded_count}</dd>
              </div>
              <div>
                <dt>{invoiceBatchItemStatusLabel("already_existed", t)}</dt>
                <dd>{batch.already_existed_count}</dd>
              </div>
              <div>
                <dt>{invoiceBatchItemStatusLabel("failed", t)}</dt>
                <dd>{batch.failed_count}</dd>
              </div>
            </dl>
            <div
              className="invoices-batch__meter"
              role="progressbar"
              aria-label={t("finance.invoices.batch.generationProgress")}
              aria-valuenow={progressPercent}
              aria-valuemin={0}
              aria-valuemax={100}
            >
              <div
                className="invoices-batch__meter-fill"
                style={{ width: `${progressPercent}%` }}
              />
            </div>
            {batch.status === "completed" || batch.status === "failed" ? (
              <Button type="button" onClick={onReset}>
                {t("finance.invoices.batch.startAnother")}
              </Button>
            ) : (
              <p>{t("finance.invoices.batch.longRunning")}</p>
            )}
          </Card.Body>
        </Card>
      ) : (
        <p role="status">{t("finance.common.loading")}</p>
      )}

      <div className="invoices-batch__toolbar">
        <Select
          label={t("finance.invoices.batch.filterByStatus")}
          options={statusOptions}
          value={statusFilter}
          onChange={(value) => {
            setStatusFilter(value);
            setCursor(undefined);
            setCursorHistory([]);
          }}
        />
        <ExportCsvButton
          filename="invoice-batch-items"
          columns={exportColumns}
          getRows={() =>
            collectCursorPages(async (pageCursor) => {
              const page = await fetchInvoiceBatchItemsPage(
                batchId,
                pageCursor,
                statusFilter,
                PAGINATION_MAX_LIMIT,
              );
              return { items: page.items, nextCursor: page.next_cursor };
            })
          }
        />
      </div>

      <DataGrid
        caption={t("finance.invoices.batch.resultsCaption")}
        columns={columns}
        rows={itemsQuery.data?.items ?? []}
        getRowId={(row) => row.id}
        getRowLabel={(row) => row.student_name}
        loading={itemsQuery.isPending}
        empty={
          itemsQuery.isError
            ? t("finance.invoices.batch.resultsError")
            : t("finance.invoices.batch.resultsEmpty")
        }
      />

      <div className="invoices-batch__pagination">
        <Button
          variant="secondary"
          disabled={cursorHistory.length === 0}
          onClick={() => {
            const next = [...cursorHistory];
            const previous = next.pop();
            setCursorHistory(next);
            setCursor(previous);
          }}
        >
          {t("finance.common.previous")}
        </Button>
        <Button
          variant="secondary"
          disabled={!itemsQuery.data?.next_cursor}
          onClick={() => {
            const nextCursor = itemsQuery.data?.next_cursor;
            if (!nextCursor) return;
            setCursorHistory([...cursorHistory, cursor]);
            setCursor(nextCursor);
          }}
        >
          {t("finance.common.next")}
        </Button>
      </div>
    </>
  );
}
