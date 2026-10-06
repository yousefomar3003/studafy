import { ApiError } from "@studafy/api-client";
import { PERMISSIONS } from "@studafy/constants";
import { PAGINATION_MAX_LIMIT } from "@studafy/shared-schemas";
import { Button, DataGrid, Select, useToast } from "@studafy/ui";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { Link } from "react-router-dom";

import { ExportCsvButton } from "../../../components/ExportCsvButton";
import { useAuth, usePermissions } from "../../../lib/auth";
import { collectOffsetPages } from "../../../lib/data-transfer";
import { useFormatters, useTranslation } from "../../../lib/i18n";

import { AdjustmentConfirmDialog } from "./AdjustmentConfirmDialog";
import { AuditTrailModal } from "./AuditTrailModal";
import { REASON_CODE_LABEL_KEYS, REFUND_STATUS_LABEL_KEYS, refundStatusTone } from "./labels";
import { useApproveRefund } from "./mutations";
import { fetchRefundsPage, REFUNDS_PAGE_SIZE } from "./queries";
import { RejectRefundModal } from "./RejectRefundModal";

import "./adjustments.css";

import type { AuditTrailTarget } from "./AuditTrailModal";
import type { Refund, RefundFilters, RefundStatus } from "./queries";
import type { ExportColumn } from "../../../lib/data-transfer";
import type { DataGridColumn, SelectOption } from "@studafy/ui";

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
  const { t } = useTranslation();
  const { formatDate } = useFormatters();
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

  const statusOptions: SelectOption<RefundStatus | "">[] = [
    { value: "", label: t("financeReports.adjustments.common.allStatuses") },
    ...(Object.entries(REFUND_STATUS_LABEL_KEYS) as [RefundStatus, string][]).map(
      ([value, labelKey]) => ({ value, label: t(labelKey) }),
    ),
  ];

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
        show({ variant: "success", title: t("financeReports.adjustments.refunds.approvedToast") });
        setApproveTarget(null);
        invalidateList();
      },
    });
  }

  const columns: DataGridColumn<Refund>[] = [
    {
      id: "created_at",
      header: t("financeReports.adjustments.common.created"),
      renderCell: (row) => formatDate(new Date(row.created_at)),
    },
    {
      id: "invoice",
      header: t("financeReports.adjustments.common.invoice"),
      renderCell: (row) => row.erpnext_invoice_id,
    },
    {
      id: "amount",
      header: t("financeReports.adjustments.common.amount"),
      align: "end",
      renderCell: (row) => `${row.amount} ${row.currency}`,
    },
    {
      id: "reason",
      header: t("financeReports.adjustments.common.reason"),
      renderCell: (row) => t(REASON_CODE_LABEL_KEYS[row.reason_code]),
    },
    {
      id: "status",
      header: t("financeReports.adjustments.common.status"),
      renderCell: (row) => (
        <span className="adjustments-status-pill" data-tone={refundStatusTone(row.status)}>
          {t(REFUND_STATUS_LABEL_KEYS[row.status])}
        </span>
      ),
    },
    {
      id: "actions",
      header: t("financeReports.adjustments.common.actions"),
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
                  title={
                    isOwnRequest
                      ? t("financeReports.adjustments.refunds.ownApproveHint")
                      : undefined
                  }
                  onClick={() => setApproveTarget(row)}
                >
                  {t("financeReports.adjustments.refunds.approve")}
                </Button>
                <Button
                  type="button"
                  variant="tertiary"
                  disabled={isOwnRequest}
                  title={
                    isOwnRequest ? t("financeReports.adjustments.refunds.ownRejectHint") : undefined
                  }
                  onClick={() => setRejectTarget(row)}
                >
                  {t("financeReports.adjustments.refunds.reject")}
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
                {t("financeReports.adjustments.common.auditTrail")}
              </Button>
            ) : null}
          </div>
        );
      },
    },
  ];

  const exportColumns: ExportColumn<Refund>[] = [
    { header: t("financeReports.adjustments.common.created"), value: (row) => row.created_at },
    {
      header: t("financeReports.adjustments.common.invoice"),
      value: (row) => row.erpnext_invoice_id,
    },
    { header: t("financeReports.adjustments.common.amount"), value: (row) => row.amount },
    { header: t("finance.common.currency"), value: (row) => row.currency },
    {
      header: t("financeReports.adjustments.common.reason"),
      value: (row) => t(REASON_CODE_LABEL_KEYS[row.reason_code]),
    },
    {
      header: t("financeReports.adjustments.common.status"),
      value: (row) => t(REFUND_STATUS_LABEL_KEYS[row.status]),
    },
    { header: t("finance.common.erpnextDocument"), value: (row) => row.erpnext_credit_note_id },
  ];

  return (
    <>
      <div className="adjustments-list__header">
        <div>
          <h1>{t("financeReports.adjustments.refunds.title")}</h1>
          <p>{t("financeReports.adjustments.refunds.description")}</p>
        </div>
        <div className="adjustments-list__header-actions">
          <ExportCsvButton
            filename="refunds"
            columns={exportColumns}
            getRows={() =>
              collectOffsetPages((pageOffset) =>
                fetchRefundsPage(filters, pageOffset, PAGINATION_MAX_LIMIT),
              )
            }
          />
          <Link to="/portal/finance/adjustments/refunds/new">
            <Button>{t("financeReports.adjustments.refunds.requestRefund")}</Button>
          </Link>
        </div>
      </div>

      <div className="adjustments-list__toolbar">
        <Select
          label={t("financeReports.adjustments.common.status")}
          options={statusOptions}
          value={status}
          onChange={changeStatus}
        />
      </div>

      <DataGrid
        caption={t("financeReports.adjustments.refunds.caption")}
        columns={columns}
        rows={items}
        getRowId={(row) => row.id}
        getRowLabel={(row) => row.erpnext_invoice_id}
        loading={listQuery.isPending}
        empty={
          listQuery.isError
            ? t("financeReports.adjustments.refunds.loadError")
            : t("financeReports.adjustments.refunds.empty")
        }
      />

      <div className="adjustments-list__pagination">
        <Button
          variant="secondary"
          disabled={!hasPreviousPage}
          onClick={() => setOffset(Math.max(0, offset - REFUNDS_PAGE_SIZE))}
        >
          {t("financeReports.adjustments.common.previous")}
        </Button>
        <Button
          variant="secondary"
          disabled={!hasNextPage}
          onClick={() => setOffset(offset + REFUNDS_PAGE_SIZE)}
        >
          {t("financeReports.adjustments.common.next")}
        </Button>
      </div>

      <AdjustmentConfirmDialog
        open={approveTarget !== null}
        title={t("financeReports.adjustments.refunds.approveTitle")}
        description={t("financeReports.adjustments.refunds.approveDescription")}
        confirmLabel={t("financeReports.adjustments.refunds.approveLabel")}
        loading={approveRefund.isPending}
        error={
          approveRefund.isError
            ? apiErrorMessage(
                approveRefund.error,
                t("financeReports.adjustments.refunds.approveError"),
              )
            : undefined
        }
        onConfirm={handleApprove}
        onClose={() => setApproveTarget(null)}
      >
        {approveTarget ? (
          <dl className="adjustments-effect">
            <div>
              <dt>{t("financeReports.adjustments.common.invoice")}</dt>
              <dd>{approveTarget.erpnext_invoice_id}</dd>
            </div>
            <div>
              <dt>{t("financeReports.adjustments.common.refundAmount")}</dt>
              <dd>
                {approveTarget.amount} {approveTarget.currency}
              </dd>
            </div>
            <div>
              <dt>{t("financeReports.adjustments.common.reason")}</dt>
              <dd>{t(REASON_CODE_LABEL_KEYS[approveTarget.reason_code])}</dd>
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
