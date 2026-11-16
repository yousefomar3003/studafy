import { Button, Select, Table, useToast } from "@studafy/ui";
import { useState } from "react";

import { useTranslation } from "../../../lib/i18n";

import { DateTime, Num, ReasonModal } from "./components";
import { problemMessage } from "./errors";
import { useDecideAssessment, useDecideAssessmentRelease, useDecideMarkSheet } from "./mutations";
import { useAssessmentReleases, useMarkSheets, useProposedAssessments } from "./queries";

import type { SetupContext } from "./context";
import type {
  AssessmentReleaseStatusFilter,
  AssessmentReleaseSummary,
  MarkSheetStatusFilter,
  MarkSheetSummary,
} from "./queries";

const SHEET_FILTERS: readonly MarkSheetStatusFilter[] = ["submitted", "approved", "returned"];
const RELEASE_FILTERS: readonly AssessmentReleaseStatusFilter[] = [
  "submitted",
  "approved",
  "returned",
];

type ReasonTarget =
  | { kind: "sheet"; sheet: MarkSheetSummary; action: "return" | "reopen" }
  | { kind: "release"; release: AssessmentReleaseSummary; action: "return" | "reopen" };

/**
 * The year's approval queue: mark sheets teachers submitted (approve, or return with a reason;
 * approved sheets can be reopened), single assessments teachers sent on their own before the rest
 * of the period (approved, their marks reach students and parents; returned or withdrawn with a
 * reason), and assessments teachers proposed for their sections.
 */
