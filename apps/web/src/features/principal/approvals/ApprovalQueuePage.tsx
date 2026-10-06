import { ApiError } from "@studafy/api-client";
import { Button, Table, useToast } from "@studafy/ui";
import { useQuery } from "@tanstack/react-query";
import { useEffect, useRef, useState } from "react";

import { ExportCsvButton } from "../../../components/ExportCsvButton";
import { allRows } from "../../../lib/data-transfer";
import { useFormatters, useTranslation } from "../../../lib/i18n";
import { DATE_TIME_OPTIONS } from "../format";

import { ApprovalDiffModal } from "./ApprovalDiffModal";
import { ITEM_TYPE_LABEL_KEYS } from "./labels";
import { useDecideApprovals } from "./mutations";
import { APPROVAL_QUEUE_KEY, fetchApprovalQueue } from "./queries";
import { RejectReasonModal } from "./RejectReasonModal";

import type { ApprovalQueueItem, BulkDecisionEntry, BulkDecisionResult } from "./queries";
import type { ExportColumn } from "../../../lib/data-transfer";
import type { ToastOptions } from "@studafy/ui";

import "./approvals.css";

const COLUMN_COUNT = 6;

/** What the reject-reason modal is currently open for: one row's Reject button, or the toolbar's
 * "Reject selected" acting on the whole selection. Both submit through the same modal and the same
 * `entries` construction — only the target set and the post-decision messaging differ. */
type RejectTarget =
  { kind: "single"; item: ApprovalQueueItem } | { kind: "bulk"; items: ApprovalQueueItem[] };

function rejectTargetKey(target: RejectTarget | null): string {
  if (!target) return "closed";
  if (target.kind === "single") return `single:${target.item.id}`;
  return `bulk:${target.items.map((item) => item.id).join(",")}`;
}

function apiErrorDescription(error: unknown): string | undefined {
  return error instanceof ApiError ? (error.detail ?? error.title) : undefined;
}

/**
 * Unified approval queue (`/portal/approvals`), gated by `approval:review`. Grade submissions and
 * timetable versions share one feed (`GET /api/approvals/queue`) and one decision endpoint
 * (`POST /api/approvals/bulk-decision`) — there is no single-item decision route, so a row's
 * Approve/Reject and the toolbar's "Approve selected"/"Reject selected" all go through the same
 * `useDecideApprovals` mutation with a one- or many-element entry list. Decided items drop out of
 * the next `GET` response server-side, so refetching after any decision is what empties the queue
 * live — no client-side row removal.
 */
