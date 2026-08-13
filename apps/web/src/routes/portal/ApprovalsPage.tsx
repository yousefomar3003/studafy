import { Table } from "@studafy/ui";
import { useQuery } from "@tanstack/react-query";

import { api } from "../../lib/api";

import type { components } from "@studafy/api-client";

const COLUMN_COUNT = 4;

/**
 * Approval queue (`/portal/approvals`), gated by `approval:review` (see `RequirePermission` in
 * `app/routes.tsx`). Read-only for now — deciding items (`POST /api/approvals/bulk-decision`) is a
 * separate ticket; this page only needs to prove the gated-route pattern against a real endpoint.
 */
export default function ApprovalsPage() {
  const { data, isPending, isError } = useQuery({
    queryKey: ["approval-queue", "list"],
    queryFn: async () => {
      const { data } = await api.GET("/api/approvals/queue");
      return data;
    },
  });

  return (
    <>
      <h1>Approvals</h1>
      <p>Items awaiting your review.</p>

      <Table caption="Pending approval items">
        <Table.Header>
          <Table.Row>
            <Table.HeaderCell>Type</Table.HeaderCell>
            <Table.HeaderCell>Summary</Table.HeaderCell>
            <Table.HeaderCell>Requested by</Table.HeaderCell>
            <Table.HeaderCell>Requested at</Table.HeaderCell>
          </Table.Row>
        </Table.Header>
        <Table.Body
          columnCount={COLUMN_COUNT}
          loading={isPending}
          empty={isError ? "Unable to load the approval queue." : "Nothing is pending review."}
        >
          {
            // `readonly ApprovalQueueItem[]` loses its array prototype through the generated
            // response type here — a pre-existing `@studafy/api-client` typing gap, not a shape
            // mismatch. The annotation restores it without widening to `any`.
            ((data?.items ?? []) as readonly components["schemas"]["ApprovalQueueItem"][]).map(
              (item) => (
                <Table.Row key={item.id}>
                  <Table.Cell>{item.item_type}</Table.Cell>
                  <Table.Cell>{item.summary}</Table.Cell>
                  <Table.Cell>{item.requested_by_display_name ?? "—"}</Table.Cell>
                  <Table.Cell>
                    {item.requested_at ? new Date(item.requested_at).toLocaleString() : "—"}
                  </Table.Cell>
                </Table.Row>
              ),
            )
          }
        </Table.Body>
      </Table>
    </>
  );
}
