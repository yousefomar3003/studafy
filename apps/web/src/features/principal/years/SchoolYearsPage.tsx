import { Button, Checkbox, Modal, Table, useToast } from "@studafy/ui";
import { useState } from "react";

import { apiErrorDescription } from "../../../lib/api-error";
import { useFormatters, useTranslation } from "../../../lib/i18n";
import { pickCurrentYear, useAcademicYears, useTerms } from "../school/queries";

import { useDeleteTerm, useDeleteYear, useRolloverYear } from "./mutations";
import { PeriodModal } from "./PeriodModal";

import type { PeriodModalTarget } from "./PeriodModal";
import type { AcademicYear, Term } from "../../admin/timetable/queries";

import "../school/principal-school.css";
import "../sections/sections.css";
import "./years.css";

const YEAR_COLUMN_COUNT = 5;
const TERM_COLUMN_COUNT = 6;

type PendingDelete = { kind: "year"; year: AcademicYear } | { kind: "term"; term: Term };

/**
 * Why a year or term cannot be deleted, known before asking the API: only a planned one can. The
 * delete dialog shows this instead of a Delete button. `null` when it may be deleted (the API can
 * still refuse one that something else uses, and says why).
 */
function blockedReason(target: PendingDelete): string | null {
  if (target.kind === "term") {
    return target.term.status === "planned" ? null : "principal.years.delete.blockedTerm";
  }
  if (target.year.status === "planned") return null;
  return target.year.status === "active"
    ? "principal.years.delete.blockedYearActive"
    : "principal.years.delete.blockedYearClosed";
}

/** A `YYYY-MM-DD` value as a local calendar date, so no time zone can move it a day. */
function parseIsoDate(value: string): Date {
  // The API sends these `format: date` fields as midnight-UTC timestamps; the date is the first ten.
  const [year, month, day] = value.slice(0, 10).split("-").map(Number);
  return new Date(year!, month! - 1, day!);
}

/**
 * School years & terms (`/portal/principal/years`), gated on `timetable:manage` (ORG_ADMIN,
 * PRINCIPAL): every academic year with its terms, adding and correcting them, and starting a new
 * year. Starting one (rollover) closes the current year and marks every enrolment in it completed,
 * so it sits behind its own confirmation. Every row offers Edit and Delete; only a planned year or
 * term can be deleted, and the delete dialog says why when one cannot.
 */
