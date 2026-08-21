import { ApiError } from "@studafy/api-client";
import { PERMISSIONS } from "@studafy/constants";
import { Button, DataGrid, Select, useToast } from "@studafy/ui";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { Link } from "react-router-dom";

import { useAuth, usePermissions } from "../../../lib/auth";

import { AdjustmentConfirmDialog } from "./AdjustmentConfirmDialog";
import { AuditTrailModal } from "./AuditTrailModal";
import { REASON_CODE_LABELS, REFUND_STATUS_LABELS, refundStatusTone } from "./labels";
import { useApproveRefund } from "./mutations";
import { fetchRefundsPage, REFUNDS_PAGE_SIZE } from "./queries";
import { RejectRefundModal } from "./RejectRefundModal";

import "./adjustments.css";

import type { AuditTrailTarget } from "./AuditTrailModal";
import type { Refund, RefundFilters, RefundStatus } from "./queries";
import type { DataGridColumn, SelectOption } from "@studafy/ui";

const STATUS_OPTIONS: SelectOption<RefundStatus | "">[] = [
  { value: "", label: "All statuses" },
  ...(Object.entries(REFUND_STATUS_LABELS) as [RefundStatus, string][]).map(([value, label]) => ({
    value,
    label,
  })),
];

function apiErrorMessage(error: unknown, fallback: string): string {
  if (!(error instanceof ApiError)) return fallback;
  return error.detail ?? error.title;
}

/**
 * Refund requests (`/portal/finance/adjustments/refunds`), gated by `billing:read`. Approving or
 * rejecting a pending refund (the checker step) requires `billing:refund` — deliberately stricter
 * than `billing:update`, which only the maker step needs (see `refunds/routes.ts`) — so FINANCE-role
 * users can see this list without being able to act on it; the row actions reflect that instead of
 * offering a control that would always 403.
 */
