import { ApiError } from "@studafy/api-client";
import { ERROR_CODES, PERMISSIONS } from "@studafy/constants";
import { Button, Modal, Select, Table, useToast } from "@studafy/ui";
import { useState } from "react";

import { LinkButton } from "../../../components/LinkButton";
import { usePermissions } from "../../../lib/auth";
import { useFormatters, useTranslation } from "../../../lib/i18n";
import { pickCurrentYear, useAcademicYears } from "../school/queries";

import { GradeLevelModal } from "./GradeLevelModal";
import { useDeleteGradeLevel, useDeleteSection } from "./mutations";
import { sectionDisplayName, useGradeLevels, useSections } from "./queries";
import { SectionModal } from "./SectionModal";
import { SectionStudentsModal } from "./SectionStudentsModal";

import type { GradeLevel, Section } from "./queries";
import type { TFunction } from "i18next";

import "../school/principal-school.css";
import "./sections.css";

const GRADE_COLUMN_COUNT = 4;
const SECTION_COLUMN_COUNT = 4;

type PendingDelete = { kind: "grade"; grade: GradeLevel } | { kind: "section"; section: Section };

/** The 409s a delete can hit, in words; anything else falls back to the server's own detail. */
function deleteErrorDescription(error: unknown, t: TFunction): string | undefined {
  if (!(error instanceof ApiError)) return undefined;
  if (error.code === ERROR_CODES.GRADE_LEVEL_HAS_SECTIONS) {
    return t("principal.sections.delete.gradeHasSections");
  }
  if (error.code === ERROR_CODES.SECTION_IN_USE) return t("principal.sections.delete.sectionInUse");
  return error.detail ?? error.title;
}

function deleteTitle(pending: PendingDelete | null, t: TFunction): string {
  if (pending?.kind === "grade") {
    return t("principal.sections.delete.gradeTitle", { name: pending.grade.name });
  }
  if (pending?.kind === "section") {
    return t("principal.sections.delete.sectionTitle", {
      section: sectionDisplayName(pending.section, t),
    });
  }
  return t("principal.sections.delete.action");
}

/**
 * Grades & sections (`/portal/principal/sections`), gated on `timetable:manage`: the school's grades
 * ("Grade 10") and, per academic year, each grade's sections ("C") with the students placed in them.
 * A section is what a timetable is built for — classes are attached to one on the Classes page, and
 * the timetable builder filters by grade and section.
 */
