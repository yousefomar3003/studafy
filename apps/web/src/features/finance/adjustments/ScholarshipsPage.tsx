import { PERMISSIONS } from "@studafy/constants";
import { Button, DataGrid, Select, useToast } from "@studafy/ui";
import { useQuery } from "@tanstack/react-query";
import { useState } from "react";

import { usePermissions } from "../../../lib/auth";
import { useFormatters, useTranslation } from "../../../lib/i18n";

import { AwardScholarshipModal } from "./AwardScholarshipModal";
import { DecideAwardModal } from "./DecideAwardModal";
import { ScholarshipFormModal } from "./ScholarshipFormModal";
import {
  AWARDS_PAGE_SIZE,
  discountSummary,
  fetchAwardsPage,
  fetchScholarships,
  SCHOLARSHIPS_KEY,
  useSetScholarshipActive,
} from "./scholarships-api";

import "./adjustments.css";

import type { AwardDecision, AwardStatus, Scholarship, ScholarshipAward } from "./scholarships-api";
import type { DataGridColumn, SelectOption } from "@studafy/ui";

const STATUS_TONE: Record<AwardStatus, "warning" | "success" | "danger" | undefined> = {
  pending_approval: "warning",
  approved: "success",
  rejected: "danger",
  revoked: undefined,
};

/**
 * Scholarships (`/portal/finance/scholarships`), gated by `billing:read`.
 *
 * Finance (`billing:update`) defines scholarships and requests awards for students; the school admin
 * (`billing:approveScholarship`, ORG_ADMIN only) approves, rejects or revokes them — the same split
 * as refunds, enforced by the API. The controls follow those permissions rather than offering
 * buttons that would always 403. Approved awards discount invoices generated from then on.
 */
