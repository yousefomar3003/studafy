import { ApiError } from "@studafy/api-client";
import { Button, DataGrid, Modal, Select, useToast } from "@studafy/ui";
import { keepPreviousData, useQuery } from "@tanstack/react-query";
import { useState } from "react";

import { api } from "../../../lib/api";
import { useTranslation } from "../../../lib/i18n";

import { useRetryBulkInvite } from "./mutations";
import { fetchBulkInviteRecipientsPage } from "./queries";
import {
  BULK_INVITE_STATUS_LABEL_KEYS,
  BULK_RECIPIENT_STATUS_LABEL_KEYS,
  ROLE_LABEL_KEYS,
} from "./schema";

import type { BulkInviteRecipient, BulkInviteRecipientStatus } from "./queries";
import type { DataGridColumn, SelectOption } from "@studafy/ui";

function isRole(value: string): value is keyof typeof ROLE_LABEL_KEYS {
  return Object.hasOwn(ROLE_LABEL_KEYS, value);
}

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
  const { t } = useTranslation();
  const { show } = useToast();
  const retryBulkInvite = useRetryBulkInvite();
  const open = bulkInviteId !== null;

  const statusOptions: SelectOption<BulkInviteRecipientStatus | "">[] = [
    { value: "", label: t("adminPeople.invitations.progress.allStatuses") },
    ...(
      Object.entries(BULK_RECIPIENT_STATUS_LABEL_KEYS) as [BulkInviteRecipientStatus, string][]
    ).map(([value, key]) => ({ value, label: t(key) })),
  ];

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
        show({ variant: "success", title: t("adminPeople.invitations.progress.retryingToast") });
      },
      onError: (error) => {
        show({
          variant: "error",
          title: t("adminPeople.invitations.progress.retryError"),
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
    {
      id: "email",
      header: t("adminPeople.invitations.progress.columns.email"),
      renderCell: (row) => row.email,
    },
    {
      id: "status",
      header: t("adminPeople.invitations.progress.columns.status"),
      renderCell: (row) => (
        <span className="invitations-status-pill" data-status={row.status}>
          {t(BULK_RECIPIENT_STATUS_LABEL_KEYS[row.status])}
        </span>
      ),
    },
    {
      id: "error",
      header: t("adminPeople.invitations.progress.columns.error"),
      renderCell: (row) => row.error_message ?? "—",
    },
  ];

  return (
    <Modal
      open={open}
      onClose={handleClose}
      title={t("adminPeople.invitations.progress.title")}
      description={
        batch
          ? t("adminPeople.invitations.progress.description", {
              status: t(BULK_INVITE_STATUS_LABEL_KEYS[batch.status]),
              role: isRole(batch.role) ? t(ROLE_LABEL_KEYS[batch.role]) : batch.role,
            })
          : undefined
      }
    >
      <Modal.Body>
        {batch ? (
          <>
            <dl className="invitations-bulk-progress__stats">
              <div>
                <dt>{t("adminPeople.invitations.progress.total")}</dt>
                <dd>{batch.total_count}</dd>
              </div>
              <div>
                <dt>{t("adminPeople.invitations.progress.sent")}</dt>
                <dd>{batch.sent_count}</dd>
              </div>
              <div>
                <dt>{t("adminPeople.invitations.progress.failed")}</dt>
                <dd>{batch.failed_count}</dd>
              </div>
            </dl>
            <div
              className="invitations-bulk-progress__meter"
              role="progressbar"
              aria-label={t("adminPeople.invitations.progress.dispatchProgress")}
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
          <p role="status">{t("adminPeople.common.loading")}</p>
        )}

        <div className="invitations-bulk-progress__toolbar">
          <Select
            label={t("adminPeople.invitations.progress.filterByStatus")}
            options={statusOptions}
            value={statusFilter}
            onChange={(value) => {
              setStatusFilter(value);
              setCursor(undefined);
              setCursorHistory([]);
            }}
          />
          {batch && batch.failed_count > 0 && batch.status !== "processing" ? (
            <Button variant="secondary" loading={retryBulkInvite.isPending} onClick={handleRetry}>
              {t("adminPeople.invitations.progress.retryFailed")}
            </Button>
          ) : null}
        </div>

        <DataGrid
          caption={t("adminPeople.invitations.progress.caption")}
          columns={columns}
          rows={recipientsQuery.data?.recipients ?? []}
          getRowId={(row) => row.id}
          getRowLabel={(row) => row.email}
          height={320}
          loading={recipientsQuery.isPending}
          empty={
            recipientsQuery.isError
              ? t("adminPeople.invitations.progress.loadError")
              : t("adminPeople.invitations.progress.empty")
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
            {t("adminPeople.common.previous")}
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
            {t("adminPeople.common.next")}
          </Button>
        </div>
      </Modal.Body>
    </Modal>
  );
}
