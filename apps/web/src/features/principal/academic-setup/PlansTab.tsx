import { Button, Modal, Select, Table, useToast } from "@studafy/ui";
import { useState } from "react";

import { useFormatters, useTranslation } from "../../../lib/i18n";
import { useTerms } from "../school/queries";

import { usePlanCoverage, usePlanDetail, usePlanReviews, useReviewPlan } from "./academic-planning";
import { Badge, QueryState, TextArea } from "./components";
import { problemMessage } from "./errors";

import type { PlanKind, PlanStatus } from "./academic-planning";
import type { BadgeTone } from "./components";
import type { SetupContext } from "./context";

const STATUS_TONE: Record<PlanStatus, BadgeTone> = {
  draft: "neutral",
  submitted: "info",
  approved: "success",
  returned: "warning",
};

const STATUSES: readonly PlanStatus[] = ["submitted", "returned", "approved", "draft"];

/**
 * Lesson and term plans (000268) for leadership: per-term coverage (the term plan and whether it
 * came in on time, lesson plans by status and timeliness, outcomes the submitted plans cover), and
 * the plans awaiting review, approved or returned with a comment here. Teachers write the plans and
 * coordinators review theirs in the mobile app.
 */
export function PlansTab({ ctx }: { ctx: SetupContext }) {
  return (
    <>
      <CoverageBlock ctx={ctx} />
      <ReviewBlock ctx={ctx} />
    </>
  );
}

function PlanStatusBadge({ status }: { status: PlanStatus }) {
  const { t } = useTranslation();
  return (
    <Badge tone={STATUS_TONE[status] ?? "neutral"}>
      {t(`academicGrading.plans.status.${status}`)}
    </Badge>
  );
}

function CoverageBlock({ ctx }: { ctx: SetupContext }) {
  const { t } = useTranslation();
  const { formatDate } = useFormatters();
  const terms = useTerms(ctx.year.id);
  const termList = [...(terms.data ?? [])].sort((a, b) => a.sequence_number - b.sequence_number);
  const [pickedTermId, setPickedTermId] = useState<string>();
  const termId = pickedTermId ?? termList[0]?.id;
  const coverage = usePlanCoverage(termId);

  return (
    <section className="ag-block" aria-labelledby="ag-plan-coverage-heading">
      <h2 id="ag-plan-coverage-heading">{t("academicGrading.plans.coverageHeading")}</h2>
      <p className="ag-muted">{t("academicGrading.plans.coverageHelp")}</p>
      <QueryState
        isPending={terms.isPending}
        error={terms.error}
        empty={termList.length === 0}
        emptyText={t("academicGrading.plans.noTerms")}
      >
        <div className="principal-school__filters">
          <Select
            label={t("academicGrading.plans.term")}
            options={termList.map((term) => ({ value: term.id, label: term.name }))}
            value={termId}
            onChange={setPickedTermId}
          />
        </div>
        <Table caption={t("academicGrading.plans.coverageCaption")} hideCaption>
          <Table.Header>
            <Table.Row>
              <Table.HeaderCell>{t("academicGrading.plans.columns.class")}</Table.HeaderCell>
              <Table.HeaderCell>{t("academicGrading.plans.columns.teachers")}</Table.HeaderCell>
              <Table.HeaderCell>{t("academicGrading.plans.columns.termPlan")}</Table.HeaderCell>
              <Table.HeaderCell>{t("academicGrading.plans.columns.lessons")}</Table.HeaderCell>
              <Table.HeaderCell>{t("academicGrading.plans.columns.outcomes")}</Table.HeaderCell>
            </Table.Row>
          </Table.Header>
          <Table.Body
            columnCount={5}
            loading={coverage.isPending && termId !== undefined}
            empty={
              coverage.isError
                ? problemMessage(coverage.error, t)
                : t("academicGrading.plans.coverageEmpty")
            }
          >
            {(coverage.data?.rows ?? []).map((row) => (
              <Table.Row key={`${row.section_id}|${row.subject_id}`}>
                <Table.Cell>
                  <strong>{row.subject_name}</strong>{" "}
                  <span className="ag-muted">
                    {row.grade_level_name} {row.section_name}
                  </span>
                </Table.Cell>
                <Table.Cell>{row.teacher_names.join(", ") || "—"}</Table.Cell>
                <Table.Cell>
                  {row.term_plan ? (
                    <>
                      <PlanStatusBadge status={row.term_plan.status} />{" "}
                      {row.term_plan.on_time === false ? (
                        <Badge tone="warning">{t("academicGrading.plans.late")}</Badge>
                      ) : null}
                    </>
                  ) : (
                    <span className="ag-muted">
                      {t("academicGrading.plans.notStarted", {
                        date: formatDate(new Date(row.term_plan_due_on), { dateStyle: "medium" }),
                      })}
                    </span>
                  )}
                </Table.Cell>
                <Table.Cell>
                  {t("academicGrading.plans.lessonCounts", {
                    total: row.lesson_plans.total,
                    approved: row.lesson_plans.approved,
                    onTime: row.lesson_plans.on_time,
                    late: row.lesson_plans.late,
                    overdue: row.lesson_plans.overdue,
                  })}
                </Table.Cell>
                <Table.Cell>
                  {t("academicGrading.plans.outcomeCoverage", {
                    covered: row.outcomes.covered,
                    total: row.outcomes.total,
                  })}
                </Table.Cell>
              </Table.Row>
            ))}
          </Table.Body>
        </Table>
      </QueryState>
    </section>
  );
}

