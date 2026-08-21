import { ApiError } from "@studafy/api-client";
import { PERMISSIONS } from "@studafy/constants";
import { Button, DataGrid, Select, useToast } from "@studafy/ui";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { Link } from "react-router-dom";

import { useAuth, usePermissions } from "../../../lib/auth";

import { AdjustmentConfirmDialog } from "./AdjustmentConfirmDialog";
import { AuditTrailModal } from "./AuditTrailModal";
import { AWARD_STATUS_LABELS, awardStatusTone, discountEffectLine } from "./labels";
import { useConfirmAward } from "./mutations";
import {
  AWARDS_PAGE_SIZE,
  fetchAllScholarshipDiscounts,
  fetchAwardsPage,
  SCHOLARSHIP_DISCOUNTS_ALL_KEY,
} from "./queries";

import "./adjustments.css";

import type { AuditTrailTarget } from "./AuditTrailModal";
import type { Award, AwardFilters, AwardStatus } from "./queries";
import type { DataGridColumn, SelectOption } from "@studafy/ui";

const STATUS_OPTIONS: SelectOption<AwardStatus | "">[] = [
  { value: "", label: "All statuses" },
  { value: "pending", label: "Pending confirmation" },
  { value: "confirmed", label: "Confirmed" },
  { value: "cancelled", label: "Cancelled" },
];

function apiErrorMessage(error: unknown, fallback: string): string {
  if (!(error instanceof ApiError)) return fallback;
  return error.detail ?? error.title;
}

/**
 * Scholarship/discount awards (`/portal/finance/adjustments/scholarships`), gated by `billing:read`.
 * Confirming a pending award (the checker step) requires `billing:update` — the same permission the
 * maker step's own route requires (see `scholarships/routes.ts`) — and a different user than the one
 * who created it; both are checked client-side to avoid a doomed round trip, and enforced again by
 * the API regardless (see `confirmAward`'s doc comment).
 */
export default function ScholarshipAwardsListPage() {
  const { show } = useToast();
  const { userId } = useAuth();
  const permissions = usePermissions();
  const canConfirm = permissions.has(PERMISSIONS.BILLING_UPDATE);
  const canViewAudit = permissions.has(PERMISSIONS.AUDIT_LOG_READ);
  const queryClient = useQueryClient();
  const confirmAward = useConfirmAward();

  const [status, setStatus] = useState<AwardStatus | "">("");
  const [offset, setOffset] = useState(0);
  const [confirmTarget, setConfirmTarget] = useState<Award | null>(null);
  const [auditTarget, setAuditTarget] = useState<AuditTrailTarget | null>(null);

  const filters: AwardFilters = { status };
  const listQuery = useQuery({
    queryKey: ["finance", "adjustments", "awards", "list", status, offset],
    queryFn: () => fetchAwardsPage(filters, offset),
  });
  const discountsQuery = useQuery({
    queryKey: SCHOLARSHIP_DISCOUNTS_ALL_KEY,
    queryFn: fetchAllScholarshipDiscounts,
  });
  const discountsById = new Map(
    (discountsQuery.data ?? []).map((discount) => [discount.id, discount]),
  );

  const items = listQuery.data?.items ?? [];
  const total = listQuery.data?.total ?? 0;
  const hasPreviousPage = offset > 0;
  const hasNextPage = offset + items.length < total;

  function changeStatus(next: AwardStatus | "") {
    setStatus(next);
    setOffset(0);
  }

  function handleConfirm() {
    if (!confirmTarget) return;
    confirmAward.mutate(confirmTarget.id, {
      onSuccess: () => {
        show({ variant: "success", title: "Award confirmed" });
        setConfirmTarget(null);
        void queryClient.invalidateQueries({ queryKey: ["finance", "adjustments", "awards"] });
      },
    });
  }

  const confirmDiscount = confirmTarget
    ? discountsById.get(confirmTarget.scholarship_discount_id)
    : null;

  const columns: DataGridColumn<Award>[] = [
    {
      id: "created_at",
      header: "Created",
      renderCell: (row) => new Date(row.created_at).toLocaleDateString(),
    },
    { id: "student_id", header: "Student", renderCell: (row) => row.student_id },
    {
      id: "discount",
      header: "Scholarship / discount",
      renderCell: (row) => row.scholarship_discount_title,
    },
    {
      id: "status",
      header: "Status",
      renderCell: (row) => (
        <span className="adjustments-status-pill" data-tone={awardStatusTone(row.award_status)}>
          {AWARD_STATUS_LABELS[row.award_status]}
        </span>
      ),
    },
    {
      id: "actions",
      header: "Actions",
      renderCell: (row) => {
        const isOwnAward = row.awarded_by === userId;
        return (
          <div className="adjustments-list__row-actions">
            {row.award_status === "pending" && canConfirm ? (
              <Button
                type="button"
                variant="secondary"
                disabled={isOwnAward}
                title={isOwnAward ? "A different user must confirm this award." : undefined}
                onClick={() => setConfirmTarget(row)}
              >
                Confirm
              </Button>
            ) : null}
            {canViewAudit ? (
              <Button
                type="button"
                variant="tertiary"
                onClick={() =>
                  setAuditTarget({
                    targetTable: "award_cache",
                    targetId: row.school_id,
                    recordId: row.id,
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
          <h1>Scholarship &amp; discount awards</h1>
          <p>
            Pending awards need confirmation from a different user before they apply to invoices.
          </p>
        </div>
        <Link to="/portal/finance/adjustments/scholarships/new">
          <Button>Award scholarship</Button>
        </Link>
      </div>

      <div className="adjustments-list__toolbar">
        <Select label="Status" options={STATUS_OPTIONS} value={status} onChange={changeStatus} />
      </div>

      <DataGrid
        caption="Scholarship and discount awards"
        columns={columns}
        rows={items}
        getRowId={(row) => row.id}
        getRowLabel={(row) => row.scholarship_discount_title}
        loading={listQuery.isPending}
        empty={listQuery.isError ? "Unable to load awards." : "No awards match this filter."}
      />

      <div className="adjustments-list__pagination">
        <Button
          variant="secondary"
          disabled={!hasPreviousPage}
          onClick={() => setOffset(Math.max(0, offset - AWARDS_PAGE_SIZE))}
        >
          Previous
        </Button>
        <Button
          variant="secondary"
          disabled={!hasNextPage}
          onClick={() => setOffset(offset + AWARDS_PAGE_SIZE)}
        >
          Next
        </Button>
      </div>

      <AdjustmentConfirmDialog
        open={confirmTarget !== null}
        title="Confirm scholarship award?"
        description="This forwards the award to ERPNext. It cannot be undone from here."
        confirmLabel="Confirm award"
        loading={confirmAward.isPending}
        error={
          confirmAward.isError
            ? apiErrorMessage(confirmAward.error, "The award could not be confirmed.")
            : undefined
        }
        onConfirm={handleConfirm}
        onClose={() => setConfirmTarget(null)}
      >
        {confirmTarget ? (
          <dl className="adjustments-effect">
            <div>
              <dt>Student</dt>
              <dd>{confirmTarget.student_id}</dd>
            </div>
            <div>
              <dt>Scholarship / discount</dt>
              <dd>{confirmTarget.scholarship_discount_title}</dd>
            </div>
            <div>
              <dt>Effect</dt>
              <dd>{confirmDiscount ? discountEffectLine(confirmDiscount) : "—"}</dd>
            </div>
          </dl>
        ) : null}
      </AdjustmentConfirmDialog>

      <AuditTrailModal target={auditTarget} onClose={() => setAuditTarget(null)} />
    </>
  );
}
