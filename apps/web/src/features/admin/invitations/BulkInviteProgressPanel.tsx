import { ApiError } from "@studafy/api-client";
import { Button, DataGrid, Modal, Select, useToast } from "@studafy/ui";
import { keepPreviousData, useQuery } from "@tanstack/react-query";
import { useState } from "react";

import { api } from "../../../lib/api";

import { useRetryBulkInvite } from "./mutations";
import { fetchBulkInviteRecipientsPage } from "./queries";
import { BULK_INVITE_STATUS_LABELS, BULK_RECIPIENT_STATUS_LABELS } from "./schema";

import type { BulkInviteRecipient, BulkInviteRecipientStatus } from "./queries";
import type { DataGridColumn, SelectOption } from "@studafy/ui";

const STATUS_OPTIONS: SelectOption<BulkInviteRecipientStatus | "">[] = [
  { value: "", label: "All statuses" },
  ...(Object.entries(BULK_RECIPIENT_STATUS_LABELS) as [BulkInviteRecipientStatus, string][]).map(
    ([value, label]) => ({ value, label }),
  ),
];

/** Batches still being worked are polled; terminal batches (completed/failed) are fetched once. */
const IN_FLIGHT_STATUSES = new Set(["pending", "processing"]);
const POLL_INTERVAL_MS = 3000;

export interface BulkInviteProgressPanelProps {
  bulkInviteId: string | null;
  onClose: () => void;
}

/**
 * Per-recipient results for one bulk-invite batch (ST-188 AC: "bulk flow shows per-row results").
 * Polls both the batch summary and the recipient rows while the batch is still `pending`/
 * `processing` — the worker (`process-bulk-invite`) updates rows as it dispatches each invitation,
 * so this is the "live" progress view, not a one-shot result screen.
 */
export function BulkInviteProgressPanel({ bulkInviteId, onClose }: BulkInviteProgressPanelProps) {
  const { show } = useToast();
  const retryBulkInvite = useRetryBulkInvite();
  const open = bulkInviteId !== null;

  const [statusFilter, setStatusFilter] = useState<BulkInviteRecipientStatus | "">("");
  const [cursor, setCursor] = useState<string | undefined>(undefined);
  const [cursorHistory, setCursorHistory] = useState<(string | undefined)[]>([]);

  const batchQuery = useQuery({
    queryKey: ["bulk-invites", bulkInviteId],
    queryFn: async () => {
      const { data } = await api.GET("/api/invitations/bulk/{bulkInviteId}", {
        params: { path: { bulkInviteId: bulkInviteId! } },
      });
      return data ?? null;
    },
    enabled: open,
    refetchInterval: (query) =>
      query.state.data && IN_FLIGHT_STATUSES.has(query.state.data.status)
        ? POLL_INTERVAL_MS
        : false,
  });

  const recipientsQuery = useQuery({
    queryKey: ["bulk-invites", bulkInviteId, "recipients", statusFilter, cursor],
    queryFn: () => fetchBulkInviteRecipientsPage(bulkInviteId!, statusFilter, cursor),
    enabled: open,
    placeholderData: keepPreviousData,
    refetchInterval: () =>
      batchQuery.data && IN_FLIGHT_STATUSES.has(batchQuery.data.status) ? POLL_INTERVAL_MS : false,
  });

  function handleClose() {
    setStatusFilter("");
    setCursor(undefined);
    setCursorHistory([]);
    onClose();
  }

  function handleRetry() {
    if (!bulkInviteId) return;
    retryBulkInvite.mutate(bulkInviteId, {
      onSuccess: () => {
        show({ variant: "success", title: "Retrying failed recipients" });
      },
      onError: (error) => {
        show({
          variant: "error",
          title: "Couldn't retry",
          description: error instanceof ApiError ? (error.detail ?? error.title) : undefined,
        });
      },
    });
  }

  const batch = batchQuery.data;
  const progressPercent =
    batch && batch.total_count > 0
      ? Math.round(((batch.sent_count + batch.failed_count) / batch.total_count) * 100)
      : 0;

  const columns: DataGridColumn<BulkInviteRecipient>[] = [
    { id: "email", header: "Email", renderCell: (row) => row.email },
    {
      id: "status",
      header: "Status",
      renderCell: (row) => (
        <span className="invitations-status-pill" data-status={row.status}>
          {BULK_RECIPIENT_STATUS_LABELS[row.status]}
        </span>
      ),
    },
    {
      id: "error",
      header: "Error",
      renderCell: (row) => row.error_message ?? "—",
    },
  ];

  return (
    <Modal
      open={open}
      onClose={handleClose}
      title="Bulk invite progress"
      description={batch ? `${BULK_INVITE_STATUS_LABELS[batch.status]} — ${batch.role}` : undefined}
    >
      <Modal.Body>
        {batch ? (
          <>
            <dl className="invitations-bulk-progress__stats">
              <div>
                <dt>Total</dt>
                <dd>{batch.total_count}</dd>
              </div>
              <div>
                <dt>Sent</dt>
                <dd>{batch.sent_count}</dd>
              </div>
              <div>
                <dt>Failed</dt>
                <dd>{batch.failed_count}</dd>
              </div>
            </dl>
            <div
              className="invitations-bulk-progress__meter"
              role="progressbar"
              aria-label="Dispatch progress"
              aria-valuenow={progressPercent}
              aria-valuemin={0}
              aria-valuemax={100}
            >
              <div
                className="invitations-bulk-progress__meter-fill"
                style={{ width: `${progressPercent}%` }}
              />
            </div>
          </>
        ) : (
          <p role="status">Loading…</p>
        )}

        <div className="invitations-bulk-progress__toolbar">
          <Select
            label="Filter by status"
            options={STATUS_OPTIONS}
            value={statusFilter}
            onChange={(value) => {
              setStatusFilter(value);
              setCursor(undefined);
              setCursorHistory([]);
            }}
          />
          {batch && batch.failed_count > 0 && batch.status !== "processing" ? (
            <Button variant="secondary" loading={retryBulkInvite.isPending} onClick={handleRetry}>
              Retry failed
            </Button>
          ) : null}
        </div>

        <DataGrid
          caption="Recipients"
          columns={columns}
          rows={recipientsQuery.data?.recipients ?? []}
          getRowId={(row) => row.id}
          getRowLabel={(row) => row.email}
          height={320}
          loading={recipientsQuery.isPending}
          empty={
            recipientsQuery.isError
              ? "Unable to load recipients."
              : "No recipients match this filter."
          }
        />

        <div className="invitations-bulk-progress__pagination">
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
            Previous
          </Button>
          <Button
            variant="secondary"
            disabled={!recipientsQuery.data?.next_cursor}
            onClick={() => {
              const nextCursor = recipientsQuery.data?.next_cursor;
              if (!nextCursor) return;
              setCursorHistory([...cursorHistory, cursor]);
              setCursor(nextCursor);
            }}
          >
            Next
          </Button>
        </div>
      </Modal.Body>
    </Modal>
  );
}