export default function ApprovalQueuePage() {
  const { t } = useTranslation();
  const { formatDate } = useFormatters();
  const { show } = useToast();
  const decide = useDecideApprovals();

  const { data, isPending, isError } = useQuery({
    queryKey: APPROVAL_QUEUE_KEY,
    queryFn: fetchApprovalQueue,
  });
  const items = data?.items ?? [];

  const exportColumns: ExportColumn<ApprovalQueueItem>[] = [
    {
      header: t("principal.approvals.columns.type"),
      value: (item) => t(ITEM_TYPE_LABEL_KEYS[item.item_type]),
    },
    { header: t("principal.approvals.columns.summary"), value: (item) => item.summary },
    {
      header: t("principal.approvals.columns.requestedBy"),
      value: (item) => item.requested_by_display_name,
    },
    { header: t("principal.approvals.columns.requestedAt"), value: (item) => item.requested_at },
  ];

  const [selectedIds, setSelectedIds] = useState<ReadonlySet<string>>(new Set());
  const [viewingItem, setViewingItem] = useState<ApprovalQueueItem | null>(null);
  const [rejectTarget, setRejectTarget] = useState<RejectTarget | null>(null);
  const [rowErrors, setRowErrors] = useState<Record<string, string>>({});

  // Selection can only reference items the queue actually holds — an item that was decided
  // elsewhere (or dropped by a refetch) must not linger as a phantom "selected" row.
  useEffect(() => {
    setSelectedIds((current) => {
      const next = new Set([...current].filter((id) => items.some((item) => item.id === id)));
      return next.size === current.size ? current : next;
    });
  }, [items]);

  const allSelected = items.length > 0 && selectedIds.size === items.length;
  const someSelected = selectedIds.size > 0 && !allSelected;
  const selectAllRef = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (selectAllRef.current) selectAllRef.current.indeterminate = someSelected;
  }, [someSelected]);

  function toggleAll() {
    setSelectedIds(allSelected ? new Set() : new Set(items.map((item) => item.id)));
  }

  function toggleRow(id: string) {
    setSelectedIds((current) => {
      const next = new Set(current);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  /** Syncs local UI state with a decision result: clears/sets per-row errors, and drops any row
   * that succeeded out of the selection (it's about to disappear from the refetched queue). */
  function syncResult(result: BulkDecisionResult) {
    setRowErrors((current) => {
      const next = { ...current };
      for (const entry of result.results) {
        if (entry.error) next[entry.id] = entry.error;
        else delete next[entry.id];
      }
      return next;
    });
    setSelectedIds((current) => {
      const next = new Set(current);
      for (const entry of result.results) {
        if (!entry.error) next.delete(entry.id);
      }
      return next;
    });
  }

  function showApiError(title: string, error: unknown) {
    show({ variant: "error", title, description: apiErrorDescription(error) });
  }

  function handleApprove(item: ApprovalQueueItem) {
    const entries: BulkDecisionEntry[] = [
      { item_type: item.item_type, id: item.id, action: "approve" },
    ];
    decide.mutate(entries, {
      onSuccess: (result) => {
        syncResult(result);
        const failed = result.results[0]?.error;
        show(
          failed
            ? {
                variant: "error",
                title: t("principal.approvals.toast.approveFailed"),
                description: failed,
              }
            : { variant: "success", title: t("principal.approvals.toast.approved") },
        );
      },
      onError: (error) => showApiError(t("principal.approvals.toast.approveFailed"), error),
    });
  }

  function handleRejectConfirm(reason: string) {
    if (!rejectTarget) return;
    const targetItems = rejectTarget.kind === "single" ? [rejectTarget.item] : rejectTarget.items;

    const entries: BulkDecisionEntry[] = targetItems.map((item) => ({
      item_type: item.item_type,
      id: item.id,
      action: "reject",
      rejection_reason: reason,
    }));

    decide.mutate(entries, {
      onSuccess: (result) => {
        syncResult(result);

        if (rejectTarget.kind === "single") {
          const failed = result.results[0]?.error;
          if (failed) {
            show({
              variant: "error",
              title: t("principal.approvals.toast.rejectFailed"),
              description: failed,
            });
            return; // keep the modal open so the reason can be fixed and resubmitted
          }
          show({ variant: "success", title: t("principal.approvals.toast.rejected") });
          setRejectTarget(null);
          return;
        }

        // Bulk: one shared reason was just applied to every selected item, so there is nothing
        // left to usefully retry from this modal — close it and let the row errors (from
        // `syncResult`) carry any per-item failure detail, same as bulk approve.
        const { succeeded, failed, total } = result.summary;
        show(
          failed === 0
            ? {
                variant: "success",
                title: t("principal.approvals.toast.bulkRejectedAll", { succeeded, count: total }),
              }
            : {
                variant: succeeded === 0 ? "error" : "warning",
                title: t("principal.approvals.toast.bulkRejectedPartial", { succeeded, total }),
                description: t("principal.approvals.toast.bulkFailedDescription", { failed }),
              },
        );
        setRejectTarget(null);
      },
      onError: (error) => showApiError(t("principal.approvals.toast.bulkRejectFailed"), error),
    });
  }

  function handleApproveSelected() {
    const entries: BulkDecisionEntry[] = items
      .filter((item) => selectedIds.has(item.id))
      .map((item) => ({ item_type: item.item_type, id: item.id, action: "approve" }));
    if (entries.length === 0) return;

    decide.mutate(entries, {
      onSuccess: (result) => {
        syncResult(result);
        const { succeeded, failed, total } = result.summary;
        const toast: ToastOptions =
          failed === 0
            ? {
                variant: "success",
                title: t("principal.approvals.toast.bulkApprovedAll", { succeeded, count: total }),
              }
            : {
                variant: succeeded === 0 ? "error" : "warning",
                title: t("principal.approvals.toast.bulkApprovedPartial", { succeeded, total }),
                description: t("principal.approvals.toast.bulkFailedDescription", { failed }),
              };
        show(toast);
      },
      onError: (error) => showApiError(t("principal.approvals.toast.bulkApproveFailed"), error),
    });
  }

  function handleRejectSelected() {
    const targets = items.filter((item) => selectedIds.has(item.id));
    if (targets.length === 0) return;
    setRejectTarget({ kind: "bulk", items: targets });
  }

  return (
    <>
      <h1>{t("principal.approvals.title")}</h1>
      <p>{t("principal.approvals.description")}</p>

      <div className="approvals-queue__toolbar">
        <ExportCsvButton
          filename="approvals"
          columns={exportColumns}
          getRows={() => Promise.resolve(allRows(items))}
          disabled={isPending}
        />
        <Button
          variant="secondary"
          disabled={selectedIds.size === 0}
          loading={decide.isPending}
          onClick={handleApproveSelected}
        >
          {selectedIds.size > 0
            ? t("principal.approvals.approveCountSelected", { selected: selectedIds.size })
            : t("principal.approvals.approveSelected")}
        </Button>
        <Button variant="tertiary" disabled={selectedIds.size === 0} onClick={handleRejectSelected}>
          {selectedIds.size > 0
            ? t("principal.approvals.rejectCountSelected", { selected: selectedIds.size })
            : t("principal.approvals.rejectSelected")}
        </Button>
      </div>

      <Table caption={t("principal.approvals.tableCaption")}>
        <Table.Header>
          <Table.Row>
            <Table.HeaderCell>
              <input
                ref={selectAllRef}
                type="checkbox"
                className="approvals-queue__select-checkbox"
                checked={allSelected}
                aria-label={t("principal.approvals.selectAll")}
                disabled={items.length === 0}
                onChange={toggleAll}
              />
            </Table.HeaderCell>
            <Table.HeaderCell>{t("principal.approvals.columns.type")}</Table.HeaderCell>
            <Table.HeaderCell>{t("principal.approvals.columns.summary")}</Table.HeaderCell>
            <Table.HeaderCell>{t("principal.approvals.columns.requestedBy")}</Table.HeaderCell>
            <Table.HeaderCell>{t("principal.approvals.columns.requestedAt")}</Table.HeaderCell>
            <Table.HeaderCell>{t("principal.approvals.columns.actions")}</Table.HeaderCell>
          </Table.Row>
        </Table.Header>
        <Table.Body
          columnCount={COLUMN_COUNT}
          loading={isPending}
          empty={isError ? t("principal.approvals.error") : t("principal.approvals.empty")}
        >
          {items.map((item) => (
            <Table.Row key={item.id} aria-selected={selectedIds.has(item.id)}>
              <Table.Cell>
                <input
                  type="checkbox"
                  className="approvals-queue__select-checkbox"
                  checked={selectedIds.has(item.id)}
                  aria-label={t("principal.approvals.selectItem", { summary: item.summary })}
                  onChange={() => toggleRow(item.id)}
                />
              </Table.Cell>
              <Table.Cell>{t(ITEM_TYPE_LABEL_KEYS[item.item_type])}</Table.Cell>
              <Table.Cell>{item.summary}</Table.Cell>
              <Table.Cell>{item.requested_by_display_name ?? "—"}</Table.Cell>
              <Table.Cell>
                {item.requested_at
                  ? formatDate(new Date(item.requested_at), DATE_TIME_OPTIONS)
                  : "—"}
              </Table.Cell>
              <Table.Cell>
                <div className="approvals-queue__actions">
                  <Button variant="tertiary" onClick={() => setViewingItem(item)}>
                    {t("principal.approvals.viewDiff")}
                  </Button>
                  <Button
                    variant="secondary"
                    disabled={decide.isPending}
                    onClick={() => handleApprove(item)}
                  >
                    {t("principal.approvals.approve")}
                  </Button>
                  <Button
                    variant="tertiary"
                    disabled={decide.isPending}
                    onClick={() => setRejectTarget({ kind: "single", item })}
                  >
                    {t("principal.approvals.reject")}
                  </Button>
                </div>
                {rowErrors[item.id] ? (
                  <p className="approvals-queue__row-error" role="alert">
                    {rowErrors[item.id]}
                  </p>
                ) : null}
              </Table.Cell>
            </Table.Row>
          ))}
        </Table.Body>
      </Table>

      <ApprovalDiffModal item={viewingItem} onClose={() => setViewingItem(null)} />

      <RejectReasonModal
        key={rejectTargetKey(rejectTarget)}
        open={rejectTarget !== null}
        title={
          rejectTarget?.kind === "bulk"
            ? t("principal.approvals.rejectModal.titleBulk")
            : t("principal.approvals.rejectModal.titleSingle")
        }
        description={
          rejectTarget?.kind === "single"
            ? rejectTarget.item.summary
            : rejectTarget?.kind === "bulk"
              ? t("principal.approvals.rejectModal.selectedCount", {
                  count: rejectTarget.items.length,
                })
              : undefined
        }
        submitting={decide.isPending}
        onCancel={() => setRejectTarget(null)}
        onConfirm={handleRejectConfirm}
      />
    </>
  );
}