export default function GradesSectionsPage() {
  const { t } = useTranslation();
  const { formatNumber } = useFormatters();
  const { show } = useToast();
  const permissions = usePermissions();
  const years = useAcademicYears();
  const grades = useGradeLevels();
  const [pickedYearId, setPickedYearId] = useState<string>();

  const yearList = years.data ?? [];
  const year =
    yearList.find((candidate) => candidate.id === pickedYearId) ?? pickCurrentYear(yearList);
  const sections = useSections(year?.id);
  const deleteGrade = useDeleteGradeLevel();
  const deleteSection = useDeleteSection();

  const [gradeModal, setGradeModal] = useState<{ grade: GradeLevel | null } | null>(null);
  const [sectionModal, setSectionModal] = useState<{ section: Section | null } | null>(null);
  const [rosterSection, setRosterSection] = useState<Section | null>(null);
  const [pendingDelete, setPendingDelete] = useState<PendingDelete | null>(null);

  const gradeList = grades.data ?? [];
  const sectionList = sections.data ?? [];
  const sectionsPerGrade = new Map<string, number>();
  for (const section of sectionList) {
    sectionsPerGrade.set(
      section.grade_level_id,
      (sectionsPerGrade.get(section.grade_level_id) ?? 0) + 1,
    );
  }
  const nextSortOrder = Math.max(-1, ...gradeList.map((grade) => grade.sort_order)) + 1;

  function confirmDelete() {
    if (!pendingDelete) return;
    const onSuccess = () => {
      show({ variant: "success", title: t("principal.sections.delete.deleted") });
      setPendingDelete(null);
    };
    const onError = (error: unknown) => {
      show({
        variant: "error",
        title: t("principal.sections.delete.failed"),
        description: deleteErrorDescription(error, t),
      });
      setPendingDelete(null);
    };
    if (pendingDelete.kind === "grade") {
      deleteGrade.mutate(pendingDelete.grade.id, { onSuccess, onError });
    } else {
      deleteSection.mutate(pendingDelete.section.id, { onSuccess, onError });
    }
  }

  return (
    <>
      <div className="principal-school__header">
        <h1>{t("principal.sections.title")}</h1>
        {permissions.has(PERMISSIONS.PRINCIPAL_DASHBOARD_VIEW) ? (
          <LinkButton href="/portal/principal/classes" variant="secondary">
            {t("principal.sections.classesLink")}
          </LinkButton>
        ) : null}
      </div>
      <p>{t("principal.sections.description")}</p>

      <section className="sections-page__block" aria-labelledby="grades-heading">
        <div className="sections-page__head">
          <h2 id="grades-heading">{t("principal.sections.grades.heading")}</h2>
          <Button type="button" onClick={() => setGradeModal({ grade: null })}>
            {t("principal.sections.grades.add")}
          </Button>
        </div>
        <Table caption={t("principal.sections.grades.caption")} hideCaption>
          <Table.Header>
            <Table.Row>
              <Table.HeaderCell>{t("principal.sections.grades.columns.name")}</Table.HeaderCell>
              <Table.HeaderCell>{t("principal.sections.grades.columns.order")}</Table.HeaderCell>
              <Table.HeaderCell>{t("principal.sections.grades.columns.sections")}</Table.HeaderCell>
              <Table.HeaderCell>{t("principal.sections.columns.actions")}</Table.HeaderCell>
            </Table.Row>
          </Table.Header>
          <Table.Body
            columnCount={GRADE_COLUMN_COUNT}
            loading={grades.isPending}
            empty={
              grades.isError
                ? t("principal.sections.grades.error")
                : t("principal.sections.grades.empty")
            }
          >
            {gradeList.map((grade) => (
              <Table.Row key={grade.id}>
                <Table.Cell>{grade.name}</Table.Cell>
                <Table.Cell>{formatNumber(grade.sort_order)}</Table.Cell>
                <Table.Cell>
                  {sections.isSuccess ? formatNumber(sectionsPerGrade.get(grade.id) ?? 0) : "…"}
                </Table.Cell>
                <Table.Cell>
                  <div className="sections-page__row-actions">
                    <Button
                      type="button"
                      variant="tertiary"
                      aria-label={t("principal.sections.grades.editLabel", { name: grade.name })}
                      onClick={() => setGradeModal({ grade })}
                    >
                      {t("principal.sections.edit")}
                    </Button>
                    <Button
                      type="button"
                      variant="tertiary"
                      aria-label={t("principal.sections.grades.deleteLabel", { name: grade.name })}
                      onClick={() => setPendingDelete({ kind: "grade", grade })}
                    >
                      {t("principal.sections.delete.action")}
                    </Button>
                  </div>
                </Table.Cell>
              </Table.Row>
            ))}
          </Table.Body>
        </Table>
      </section>

      <section className="sections-page__block" aria-labelledby="sections-heading">
        <div className="sections-page__head">
          <h2 id="sections-heading">{t("principal.sections.sectionList.heading")}</h2>
          <Button
            type="button"
            disabled={!year || gradeList.length === 0}
            onClick={() => setSectionModal({ section: null })}
          >
            {t("principal.sections.sectionList.add")}
          </Button>
        </div>
        <div className="principal-school__filters">
          <Select
            label={t("principal.school.yearLabel")}
            options={yearList.map((candidate) => ({ value: candidate.id, label: candidate.name }))}
            value={year?.id}
            onChange={setPickedYearId}
            placeholder={t("principal.school.noYears")}
            disabled={yearList.length === 0}
          />
        </div>
        <Table caption={t("principal.sections.sectionList.caption")} hideCaption>
          <Table.Header>
            <Table.Row>
              <Table.HeaderCell>
                {t("principal.sections.sectionList.columns.grade")}
              </Table.HeaderCell>
              <Table.HeaderCell>
                {t("principal.sections.sectionList.columns.section")}
              </Table.HeaderCell>
              <Table.HeaderCell>
                {t("principal.sections.sectionList.columns.students")}
              </Table.HeaderCell>
              <Table.HeaderCell>{t("principal.sections.columns.actions")}</Table.HeaderCell>
            </Table.Row>
          </Table.Header>
          <Table.Body
            columnCount={SECTION_COLUMN_COUNT}
            loading={years.isPending || (year !== undefined && sections.isPending)}
            empty={
              sections.isError
                ? t("principal.sections.sectionList.error")
                : t("principal.sections.sectionList.empty")
            }
          >
            {sectionList.map((section) => {
              const label = sectionDisplayName(section, t);
              return (
                <Table.Row key={section.id}>
                  <Table.Cell>{section.grade_level_name}</Table.Cell>
                  <Table.Cell>{section.name}</Table.Cell>
                  <Table.Cell>{formatNumber(section.student_count)}</Table.Cell>
                  <Table.Cell>
                    <div className="sections-page__row-actions">
                      <Button
                        type="button"
                        variant="secondary"
                        aria-label={t("principal.sections.sectionList.studentsLabel", {
                          section: label,
                        })}
                        onClick={() => setRosterSection(section)}
                      >
                        {t("principal.sections.sectionList.students")}
                      </Button>
                      <Button
                        type="button"
                        variant="tertiary"
                        aria-label={t("principal.sections.sectionList.renameLabel", {
                          section: label,
                        })}
                        onClick={() => setSectionModal({ section })}
                      >
                        {t("principal.sections.sectionList.rename")}
                      </Button>
                      <Button
                        type="button"
                        variant="tertiary"
                        aria-label={t("principal.sections.sectionList.deleteLabel", {
                          section: label,
                        })}
                        onClick={() => setPendingDelete({ kind: "section", section })}
                      >
                        {t("principal.sections.delete.action")}
                      </Button>
                    </div>
                  </Table.Cell>
                </Table.Row>
              );
            })}
          </Table.Body>
        </Table>
      </section>

      <GradeLevelModal
        open={gradeModal !== null}
        grade={gradeModal?.grade ?? null}
        nextSortOrder={nextSortOrder}
        onClose={() => setGradeModal(null)}
      />
      {year ? (
        <SectionModal
          open={sectionModal !== null}
          section={sectionModal?.section ?? null}
          academicYearId={year.id}
          grades={gradeList}
          onClose={() => setSectionModal(null)}
        />
      ) : null}
      <SectionStudentsModal section={rosterSection} onClose={() => setRosterSection(null)} />

      <Modal
        open={pendingDelete !== null}
        onClose={() => setPendingDelete(null)}
        title={deleteTitle(pendingDelete, t)}
        description={
          pendingDelete?.kind === "grade"
            ? t("principal.sections.delete.gradeDescription")
            : t("principal.sections.delete.sectionDescription")
        }
      >
        <Modal.Footer>
          <Button type="button" variant="secondary" onClick={() => setPendingDelete(null)}>
            {t("principal.common.cancel")}
          </Button>
          <Button
            type="button"
            loading={deleteGrade.isPending || deleteSection.isPending}
            onClick={confirmDelete}
          >
            {t("principal.sections.delete.confirm")}
          </Button>
        </Modal.Footer>
      </Modal>
    </>
  );
}
