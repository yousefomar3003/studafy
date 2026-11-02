import { ApiError } from "@studafy/api-client";
import { PERMISSIONS } from "@studafy/constants";
import { Button, Card, useToast } from "@studafy/ui";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { Link, useParams } from "react-router-dom";

import { useAuth, usePermissions } from "../../../lib/auth";
import { useFormatters, useTranslation } from "../../../lib/i18n";

import { AdjustmentConfirmDialog } from "./AdjustmentConfirmDialog";
import {
  REASON_CODE_LABEL_KEYS,
  REFUND_KIND_EFFECT_KEYS,
  REFUND_KIND_LABEL_KEYS,
  REFUND_STATUS_LABEL_KEYS,
  refundStatusTone,
} from "./labels";
import { useApproveRefund } from "./mutations";
import { fetchRefund, refundQueryKey } from "./queries";
import { RejectRefundModal } from "./RejectRefundModal";

import "./adjustments.css";

function apiErrorMessage(error: unknown, fallback: string): string {
  if (!(error instanceof ApiError)) return fallback;
  return error.detail ?? error.title;
}

/**
 * One refund or correction request (`/portal/finance/adjustments/refunds/:refundId`), gated by
 * `billing:read`: what was asked, why, by when it was decided, and what approval does. A checker
 * (`billing:refund`, never the maker) approves or rejects it here as from the list.
 */
export default function RefundDetailPage() {
  const { t } = useTranslation();
  const { formatDate } = useFormatters();
  const formatDateTime = (value: Date) =>
    formatDate(value, { dateStyle: "medium", timeStyle: "short" });
  const { show } = useToast();
  const { userId } = useAuth();
  const canDecide = usePermissions().has(PERMISSIONS.BILLING_REFUND);
  const { refundId = "" } = useParams<{ refundId: string }>();
  const queryClient = useQueryClient();
  const approve = useApproveRefund();
  const [confirming, setConfirming] = useState(false);
  const [rejecting, setRejecting] = useState(false);

  const query = useQuery({
    queryKey: refundQueryKey(refundId),
    queryFn: () => fetchRefund(refundId),
    enabled: refundId !== "",
  });

  function refresh() {
    void queryClient.invalidateQueries({ queryKey: ["finance", "refunds", refundId] });
    void queryClient.invalidateQueries({ queryKey: ["finance", "adjustments", "refunds"] });
    void queryClient.invalidateQueries({ queryKey: ["finance", "invoices"] });
    void queryClient.invalidateQueries({ queryKey: ["finance", "payments"] });
  }

  if (query.isPending) return <p role="status">{t("finance.common.loading")}</p>;
  if (query.isError) {
    return <p role="alert">{t("financeReports.adjustments.detail.loadError")}</p>;
  }

  const request = query.data;
  const isOwn = request.maker_id === userId;
  const decidable = request.status === "pending_approval" && canDecide;

  function handleApprove() {
    approve.mutate(request.id, {
      onSuccess: () => {
        show({ variant: "success", title: t("financeReports.adjustments.refunds.approvedToast") });
        setConfirming(false);
        refresh();
      },
    });
  }

  const rows: [string, string][] = [
    [t("financeReports.adjustments.common.kind"), t(REFUND_KIND_LABEL_KEYS[request.kind])],
    [t("financeReports.adjustments.common.invoice"), request.erpnext_invoice_id],
    [t("financeReports.adjustments.common.amount"), `${request.amount} ${request.currency}`],
    [t("financeReports.adjustments.common.reason"), t(REASON_CODE_LABEL_KEYS[request.reason_code])],
    [t("financeReports.adjustments.detail.notes"), request.reason_notes ?? "—"],
    [t("financeReports.adjustments.common.created"), formatDateTime(new Date(request.created_at))],
    [
      t("financeReports.adjustments.detail.approvedAt"),
      request.approved_at ? formatDateTime(new Date(request.approved_at)) : "—",
    ],
    [
      t("financeReports.adjustments.detail.completedAt"),
      request.completed_at ? formatDateTime(new Date(request.completed_at)) : "—",
    ],
  ];
  if (request.erpnext_credit_note_id) {
    rows.push([t("financeReports.adjustments.detail.creditNote"), request.erpnext_credit_note_id]);
  }

  return (
    <div className="adjustments-detail">
      <div className="adjustments-list__header">
        <div>
          <h1>{t(REFUND_KIND_LABEL_KEYS[request.kind])}</h1>
          <p>{t(REFUND_KIND_EFFECT_KEYS[request.kind])}</p>
        </div>
        <span className="adjustments-status-pill" data-tone={refundStatusTone(request.status)}>
          {t(REFUND_STATUS_LABEL_KEYS[request.status])}
        </span>
      </div>

      <Card as="section" aria-label={t("financeReports.adjustments.detail.label")}>
        <Card.Body>
          <dl className="adjustments-effect">
            {rows.map(([label, value]) => (
              <div key={label}>
                <dt>{label}</dt>
                <dd>{value}</dd>
              </div>
            ))}
          </dl>
          <Link to={`/portal/finance/students/${request.student_id}`}>
            {t("financeReports.adjustments.detail.studentAccount")}
          </Link>
        </Card.Body>
      </Card>

      {decidable ? (
        <div className="adjustments-detail__actions">
          <Button
            type="button"
            disabled={isOwn}
            title={isOwn ? t("financeReports.adjustments.refunds.ownApproveHint") : undefined}
            onClick={() => setConfirming(true)}
          >
            {t("financeReports.adjustments.refunds.approve")}
          </Button>
          <Button
            type="button"
            variant="secondary"
            disabled={isOwn}
            title={isOwn ? t("financeReports.adjustments.refunds.ownRejectHint") : undefined}
            onClick={() => setRejecting(true)}
          >
            {t("financeReports.adjustments.refunds.reject")}
          </Button>
        </div>
      ) : null}

      <AdjustmentConfirmDialog
        open={confirming}
        title={t("financeReports.adjustments.refunds.approveTitle")}
        description={t(REFUND_KIND_EFFECT_KEYS[request.kind])}
        confirmLabel={t("financeReports.adjustments.refunds.approveLabel")}
        loading={approve.isPending}
        error={
          approve.isError
            ? apiErrorMessage(approve.error, t("financeReports.adjustments.refunds.approveError"))
            : undefined
        }
        onConfirm={handleApprove}
        onClose={() => setConfirming(false)}
      >
        <dl className="adjustments-effect">
          <div>
            <dt>{t("financeReports.adjustments.common.invoice")}</dt>
            <dd>{request.erpnext_invoice_id}</dd>
          </div>
          <div>
            <dt>{t("financeReports.adjustments.common.amount")}</dt>
            <dd>
              {request.amount} {request.currency}
            </dd>
          </div>
        </dl>
      </AdjustmentConfirmDialog>

      <RejectRefundModal
        key={rejecting ? request.id : "closed"}
        refund={rejecting ? request : null}
        onClose={() => setRejecting(false)}
        onRejected={() => {
          setRejecting(false);
          refresh();
        }}
      />
    </div>
  );
}