export default function SchoolYearsPage() {
  const { t } = useTranslation();
  const { formatDate, formatNumber } = useFormatters();
  const { show } = useToast();
  const years = useAcademicYears();
  const [pickedYearId, setPickedYearId] = useState<string>();
  const [modal, setModal] = useState<PeriodModalTarget | null>(null);
  const [pendingDelete, setPendingDelete] = useState<PendingDelete | null>(null);
  const [rolloverYear, setRolloverYear] = useState<AcademicYear | null>(null);
  const [understood, setUnderstood] = useState(false);
  const deleteYear = useDeleteYear();
  const deleteTerm = useDeleteTerm();
  const rollover = useRolloverYear();

  const yearList = [...(years.data ?? [])].sort((a, b) => b.starts_on.localeCompare(a.starts_on));
  const activeYear = yearList.find((year) => year.status === "active");
  const selected =
    yearList.find((year) => year.id === pickedYearId) ?? pickCurrentYear(yearList) ?? undefined;
  const terms = useTerms(selected?.id);
  const termList = [...(terms.data ?? [])].sort((a, b) => a.sequence_number - b.sequence_number);
  const nextSequence = Math.max(0, ...termList.map((term) => term.sequence_number)) + 1;

  const dateRange = (period: { starts_on: string; ends_on: string }) =>
    `${formatDate(parseIsoDate(period.starts_on), { dateStyle: "medium" })} – ${formatDate(
      parseIsoDate(period.ends_on),
      { dateStyle: "medium" },
    )}`;

  const deleteBlocked = pendingDelete ? blockedReason(pendingDelete) : null;

  function confirmDelete() {
    if (!pendingDelete) return;
    const onSuccess = () => {
      show({ variant: "success", title: t("principal.years.delete.deleted") });
      if (pendingDelete.kind === "year" && pendingDelete.year.id === pickedYearId) {
        setPickedYearId(undefined);
      }
      setPendingDelete(null);
    };
    const onError = (error: unknown) => {
      show({
        variant: "error",
        title: t("principal.years.delete.failed"),
        description: apiErrorDescription(error, t),
      });
      setPendingDelete(null);
    };
    if (pendingDelete.kind === "year") {
      deleteYear.mutate(pendingDelete.year.id, { onSuccess, onError });
    } else {
      deleteTerm.mutate(pendingDelete.term.id, { onSuccess, onError });
    }
  }

  function openRollover(year: AcademicYear) {
    setUnderstood(false);
    setRolloverYear(year);
  }

  function confirmRollover() {
    if (!rolloverYear) return;
    rollover.mutate(rolloverYear.id, {
      onSuccess: (result) => {
        show({
          variant: "success",
          title: t("principal.years.rollover.done", { name: rolloverYear.name }),
          description: t("principal.years.rollover.archived", {
            count: result.enrollments_archived,
          }),
        });
        setPickedYearId(rolloverYear.id);
        setRolloverYear(null);
      },
      onError: (error) =>
        show({
          variant: "error",
          title: t("principal.years.rollover.failed"),
          description: apiErrorDescription(error, t),
        }),
    });
  }

  const deleting = deleteYear.isPending || deleteTerm.isPending;

  return (
    <>
      <div className="principal-school__header">
        <h1>{t("principal.years.title")}</h1>
      </div>
      <p>{t("principal.years.description")}</p>

      <section className="sections-page__block" aria-labelledby="years-heading">
        <div className="sections-page__head">
          <h2 id="years-heading">{t("principal.years.yearList.heading")}</h2>
          <Button type="button" onClick={() => setModal({ kind: "year", year: null })}>
            {t("principal.years.yearList.add")}
          </Button>
        </div>
        <Table caption={t("principal.years.yearList.caption")} hideCaption>
          <Table.Header>
            <Table.Row>
              <Table.HeaderCell>{t("principal.years.columns.name")}</Table.HeaderCell>
              <Table.HeaderCell>{t("principal.years.columns.code")}</Table.HeaderCell>
              <Table.HeaderCell>{t("principal.years.columns.dates")}</Table.HeaderCell>
              <Table.HeaderCell>{t("principal.years.columns.status")}</Table.HeaderCell>
              <Table.HeaderCell>{t("principal.years.columns.actions")}</Table.HeaderCell>
            </Table.Row>
          </Table.Header>
          <Table.Body
            columnCount={YEAR_COLUMN_COUNT}
            loading={years.isPending}
            empty={
              years.isError
                ? t("principal.years.yearList.error")
                : t("principal.years.yearList.empty")
            }
          >
            {yearList.map((year) => (
              <Table.Row key={year.id}>
                <Table.Cell>
                  <button
                    type="button"
                    className="years-page__pick"
                    aria-pressed={year.id === selected?.id}
                    onClick={() => setPickedYearId(year.id)}
                  >
                    {year.name}
                  </button>
                </Table.Cell>
                <Table.Cell>{year.code}</Table.Cell>
                <Table.Cell>{dateRange(year)}</Table.Cell>
                <Table.Cell>
                  <span className="years-page__status" data-status={year.status}>
                    {t(`principal.years.status.${year.status}`)}
                  </span>
                </Table.Cell>
                <Table.Cell>
                  <div className="sections-page__row-actions">
                    <Button
                      type="button"
                      variant="tertiary"
                      aria-label={t("principal.years.yearList.editLabel", { name: year.name })}
                      onClick={() => setModal({ kind: "year", year })}
                    >
                      {t("principal.years.edit")}
                    </Button>
                    {year.status === "planned" ? (
                      <Button
                        type="button"
                        variant="secondary"
                        aria-label={t("principal.years.rollover.startLabel", {
                          name: year.name,
                        })}
                        onClick={() => openRollover(year)}
                      >
                        {t("principal.years.rollover.start")}
                      </Button>
                    ) : null}
                    <Button
                      type="button"
                      variant="tertiary"
                      aria-label={t("principal.years.yearList.deleteLabel", {
                        name: year.name,
                      })}
                      onClick={() => setPendingDelete({ kind: "year", year })}
                    >
                      {t("principal.years.delete.action")}
                    </Button>
                  </div>
                </Table.Cell>
              </Table.Row>
            ))}
          </Table.Body>
        </Table>
      </section>

      <section className="sections-page__block" aria-labelledby="terms-heading">
        <div className="sections-page__head">
          <h2 id="terms-heading">
            {selected
              ? t("principal.years.termList.headingFor", { name: selected.name })
              : t("principal.years.termList.heading")}
          </h2>
          <Button
            type="button"
            disabled={!selected}
            onClick={() =>
              selected && setModal({ kind: "term", yearId: selected.id, term: null, nextSequence })
            }
          >
            {t("principal.years.termList.add")}
          </Button>
        </div>
        <Table caption={t("principal.years.termList.caption")} hideCaption>
          <Table.Header>
            <Table.Row>
              <Table.HeaderCell>{t("principal.years.columns.order")}</Table.HeaderCell>
              <Table.HeaderCell>{t("principal.years.columns.name")}</Table.HeaderCell>
              <Table.HeaderCell>{t("principal.years.columns.code")}</Table.HeaderCell>
              <Table.HeaderCell>{t("principal.years.columns.dates")}</Table.HeaderCell>
              <Table.HeaderCell>{t("principal.years.columns.status")}</Table.HeaderCell>
              <Table.HeaderCell>{t("principal.years.columns.actions")}</Table.HeaderCell>
            </Table.Row>
          </Table.Header>
          <Table.Body
            columnCount={TERM_COLUMN_COUNT}
            loading={selected !== undefined && terms.isPending}
            empty={
              !selected
                ? t("principal.years.termList.noYear")
                : terms.isError
                  ? t("principal.years.termList.error")
                  : t("principal.years.termList.empty")
            }
          >
            {termList.map((term) => (
              <Table.Row key={term.id}>
                <Table.Cell>{formatNumber(term.sequence_number)}</Table.Cell>
                <Table.Cell>{term.name}</Table.Cell>
                <Table.Cell>{term.code}</Table.Cell>
                <Table.Cell>{dateRange(term)}</Table.Cell>
                <Table.Cell>
                  <span className="years-page__status" data-status={term.status}>
                    {t(`principal.years.status.${term.status}`)}
                  </span>
                </Table.Cell>
                <Table.Cell>
                  <div className="sections-page__row-actions">
                    <Button
                      type="button"
                      variant="tertiary"
                      aria-label={t("principal.years.termList.editLabel", { name: term.name })}
                      onClick={() =>
                        setModal({
                          kind: "term",
                          yearId: term.academic_year_id,
                          term,
                          nextSequence,
                        })
                      }
                    >
                      {t("principal.years.edit")}
                    </Button>
                    <Button
                      type="button"
                      variant="tertiary"
                      aria-label={t("principal.years.termList.deleteLabel", { name: term.name })}
                      onClick={() => setPendingDelete({ kind: "term", term })}
                    >
                      {t("principal.years.delete.action")}
                    </Button>
                  </div>
                </Table.Cell>
              </Table.Row>
            ))}
          </Table.Body>
        </Table>
      </section>

      <PeriodModal target={modal} onClose={() => setModal(null)} />

      <Modal
        open={pendingDelete !== null}
        onClose={() => setPendingDelete(null)}
        title={t("principal.years.delete.title", {
          name: pendingDelete?.kind === "year" ? pendingDelete.year.name : pendingDelete?.term.name,
        })}
      >
        <Modal.Body>
          <p>{t(deleteBlocked ?? "principal.years.delete.body")}</p>
        </Modal.Body>
        <Modal.Footer>
          {deleteBlocked ? (
            <Button type="button" onClick={() => setPendingDelete(null)}>
              {t("principal.years.delete.close")}
            </Button>
          ) : (
            <>
              <Button type="button" variant="tertiary" onClick={() => setPendingDelete(null)}>
                {t("principal.common.cancel")}
              </Button>
              <Button type="button" loading={deleting} onClick={confirmDelete}>
                {t("principal.years.delete.action")}
              </Button>
            </>
          )}
        </Modal.Footer>
      </Modal>

      <Modal
        open={rolloverYear !== null}
        onClose={() => setRolloverYear(null)}
        title={t("principal.years.rollover.title", { name: rolloverYear?.name })}
      >
        <Modal.Body>
          <div className="sections-form">
            <p>
              {activeYear
                ? t("principal.years.rollover.bodyWithActive", {
                    name: rolloverYear?.name,
                    current: activeYear.name,
                  })
                : t("principal.years.rollover.bodyFirst", { name: rolloverYear?.name })}
            </p>
            {activeYear ? <p>{t("principal.years.rollover.irreversible")}</p> : null}
            <Checkbox
              label={t("principal.years.rollover.understand")}
              checked={understood}
              onChange={(event) => setUnderstood(event.target.checked)}
            />
          </div>
        </Modal.Body>
        <Modal.Footer>
          <Button type="button" variant="tertiary" onClick={() => setRolloverYear(null)}>
            {t("principal.common.cancel")}
          </Button>
          <Button
            type="button"
            loading={rollover.isPending}
            disabled={!understood}
            onClick={confirmRollover}
          >
            {t("principal.years.rollover.confirm")}
          </Button>
        </Modal.Footer>
      </Modal>
    </>
  );
}