export function ApprovalsTab({ ctx }: { ctx: SetupContext }) {
  const { t } = useTranslation();
  const { show } = useToast();
  const [filter, setFilter] = useState<MarkSheetStatusFilter>("submitted");
  const sheets = useMarkSheets(ctx.year.id, filter);
  const [releaseFilter, setReleaseFilter] = useState<AssessmentReleaseStatusFilter>("submitted");
  const releases = useAssessmentReleases(ctx.year.id, releaseFilter);
  const proposed = useProposedAssessments(ctx.year.id);
  const decideSheet = useDecideMarkSheet();
  const decideRelease = useDecideAssessmentRelease();
  const decideAssessment = useDecideAssessment();
  const [reasonFor, setReasonFor] = useState<ReasonTarget | null>(null);

  const sheetName = (sheet: MarkSheetSummary) =>
    t("academicGrading.approvals.sheetName", {
      subject: sheet.subject_name,
      grade: sheet.grade_level_name,
      section: sheet.section_name,
    });

  const releaseName = (release: AssessmentReleaseSummary) =>
    t("academicGrading.approvals.releaseName", {
      assessment: release.assessment_name,
      subject: release.subject_name,
      grade: release.grade_level_name,
      section: release.section_name,
    });

  function decideOnRelease(
    release: AssessmentReleaseSummary,
    action: "approve" | "return" | "reopen",
    reason?: string,
  ) {
    decideRelease.mutate(
      { releaseId: release.id, action, reason },
      {
        onSuccess: () => {
          show({
            variant: "success",
            title: t(`academicGrading.approvals.releaseDone.${action}`),
          });
          setReasonFor(null);
        },
        onError: (error) =>
          show({
            variant: "error",
            title: t("academicGrading.approvals.failed"),
            description: problemMessage(error, t),
          }),
      },
    );
  }

  function decide(
    sheet: MarkSheetSummary,
    action: "approve" | "return" | "reopen",
    reason?: string,
  ) {
    decideSheet.mutate(
      { sheetId: sheet.id, action, reason },
      {
        onSuccess: () => {
          show({ variant: "success", title: t(`academicGrading.approvals.done.${action}`) });
          setReasonFor(null);
        },
        onError: (error) =>
          show({
            variant: "error",
            title: t("academicGrading.approvals.failed"),
            description: problemMessage(error, t),
          }),
      },
    );
  }

  return (
    <>
      <section className="ag-block" aria-labelledby="ag-sheets-heading">
        <h2 id="ag-sheets-heading">{t("academicGrading.approvals.sheetsHeading")}</h2>
        <div className="principal-school__filters">
          <Select<MarkSheetStatusFilter>
            label={t("academicGrading.approvals.filter")}
            options={SHEET_FILTERS.map((value) => ({
              value,
              label: t(`academicGrading.sheetStatus.${value}`),
            }))}
            value={filter}
            onChange={setFilter}
          />
        </div>
        <Table caption={t("academicGrading.approvals.sheetsCaption")} hideCaption>
          <Table.Header>
            <Table.Row>
              <Table.HeaderCell>{t("academicGrading.approvals.columns.sheet")}</Table.HeaderCell>
              <Table.HeaderCell>{t("academicGrading.approvals.columns.period")}</Table.HeaderCell>
              <Table.HeaderCell>
                {t("academicGrading.approvals.columns.submittedBy")}
              </Table.HeaderCell>
              <Table.HeaderCell>
                {t("academicGrading.approvals.columns.submittedAt")}
              </Table.HeaderCell>
              <Table.HeaderCell>{t("academicGrading.approvals.columns.actions")}</Table.HeaderCell>
            </Table.Row>
          </Table.Header>
          <Table.Body
            columnCount={5}
            loading={sheets.isPending}
            empty={
              sheets.isError
                ? problemMessage(sheets.error, t)
                : t(`academicGrading.approvals.empty.${filter}`)
            }
          >
            {(sheets.data ?? []).map((sheet) => {
              const name = sheetName(sheet);
              return (
                <Table.Row key={sheet.id}>
                  <Table.Cell>
                    {name}
                    {sheet.return_reason ? (
                      <div className="ag-muted">
                        {t("academicGrading.approvals.returnReason", {
                          reason: sheet.return_reason,
                        })}
                      </div>
                    ) : null}
                  </Table.Cell>
                  <Table.Cell>{sheet.term_name ?? t("academicGrading.results.annual")}</Table.Cell>
                  <Table.Cell>{sheet.submitted_by_name ?? "—"}</Table.Cell>
                  <Table.Cell>
                    <DateTime value={sheet.submitted_at} />
                  </Table.Cell>
                  <Table.Cell>
                    <div className="sections-page__row-actions">
                      {sheet.status === "submitted" ? (
                        <>
                          <Button
                            type="button"
                            aria-label={t("academicGrading.approvals.approveLabel", { name })}
                            loading={
                              decideSheet.isPending && decideSheet.variables?.sheetId === sheet.id
                            }
                            onClick={() => decide(sheet, "approve")}
                          >
                            {t("academicGrading.approvals.approve")}
                          </Button>
                          <Button
                            type="button"
                            variant="secondary"
                            aria-label={t("academicGrading.approvals.returnLabel", { name })}
                            onClick={() => setReasonFor({ kind: "sheet", sheet, action: "return" })}
                          >
                            {t("academicGrading.approvals.return")}
                          </Button>
                        </>
                      ) : null}
                      {sheet.status === "approved" ? (
                        <Button
                          type="button"
                          variant="secondary"
                          aria-label={t("academicGrading.approvals.reopenLabel", { name })}
                          onClick={() => setReasonFor({ kind: "sheet", sheet, action: "reopen" })}
                        >
                          {t("academicGrading.approvals.reopen")}
                        </Button>
                      ) : null}
                    </div>
                  </Table.Cell>
                </Table.Row>
              );
            })}
          </Table.Body>
        </Table>
      </section>

      <section className="ag-block" aria-labelledby="ag-releases-heading">
        <h2 id="ag-releases-heading">{t("academicGrading.approvals.releasesHeading")}</h2>
        <p className="ag-muted">{t("academicGrading.approvals.releasesHelp")}</p>
        <div className="principal-school__filters">
          <Select<AssessmentReleaseStatusFilter>
            label={t("academicGrading.approvals.filter")}
            options={RELEASE_FILTERS.map((value) => ({
              value,
              label: t(`academicGrading.approvals.releaseStatus.${value}`),
            }))}
            value={releaseFilter}
            onChange={setReleaseFilter}
          />
        </div>
        <Table caption={t("academicGrading.approvals.releasesCaption")} hideCaption>
          <Table.Header>
            <Table.Row>
              <Table.HeaderCell>
                {t("academicGrading.approvals.columns.assessment")}
              </Table.HeaderCell>
              <Table.HeaderCell>{t("academicGrading.approvals.columns.period")}</Table.HeaderCell>
              <Table.HeaderCell>
                {t("academicGrading.approvals.columns.submittedBy")}
              </Table.HeaderCell>
              <Table.HeaderCell>
                {t("academicGrading.approvals.columns.submittedAt")}
              </Table.HeaderCell>
              <Table.HeaderCell>{t("academicGrading.approvals.columns.actions")}</Table.HeaderCell>
            </Table.Row>
          </Table.Header>
          <Table.Body
            columnCount={5}
            loading={releases.isPending}
            empty={
              releases.isError
                ? problemMessage(releases.error, t)
                : t(`academicGrading.approvals.releasesEmpty.${releaseFilter}`)
            }
          >
            {(releases.data ?? []).map((release) => {
              const name = releaseName(release);
              return (
                <Table.Row key={release.id}>
                  <Table.Cell>
                    {name}
                    <div className="ag-muted">
                      {t("academicGrading.approvals.releaseMaxMarks", {
                        max: release.max_marks,
                      })}
                    </div>
                    {release.return_reason ? (
                      <div className="ag-muted">
                        {t("academicGrading.approvals.returnReason", {
                          reason: release.return_reason,
                        })}
                      </div>
                    ) : null}
                  </Table.Cell>
                  <Table.Cell>
                    {release.term_name ?? t("academicGrading.results.annual")}
                  </Table.Cell>
                  <Table.Cell>{release.submitted_by_name ?? "—"}</Table.Cell>
                  <Table.Cell>
                    <DateTime value={release.submitted_at} />
                  </Table.Cell>
                  <Table.Cell>
                    <div className="sections-page__row-actions">
                      {release.status === "submitted" ? (
                        <>
                          <Button
                            type="button"
                            aria-label={t("academicGrading.approvals.releaseApproveLabel", {
                              name,
                            })}
                            loading={
                              decideRelease.isPending &&
                              decideRelease.variables?.releaseId === release.id
                            }
                            onClick={() => decideOnRelease(release, "approve")}
                          >
                            {t("academicGrading.approvals.releaseApprove")}
                          </Button>
                          <Button
                            type="button"
                            variant="secondary"
                            aria-label={t("academicGrading.approvals.returnLabel", { name })}
                            onClick={() =>
                              setReasonFor({ kind: "release", release, action: "return" })
                            }
                          >
                            {t("academicGrading.approvals.return")}
                          </Button>
                        </>
                      ) : null}
                      {release.status === "approved" ? (
                        <Button
                          type="button"
                          variant="secondary"
                          aria-label={t("academicGrading.approvals.withdrawLabel", { name })}
                          onClick={() =>
                            setReasonFor({ kind: "release", release, action: "reopen" })
                          }
                        >
                          {t("academicGrading.approvals.withdraw")}
                        </Button>
                      ) : null}
                    </div>
                  </Table.Cell>
                </Table.Row>
              );
            })}
          </Table.Body>
        </Table>
      </section>

      <section className="ag-block" aria-labelledby="ag-proposed-heading">
        <h2 id="ag-proposed-heading">{t("academicGrading.approvals.proposedHeading")}</h2>
        <p className="ag-muted">{t("academicGrading.approvals.proposedHelp")}</p>
        <Table caption={t("academicGrading.approvals.proposedCaption")} hideCaption>
          <Table.Header>
            <Table.Row>
              <Table.HeaderCell>
                {t("academicGrading.approvals.columns.assessment")}
              </Table.HeaderCell>
              <Table.HeaderCell>{t("academicGrading.approvals.columns.subject")}</Table.HeaderCell>
              <Table.HeaderCell>{t("academicGrading.approvals.columns.section")}</Table.HeaderCell>
              <Table.HeaderCell>{t("academicGrading.approvals.columns.maxMarks")}</Table.HeaderCell>
              <Table.HeaderCell>
                {t("academicGrading.approvals.columns.proposedBy")}
              </Table.HeaderCell>
              <Table.HeaderCell>{t("academicGrading.approvals.columns.actions")}</Table.HeaderCell>
            </Table.Row>
          </Table.Header>
          <Table.Body
            columnCount={6}
            loading={proposed.isPending}
            empty={
              proposed.isError
                ? problemMessage(proposed.error, t)
                : t("academicGrading.approvals.noProposed")
            }
          >
            {(proposed.data ?? []).map((assessment) => (
              <Table.Row key={assessment.id}>
                <Table.Cell>{assessment.name}</Table.Cell>
                <Table.Cell>{assessment.subject_name}</Table.Cell>
                <Table.Cell>{assessment.section_name ?? "—"}</Table.Cell>
                <Table.Cell>
                  <Num value={assessment.max_marks} />
                </Table.Cell>
                <Table.Cell>
                  {assessment.created_by_name ?? "—"}
                  <div className="ag-muted">
                    <DateTime value={assessment.created_at} />
                  </div>
                </Table.Cell>
                <Table.Cell>
                  <div className="sections-page__row-actions">
                    {(["approve", "reject"] as const).map((action) => (
                      <Button
                        key={action}
                        type="button"
                        variant={action === "approve" ? "primary" : "secondary"}
                        aria-label={t(`academicGrading.approvals.${action}AssessmentLabel`, {
                          name: assessment.name,
                        })}
                        onClick={() =>
                          decideAssessment.mutate(
                            { assessmentId: assessment.id, action },
                            {
                              onSuccess: () =>
                                show({
                                  variant: "success",
                                  title: t(`academicGrading.approvals.done.${action}Assessment`),
                                }),
                              onError: (error) =>
                                show({
                                  variant: "error",
                                  title: t("academicGrading.approvals.failed"),
                                  description: problemMessage(error, t),
                                }),
                            },
                          )
                        }
                      >
                        {t(`academicGrading.approvals.${action}`)}
                      </Button>
                    ))}
                  </div>
                </Table.Cell>
              </Table.Row>
            ))}
          </Table.Body>
        </Table>
      </section>

      {reasonFor?.kind === "sheet" ? (
        <ReasonModal
          key={`${reasonFor.sheet.id}-${reasonFor.action}`}
          open
          title={t(`academicGrading.approvals.${reasonFor.action}Title`, {
            name: sheetName(reasonFor.sheet),
          })}
          description={t(`academicGrading.approvals.${reasonFor.action}Description`)}
          confirmLabel={t(`academicGrading.approvals.${reasonFor.action}`)}
          submitting={decideSheet.isPending}
          onCancel={() => setReasonFor(null)}
          onConfirm={(reason) => decide(reasonFor.sheet, reasonFor.action, reason)}
        />
      ) : null}
      {reasonFor?.kind === "release" ? (
        <ReasonModal
          key={`${reasonFor.release.id}-${reasonFor.action}`}
          open
          title={t(
            reasonFor.action === "return"
              ? "academicGrading.approvals.returnTitle"
              : "academicGrading.approvals.withdrawTitle",
            { name: releaseName(reasonFor.release) },
          )}
          description={t(
            reasonFor.action === "return"
              ? "academicGrading.approvals.releaseReturnDescription"
              : "academicGrading.approvals.withdrawDescription",
          )}
          confirmLabel={t(
            reasonFor.action === "return"
              ? "academicGrading.approvals.return"
              : "academicGrading.approvals.withdraw",
          )}
          submitting={decideRelease.isPending}
          onCancel={() => setReasonFor(null)}
          onConfirm={(reason) => decideOnRelease(reasonFor.release, reasonFor.action, reason)}
        />
      ) : null}
    </>
  );
}