export default function RefundsListPage() {
  const { show } = useToast();
  const { userId } = useAuth();
  const permissions = usePermissions();
  const canDecide = permissions.has(PERMISSIONS.BILLING_REFUND);
  const canViewAudit = permissions.has(PERMISSIONS.AUDIT_LOG_READ);
  const queryClient = useQueryClient();
  const approveRefund = useApproveRefund();

  const [status, setStatus] = useState<RefundStatus | "">("");
  const [offset, setOffset] = useState(0);
  const [approveTarget, setApproveTarget] = useState<Refund | null>(null);
  const [rejectTarget, setRejectTarget] = useState<Refund | null>(null);
  const [auditTarget, setAuditTarget] = useState<AuditTrailTarget | null>(null);

  const filters: RefundFilters = { status };
  const listQuery = useQuery({
    queryKey: ["finance", "adjustments", "refunds", "list", status, offset],
    queryFn: () => fetchRefundsPage(filters, offset),
  });

  const items = listQuery.data?.items ?? [];
  const total = listQuery.data?.total ?? 0;
  const hasPreviousPage = offset > 0;
  const hasNextPage = offset + items.length < total;

  function changeStatus(next: RefundStatus | "") {
    setStatus(next);
    setOffset(0);
  }

  function invalidateList() {
    void queryClient.invalidateQueries({ queryKey: ["finance", "adjustments", "refunds"] });
  }

  function handleApprove() {
    if (!approveTarget) return;
    approveRefund.mutate(approveTarget.id, {
      onSuccess: () => {
        show({ variant: "success", title: "Refund approved" });
        setApproveTarget(null);
        invalidateList();
      },
    });
  }

  const columns: DataGridColumn<Refund>[] = [
    {
      id: "created_at",
      header: "Created",
      renderCell: (row) => new Date(row.created_at).toLocaleDateString(),
    },
    { id: "invoice", header: "Invoice", renderCell: (row) => row.erpnext_invoice_id },
    {
      id: "amount",
      header: "Amount",
      align: "end",
      renderCell: (row) => `${row.amount} ${row.currency}`,
    },
    { id: "reason", header: "Reason", renderCell: (row) => REASON_CODE_LABELS[row.reason_code] },
    {
      id: "status",
      header: "Status",
      renderCell: (row) => (
        <span className="adjustments-status-pill" data-tone={refundStatusTone(row.status)}>
          {REFUND_STATUS_LABELS[row.status]}
        </span>
      ),
    },
    {
      id: "actions",
      header: "Actions",
      renderCell: (row) => {
        const isOwnRequest = row.maker_id === userId;
        const canDecideThisRow = row.status === "pending_approval" && canDecide;
        return (
          <div className="adjustments-list__row-actions">
            {canDecideThisRow ? (
              <>
                <Button
                  type="button"
                  variant="secondary"
                  disabled={isOwnRequest}
                  title={isOwnRequest ? "A different user must approve this refund." : undefined}
                  onClick={() => setApproveTarget(row)}
                >
                  Approve
                </Button>
                <Button
                  type="button"
                  variant="tertiary"
                  disabled={isOwnRequest}
                  title={isOwnRequest ? "A different user must reject this refund." : undefined}
                  onClick={() => setRejectTarget(row)}
                >
                  Reject
                </Button>
              </>
            ) : null}
            {canViewAudit ? (
              <Button
                type="button"
                variant="tertiary"
                onClick={() =>
                  setAuditTarget({
                    targetTable: "refund_requests",
                    targetId: row.id,
                    createdAt: row.created_at,
                  })
                }
              >
                Audit trail
              </Button>
            ) : null}
          </div>
        );
      },
    },
  ];

  return (
    <>
      <div className="adjustments-list__header">
        <div>
          <h1>Refunds</h1>
          <p>Pending refunds need approval from a different user with refund approval rights.</p>
        </div>
        <Link to="/portal/finance/adjustments/refunds/new">
          <Button>Request refund</Button>
        </Link>
      </div>

      <div className="adjustments-list__toolbar">
        <Select label="Status" options={STATUS_OPTIONS} value={status} onChange={changeStatus} />
      </div>

      <DataGrid
        caption="Refund requests"
        columns={columns}
        rows={items}
        getRowId={(row) => row.id}
        getRowLabel={(row) => row.erpnext_invoice_id}
        loading={listQuery.isPending}
        empty={listQuery.isError ? "Unable to load refunds." : "No refunds match this filter."}
      />

      <div className="adjustments-list__pagination">
        <Button
          variant="secondary"
          disabled={!hasPreviousPage}
          onClick={() => setOffset(Math.max(0, offset - REFUNDS_PAGE_SIZE))}
        >
          Previous
        </Button>
        <Button
          variant="secondary"
          disabled={!hasNextPage}
          onClick={() => setOffset(offset + REFUNDS_PAGE_SIZE)}
        >
          Next
        </Button>
      </div>

      <AdjustmentConfirmDialog
        open={approveTarget !== null}
        title="Approve refund?"
        description="This forwards the refund to ERPNext as a credit note. It cannot be undone from here."
        confirmLabel="Approve refund"
        loading={approveRefund.isPending}
        error={
          approveRefund.isError
            ? apiErrorMessage(approveRefund.error, "The refund could not be approved.")
            : undefined
        }
        onConfirm={handleApprove}
        onClose={() => setApproveTarget(null)}
      >
        {approveTarget ? (
          <dl className="adjustments-effect">
            <div>
              <dt>Invoice</dt>
              <dd>{approveTarget.erpnext_invoice_id}</dd>
            </div>
            <div>
              <dt>Refund amount</dt>
              <dd>
                {approveTarget.amount} {approveTarget.currency}
              </dd>
            </div>
            <div>
              <dt>Reason</dt>
              <dd>{REASON_CODE_LABELS[approveTarget.reason_code]}</dd>
            </div>
          </dl>
        ) : null}
      </AdjustmentConfirmDialog>

      <RejectRefundModal
        key={rejectTarget?.id ?? "closed"}
        refund={rejectTarget}
        onClose={() => setRejectTarget(null)}
        onRejected={() => {
          setRejectTarget(null);
          invalidateList();
        }}
      />

      <AuditTrailModal target={auditTarget} onClose={() => setAuditTarget(null)} />
    </>
  );
}