interface QueueItem {
  kind: PlanKind;
  id: string;
  title: string;
  when: string;
  subject: string;
  section: string;
  author: string | null;
  status: PlanStatus;
  onTime: boolean | null;
  canReview: boolean;
}

function ReviewBlock({ ctx }: { ctx: SetupContext }) {
  const { t } = useTranslation();
  const { formatDate } = useFormatters();
  const [status, setStatus] = useState<PlanStatus>("submitted");
  const reviews = usePlanReviews(ctx.year.id, status);
  const [open, setOpen] = useState<QueueItem | null>(null);

  const items: QueueItem[] = [
    ...(reviews.data?.term_plans ?? []).map((plan) => ({
      kind: "term" as const,
      id: plan.id,
      title: t("academicGrading.plans.termPlanTitle", { term: plan.term_name ?? "" }),
      when: plan.term_name ?? "",
      subject: plan.subject_name,
      section: `${plan.grade_level_name} ${plan.section_name}`,
      author: plan.author_name,
      status: plan.status,
      onTime: plan.on_time,
      canReview: plan.can_review,
    })),
    ...(reviews.data?.lesson_plans ?? []).map((plan) => ({
      kind: "lesson" as const,
      id: plan.id,
      title: plan.title,
      when: formatDate(new Date(plan.lesson_date), { dateStyle: "medium" }),
      subject: plan.subject_name,
      section: `${plan.grade_level_name} ${plan.section_name}`,
      author: plan.author_name,
      status: plan.status,
      onTime: plan.on_time,
      canReview: plan.can_review,
    })),
  ];

  return (
    <section className="ag-block" aria-labelledby="ag-plan-reviews-heading">
      <h2 id="ag-plan-reviews-heading">{t("academicGrading.plans.reviewsHeading")}</h2>
      <p className="ag-muted">{t("academicGrading.plans.reviewsHelp")}</p>
      <div className="principal-school__filters">
        <Select
          label={t("academicGrading.plans.statusFilter")}
          options={STATUSES.map((value) => ({
            value,
            label: t(`academicGrading.plans.status.${value}`),
          }))}
          value={status}
          onChange={setStatus}
        />
      </div>
      <Table caption={t("academicGrading.plans.reviewsCaption")} hideCaption>
        <Table.Header>
          <Table.Row>
            <Table.HeaderCell>{t("academicGrading.plans.columns.plan")}</Table.HeaderCell>
            <Table.HeaderCell>{t("academicGrading.plans.columns.class")}</Table.HeaderCell>
            <Table.HeaderCell>{t("academicGrading.plans.columns.author")}</Table.HeaderCell>
            <Table.HeaderCell>{t("academicGrading.plans.columns.status")}</Table.HeaderCell>
            <Table.HeaderCell>{t("academicGrading.plans.columns.actions")}</Table.HeaderCell>
          </Table.Row>
        </Table.Header>
        <Table.Body
          columnCount={5}
          loading={reviews.isPending}
          empty={
            reviews.isError
              ? problemMessage(reviews.error, t)
              : t("academicGrading.plans.reviewsEmpty")
          }
        >
          {items.map((item) => (
            <Table.Row key={`${item.kind}-${item.id}`}>
              <Table.Cell>
                <strong>{item.title}</strong>{" "}
                <span className="ag-muted">
                  {t(`academicGrading.plans.kind.${item.kind}`)} · {item.when}
                </span>
              </Table.Cell>
              <Table.Cell>
                {item.subject} · {item.section}
              </Table.Cell>
              <Table.Cell>{item.author ?? "—"}</Table.Cell>
              <Table.Cell>
                <PlanStatusBadge status={item.status} />{" "}
                {item.onTime === false ? (
                  <Badge tone="warning">{t("academicGrading.plans.late")}</Badge>
                ) : null}
              </Table.Cell>
              <Table.Cell>
                <Button
                  type="button"
                  variant="secondary"
                  aria-label={t("academicGrading.plans.openLabel", { title: item.title })}
                  onClick={() => setOpen(item)}
                >
                  {item.canReview
                    ? t("academicGrading.plans.review")
                    : t("academicGrading.common.view")}
                </Button>
              </Table.Cell>
            </Table.Row>
          ))}
        </Table.Body>
      </Table>
      {open ? <PlanModal key={open.id} item={open} onClose={() => setOpen(null)} /> : null}
    </section>
  );
}

