import { Button, DataGrid } from "@studafy/ui";
import { keepPreviousData, useQuery } from "@tanstack/react-query";
import { useState } from "react";

import { bulkInvitesListQueryKey, fetchBulkInvitesPage } from "./queries";
import { BULK_INVITE_STATUS_LABELS, ROLE_LABELS } from "./schema";

import type { BulkInvite } from "./queries";
import type { Role } from "@studafy/constants";
import type { DataGridColumn } from "@studafy/ui";

export interface BulkInvitesBoardProps {
  onCreate: () => void;
  onViewProgress: (bulkInviteId: string) => void;
}

export function BulkInvitesBoard({ onCreate, onViewProgress }: BulkInvitesBoardProps) {
  const [cursor, setCursor] = useState<string | undefined>(undefined);
  const [cursorHistory, setCursorHistory] = useState<(string | undefined)[]>([]);

  const { data, isPending, isError } = useQuery({
    queryKey: bulkInvitesListQueryKey(cursor),
    queryFn: () => fetchBulkInvitesPage(cursor),
    placeholderData: keepPreviousData,
  });

  const columns: DataGridColumn<BulkInvite>[] = [
    {
      id: "status",
      header: "Status",
      renderCell: (batch) => (
        <span className="invitations-status-pill" data-status={batch.status}>
          {BULK_INVITE_STATUS_LABELS[batch.status]}
        </span>
      ),
    },
    {
      id: "role",
      header: "Role",
      renderCell: (batch) => ROLE_LABELS[batch.role as Role] ?? batch.role,
    },
    { id: "total", header: "Total", renderCell: (batch) => batch.total_count, align: "end" },
    { id: "sent", header: "Sent", renderCell: (batch) => batch.sent_count, align: "end" },
    { id: "failed", header: "Failed", renderCell: (batch) => batch.failed_count, align: "end" },
    {
      id: "created_at",
      header: "Created",
      renderCell: (batch) => new Date(batch.created_at).toLocaleString(),
    },
    {
      id: "actions",
      header: "Actions",
      renderCell: (batch) => (
        <Button variant="tertiary" onClick={() => onViewProgress(batch.id)}>
          View progress
        </Button>
      ),
    },
  ];

  return (
    <>
      <div className="invitations-board__header">
        <p>Batches of invitations sent together, with per-recipient dispatch tracking.</p>
        <Button onClick={onCreate}>New bulk invite</Button>
      </div>

      <DataGrid
        caption="Bulk invite batches"
        columns={columns}
        rows={data?.bulkInvites ?? []}
        getRowId={(batch) => batch.id}
        getRowLabel={(batch) => `Batch ${batch.id}`}
        loading={isPending}
        empty={isError ? "Unable to load bulk invites." : "No bulk invites yet."}
      />

      <div className="invitations-board__pagination">
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
          disabled={!data?.next_cursor}
          onClick={() => {
            const nextCursor = data?.next_cursor;
            if (!nextCursor) return;
            setCursorHistory([...cursorHistory, cursor]);
            setCursor(nextCursor);
          }}
        >
          Next
        </Button>
      </div>
    </>
  );
}