export default function ScholarshipsPage() {
  const { t } = useTranslation();
  const { formatDate } = useFormatters();
  const { show } = useToast();
  const permissions = usePermissions();
  const canManage = permissions.has(PERMISSIONS.BILLING_UPDATE);
  const canDecide = permissions.has(PERMISSIONS.BILLING_APPROVE_SCHOLARSHIP);
  const setActive = useSetScholarshipActive();

  // The admin lands on what needs them: the approval queue.
  const [status, setStatus] = useState<AwardStatus | "">(canDecide ? "pending_approval" : "");
  const [offset, setOffset] = useState(0);
  const [formOpen, setFormOpen] = useState(false);
  const [awardOpen, setAwardOpen] = useState(false);
  const [decision, setDecision] = useState<{ award: ScholarshipAward; kind: AwardDecision } | null>(
    null,
  );

  const scholarships = useQuery({
    queryKey: [...SCHOLARSHIPS_KEY, "list"],
    queryFn: fetchScholarships,
  });
  const awards = useQuery({
    queryKey: [...SCHOLARSHIPS_KEY, "awards", status, offset],
    queryFn: () => fetchAwardsPage(status, offset),
  });

  const awardItems = awards.data?.items ?? [];
  const awardTotal = awards.data?.total ?? 0;
  const statusLabel = (value: AwardStatus) =>
    t(`financeReports.adjustments.scholarships.status.${value}`);
  const statusOptions: SelectOption<AwardStatus | "">[] = [
    { value: "", label: t("financeReports.adjustments.common.allStatuses") },
    ...(Object.keys(STATUS_TONE) as AwardStatus[]).map((value) => ({
      value,
      label: statusLabel(value),
    })),
  ];

  function toggleActive(row: Scholarship) {
    setActive.mutate(
      { id: row.id, isActive: !row.is_active },
      {
        onSuccess: () =>
          show({
            variant: "success",
            title: t(
              row.is_active
                ? "financeReports.adjustments.scholarships.deactivatedToast"
                : "financeReports.adjustments.scholarships.activatedToast",
            ),
          }),
      },
    );
  }

  const awardColumns: DataGridColumn<ScholarshipAward>[] = [
    {
      id: "student",
      header: t("financeReports.adjustments.scholarships.columns.student"),
      renderCell: (row) => row.student_name,
    },
    {
      id: "scholarship",
      header: t("financeReports.adjustments.scholarships.columns.scholarship"),
      renderCell: (row) => row.scholarship_name,
    },
    {
      id: "discount",
      header: t("financeReports.adjustments.scholarships.columns.discount"),
      renderCell: (row) => discountSummary(t, row),
    },
    {
      id: "requested",
      header: t("financeReports.adjustments.scholarships.columns.requested"),
      renderCell: (row) =>
        `${formatDate(new Date(row.created_at))}${row.requested_by_name ? ` · ${row.requested_by_name}` : ""}`,
    },
    {
      id: "status",
      header: t("financeReports.adjustments.common.status"),
      renderCell: (row) => (
        <span
          className="adjustments-status-pill"
          data-tone={STATUS_TONE[row.status]}
          title={row.decision_notes ?? undefined}
        >
          {statusLabel(row.status)}
        </span>
      ),
    },
    {
      id: "actions",
      header: t("financeReports.adjustments.common.actions"),
      renderCell: (row) =>
        canDecide ? (
          <div className="adjustments-list__row-actions">
            {row.status === "pending_approval" ? (
              <>
                <Button
                  type="button"
                  variant="secondary"
                  onClick={() => setDecision({ award: row, kind: "approve" })}
                >
                  {t("financeReports.adjustments.scholarships.approve")}
                </Button>
                <Button
                  type="button"
                  variant="tertiary"
                  onClick={() => setDecision({ award: row, kind: "reject" })}
                >
                  {t("financeReports.adjustments.scholarships.reject")}
                </Button>
              </>
            ) : null}
            {row.status === "approved" ? (
              <Button
                type="button"
                variant="tertiary"
                onClick={() => setDecision({ award: row, kind: "revoke" })}
              >
                {t("financeReports.adjustments.scholarships.revoke")}
              </Button>
            ) : null}
          </div>
        ) : null,
    },
  ];

  const scholarshipColumns: DataGridColumn<Scholarship>[] = [
    {
      id: "name",
      header: t("financeReports.adjustments.scholarships.columns.name"),
      renderCell: (row) => row.name,
    },
    {
      id: "discount",
      header: t("financeReports.adjustments.scholarships.columns.discount"),
      renderCell: (row) => discountSummary(t, row),
    },
    {
      id: "students",
      header: t("financeReports.adjustments.scholarships.columns.students"),
      align: "end",
      renderCell: (row) => row.approved_award_count,
    },
    {
      id: "active",
      header: t("financeReports.adjustments.common.status"),
      renderCell: (row) => (
        <span className="adjustments-status-pill" data-tone={row.is_active ? "success" : undefined}>
          {t(
            row.is_active
              ? "financeReports.adjustments.scholarships.active"
              : "financeReports.adjustments.scholarships.inactive",
          )}
        </span>
      ),
    },
    {
      id: "actions",
      header: t("financeReports.adjustments.common.actions"),
      renderCell: (row) =>
        canManage ? (
          <Button
            type="button"
            variant="tertiary"
            disabled={setActive.isPending}
            onClick={() => toggleActive(row)}
          >
            {t(
              row.is_active
                ? "financeReports.adjustments.scholarships.deactivate"
                : "financeReports.adjustments.scholarships.activate",
            )}
          </Button>
        ) : null,
    },
  ];

  return (
    <>
      <div className="adjustments-list__header">
        <div>
          <h1>{t("financeReports.adjustments.scholarships.title")}</h1>
          <p>{t("financeReports.adjustments.scholarships.description")}</p>
        </div>
        {canManage ? (
          <div className="adjustments-list__row-actions">
            <Button variant="secondary" onClick={() => setFormOpen(true)}>
              {t("financeReports.adjustments.scholarships.newScholarship")}
            </Button>
            <Button
              onClick={() => setAwardOpen(true)}
              disabled={!scholarships.data?.some((s) => s.is_active)}
            >
              {t("financeReports.adjustments.scholarships.awardStudent")}
            </Button>
          </div>
        ) : null}
      </div>

      <h2>{t("financeReports.adjustments.scholarships.awardsHeading")}</h2>
      <div className="adjustments-list__toolbar">
        <Select
          label={t("financeReports.adjustments.common.status")}
          options={statusOptions}
          value={status}
          onChange={(next) => {
            setStatus(next);
            setOffset(0);
          }}
        />
      </div>
      <DataGrid
        caption={t("financeReports.adjustments.scholarships.awardsCaption")}
        columns={awardColumns}
        rows={awardItems}
        getRowId={(row) => row.id}
        getRowLabel={(row) => `${row.student_name} — ${row.scholarship_name}`}
        loading={awards.isPending}
        empty={
          awards.isError
            ? t("financeReports.adjustments.scholarships.loadError")
            : t("financeReports.adjustments.scholarships.awardsEmpty")
        }
      />
      <div className="adjustments-list__pagination">
        <Button
          variant="secondary"
          disabled={offset === 0}
          onClick={() => setOffset(Math.max(0, offset - AWARDS_PAGE_SIZE))}
        >
          {t("financeReports.adjustments.common.previous")}
        </Button>
        <Button
          variant="secondary"
          disabled={offset + awardItems.length >= awardTotal}
          onClick={() => setOffset(offset + AWARDS_PAGE_SIZE)}
        >
          {t("financeReports.adjustments.common.next")}
        </Button>
      </div>

      <h2>{t("financeReports.adjustments.scholarships.catalogHeading")}</h2>
      <DataGrid
        caption={t("financeReports.adjustments.scholarships.catalogCaption")}
        columns={scholarshipColumns}
        rows={scholarships.data ?? []}
        getRowId={(row) => row.id}
        getRowLabel={(row) => row.name}
        loading={scholarships.isPending}
        empty={
          scholarships.isError
            ? t("financeReports.adjustments.scholarships.loadError")
            : t("financeReports.adjustments.scholarships.catalogEmpty")
        }
      />

      {formOpen ? <ScholarshipFormModal open onClose={() => setFormOpen(false)} /> : null}
      {awardOpen ? (
        <AwardScholarshipModal
          open
          scholarships={scholarships.data ?? []}
          onClose={() => setAwardOpen(false)}
        />
      ) : null}
      <DecideAwardModal
        key={decision ? `${decision.award.id}-${decision.kind}` : "closed"}
        award={decision?.award ?? null}
        decision={decision?.kind ?? "approve"}
        onClose={() => setDecision(null)}
      />
    </>
  );
}