/** A plan's content, with approve / return for a plan the viewer may review. */
function PlanModal({ item, onClose }: { item: QueueItem; onClose: () => void }) {
  const { t } = useTranslation();
  const { show } = useToast();
  const detail = usePlanDetail(item.kind, item.id);
  const review = useReviewPlan();
  const [comment, setComment] = useState("");
  const [touched, setTouched] = useState(false);
  const canReview = detail.data?.plan.can_review ?? false;

  function decide(decision: "approve" | "return") {
    if (decision === "return" && comment.trim() === "") {
      setTouched(true);
      return;
    }
    review.mutate(
      { kind: item.kind, planId: item.id, decision, comment: comment.trim() || null },
      {
        onSuccess: () => {
          show({
            variant: "success",
            title: t(
              decision === "approve"
                ? "academicGrading.plans.approved"
                : "academicGrading.plans.returned",
            ),
          });
          onClose();
        },
      },
    );
  }

  return (
    <Modal open onClose={onClose} title={item.title}>
      <Modal.Body>
        <QueryState isPending={detail.isPending} error={detail.error}>
          {detail.data ? <PlanContent detail={detail.data} /> : null}
        </QueryState>
        {canReview ? (
          <TextArea
            label={t("academicGrading.plans.comment")}
            value={comment}
            onChange={setComment}
            error={
              touched && comment.trim() === ""
                ? t("academicGrading.plans.commentRequired")
                : undefined
            }
          />
        ) : null}
        {review.error ? (
          <p className="ag-error" role="alert">
            {problemMessage(review.error, t)}
          </p>
        ) : null}
      </Modal.Body>
      <Modal.Footer>
        <Button type="button" variant="tertiary" onClick={onClose}>
          {t("academicGrading.common.cancel")}
        </Button>
        {canReview ? (
          <>
            <Button
              type="button"
              variant="secondary"
              loading={review.isPending}
              onClick={() => decide("return")}
            >
              {t("academicGrading.plans.return")}
            </Button>
            <Button type="button" loading={review.isPending} onClick={() => decide("approve")}>
              {t("academicGrading.plans.approve")}
            </Button>
          </>
        ) : null}
      </Modal.Footer>
    </Modal>
  );
}

function PlanContent({
  detail,
}: {
  detail: NonNullable<ReturnType<typeof usePlanDetail>["data"]>;
}) {
  const { t } = useTranslation();
  const outcomeList = (outcomes: readonly { id: string; code: string; text: string }[]) =>
    outcomes.length === 0 ? null : (
      <ul>
        {outcomes.map((outcome) => (
          <li key={outcome.id}>
            <strong>{outcome.code}</strong> {outcome.text}
          </li>
        ))}
      </ul>
    );
  const field = (label: string, value: string | null) =>
    value ? (
      <div>
        <h3 className="ag-subheading">{label}</h3>
        <p className="ag-pre">{value}</p>
      </div>
    ) : null;

  const plan = detail.plan;
  return (
    <div className="ag-plan">
      <p className="ag-muted">
        {plan.subject_name} · {plan.grade_level_name} {plan.section_name} ·{" "}
        {plan.author_name ?? "—"}
      </p>
      {plan.review_comment ? (
        <p className="ag-notice">
          {t("academicGrading.plans.lastComment", { comment: plan.review_comment })}
        </p>
      ) : null}
      {detail.kind === "term" ? (
        <>
          {field(t("academicGrading.plans.notes"), detail.plan.notes)}
          {detail.plan.weeks.map((week) => (
            <div key={week.week_number}>
              <h3 className="ag-subheading">
                {t("academicGrading.plans.week", { n: week.week_number })}
                {week.unit ? ` · ${week.unit}` : ""}
              </h3>
              {week.notes ? <p className="ag-pre">{week.notes}</p> : null}
              {outcomeList(week.outcomes)}
            </div>
          ))}
        </>
      ) : (
        <>
          {detail.plan.period !== null ? (
            <p>{t("academicGrading.plans.period", { n: detail.plan.period })}</p>
          ) : null}
          {field(t("academicGrading.plans.objectives"), detail.plan.objectives)}
          {detail.plan.outcomes.length > 0 ? (
            <div>
              <h3 className="ag-subheading">{t("academicGrading.plans.outcomes")}</h3>
              {outcomeList(detail.plan.outcomes)}
            </div>
          ) : null}
          {field(t("academicGrading.plans.activities"), detail.plan.activities)}
          {field(t("academicGrading.plans.resources"), detail.plan.resources)}
          {detail.plan.materials.length > 0 ? (
            <div>
              <h3 className="ag-subheading">{t("academicGrading.plans.materials")}</h3>
              <ul>
                {detail.plan.materials.map((material) => (
                  <li key={material.id}>{material.title}</li>
                ))}
              </ul>
            </div>
          ) : null}
          {field(t("academicGrading.plans.homework"), detail.plan.homework)}
          {field(t("academicGrading.plans.reflection"), detail.plan.reflection)}
        </>
      )}
    </div>
  );
}
