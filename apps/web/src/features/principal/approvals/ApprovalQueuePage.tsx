import { ApiError } from "@studafy/api-client";
import { Button, Table, useToast } from "@studafy/ui";
import { useQuery } from "@tanstack/react-query";
import { useEffect, useRef, useState } from "react";

import { ApprovalDiffModal } from "./ApprovalDiffModal";
import { ITEM_TYPE_LABELS } from "./labels";
import { useDecideApprovals } from "./mutations";
import { APPROVAL_QUEUE_KEY, fetchApprovalQueue } from "./queries";
import { RejectReasonModal } from "./RejectReasonModal";

import type { ApprovalQueueItem, BulkDecisionEntry, BulkDecisionResult } from "./queries";
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
  const { show } = useToast();
  const decide = useDecideApprovals();

  const { data, isPending, isError } = useQuery({
    queryKey: APPROVAL_QUEUE_KEY,
    queryFn: fetchApprovalQueue,
  });
  const items = data?.items ?? [];

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
            ? { variant: "error", title: "Couldn't approve item", description: failed }
            : { variant: "success", title: "Item approved" },
        );
      },
      onError: (error) => showApiError("Couldn't approve item", error),
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
            show({ variant: "error", title: "Couldn't reject item", description: failed });
            return; // keep the modal open so the reason can be fixed and resubmitted
          }
          show({ variant: "success", title: "Item rejected" });
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
                title: `${succeeded} of ${total} item${total === 1 ? "" : "s"} rejected`,
              }
            : {
                variant: succeeded === 0 ? "error" : "warning",
                title: `${succeeded} of ${total} rejected`,
                description: `${failed} failed — see the error on each row below.`,
              },
        );
        setRejectTarget(null);
      },
      onError: (error) => showApiError("Couldn't reject item(s)", error),
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
                title: `${succeeded} of ${total} item${total === 1 ? "" : "s"} approved`,
              }
            : {
                variant: succeeded === 0 ? "error" : "warning",
                title: `${succeeded} of ${total} approved`,
                description: `${failed} failed — see the error on each row below.`,
              };
        show(toast);
      },
      onError: (error) => showApiError("Couldn't process approvals", error),
    });
  }

  function handleRejectSelected() {
    const targets = items.filter((item) => selectedIds.has(item.id));
    if (targets.length === 0) return;
    setRejectTarget({ kind: "bulk", items: targets });
  }

  return (
    <>
      <h1>Approvals</h1>
      <p>Grade submissions and timetable versions awaiting your review.</p>

      <div className="approvals-queue__toolbar">
        <Button
          variant="secondary"
          disabled={selectedIds.size === 0}
          loading={decide.isPending}
          onClick={handleApproveSelected}
        >
          {selectedIds.size > 0 ? `Approve ${selectedIds.size} selected` : "Approve selected"}
        </Button>
        <Button variant="tertiary" disabled={selectedIds.size === 0} onClick={handleRejectSelected}>
          {selectedIds.size > 0 ? `Reject ${selectedIds.size} selected` : "Reject selected"}
        </Button>
      </div>

      <Table caption="Pending approval items">
        <Table.Header>
          <Table.Row>
            <Table.HeaderCell>
              <input
                ref={selectAllRef}
                type="checkbox"
                className="approvals-queue__select-checkbox"
                checked={allSelected}
                aria-label="Select all pending items"
                disabled={items.length === 0}
                onChange={toggleAll}
              />
            </Table.HeaderCell>
            <Table.HeaderCell>Type</Table.HeaderCell>
            <Table.HeaderCell>Summary</Table.HeaderCell>
            <Table.HeaderCell>Requested by</Table.HeaderCell>
            <Table.HeaderCell>Requested at</Table.HeaderCell>
            <Table.HeaderCell>Actions</Table.HeaderCell>
          </Table.Row>
        </Table.Header>
        <Table.Body
          columnCount={COLUMN_COUNT}
          loading={isPending}
          empty={isError ? "Unable to load the approval queue." : "Nothing is pending review."}
        >
          {items.map((item) => (
            <Table.Row key={item.id} aria-selected={selectedIds.has(item.id)}>
              <Table.Cell>
                <input
                  type="checkbox"
                  className="approvals-queue__select-checkbox"
                  checked={selectedIds.has(item.id)}
                  aria-label={`Select ${item.summary}`}
                  onChange={() => toggleRow(item.id)}
                />
              </Table.Cell>
              <Table.Cell>{ITEM_TYPE_LABELS[item.item_type]}</Table.Cell>
              <Table.Cell>{item.summary}</Table.Cell>
              <Table.Cell>{item.requested_by_display_name ?? "—"}</Table.Cell>
              <Table.Cell>
                {item.requested_at ? new Date(item.requested_at).toLocaleString() : "—"}
              </Table.Cell>
              <Table.Cell>
                <div className="approvals-queue__actions">
                  <Button variant="tertiary" onClick={() => setViewingItem(item)}>
                    View diff
                  </Button>
                  <Button
                    variant="secondary"
                    disabled={decide.isPending}
                    onClick={() => handleApprove(item)}
                  >
                    Approve
                  </Button>
                  <Button
                    variant="tertiary"
                    disabled={decide.isPending}
                    onClick={() => setRejectTarget({ kind: "single", item })}
                  >
                    Reject
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
        title={rejectTarget?.kind === "bulk" ? "Reject selected items" : "Reject item"}
        description={
          rejectTarget?.kind === "single"
            ? rejectTarget.item.summary
            : rejectTarget?.kind === "bulk"
              ? `${rejectTarget.items.length} item${rejectTarget.items.length === 1 ? "" : "s"} selected`
              : undefined
        }
        submitting={decide.isPending}
        onCancel={() => setRejectTarget(null)}
        onConfirm={handleRejectConfirm}
      />
    </>
  );
}
