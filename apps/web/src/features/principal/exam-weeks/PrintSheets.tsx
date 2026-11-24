import { Button } from "@studafy/ui";

import { useFormatters, useTranslation } from "../../../lib/i18n";
import { problemMessage } from "../academic-setup/errors";

import { formatDay } from "./format";
import { doorSheets, examLabel, seatingLists } from "./print";
import { useExamPeriodSeating } from "./queries";

import type { ExamPeriod } from "./queries";

/**
 * The printed sheets of an exam period, one per page: seating lists (each exam's candidates by name,
 * with room and seat, for the notice board) or door sheets (each room's seats for one sitting, for
 * its door and invigilators). Only the sheets print, never the portal around them.
 */
export function PrintSheets({
  period,
  kind,
  onDone,
}: {
  period: ExamPeriod;
  kind: "lists" | "doors";
  onDone: () => void;
}) {
  const { t } = useTranslation();
  const { formatDate, formatNumber } = useFormatters();
  const seating = useExamPeriodSeating(period.id);
  const day = (value: string) =>
    formatDay(value, formatDate, {
      weekday: "long",
      day: "numeric",
      month: "long",
      year: "numeric",
    });

  return (
    <>
      <div className="ag-row__actions ew-no-print">
        <Button type="button" variant="tertiary" onClick={onDone}>
          {t("examWeeks.print.back")}
        </Button>
        <Button type="button" disabled={!seating.data} onClick={() => window.print()}>
          {t("examWeeks.print.print")}
        </Button>
      </div>
      {seating.isPending ? (
        <p className="ag-muted" role="status">
          {t("examWeeks.loading")}
        </p>
      ) : seating.isError || !seating.data ? (
        <p className="ag-error" role="alert">
          {problemMessage(seating.error, t)}
        </p>
      ) : kind === "lists" ? (
        <div className="ew-print">
          {seatingLists(period, seating.data.slots).map(({ slot, rows }) => (
            <article key={slot.id} className="ew-sheet" aria-label={examLabel(slot)}>
              <header>
                <p className="ag-muted">{period.name}</p>
                <h2>{examLabel(slot)}</h2>
                <p>
                  {day(slot.exam_date)} ·{" "}
                  <span dir="ltr">
                    {slot.starts_at}–{slot.ends_at}
                  </span>
                </p>
              </header>
              <table className="ew-sheet__table">
                <thead>
                  <tr>
                    <th scope="col">{t("examWeeks.print.columns.student")}</th>
                    <th scope="col">{t("examWeeks.print.columns.admission")}</th>
                    <th scope="col">{t("examWeeks.print.columns.section")}</th>
                    <th scope="col">{t("examWeeks.print.columns.room")}</th>
                    <th scope="col">{t("examWeeks.print.columns.seat")}</th>
                  </tr>
                </thead>
                <tbody>
                  {rows.map((row) => (
                    <tr key={row.student_id}>
                      <td>{row.name}</td>
                      <td>{row.admission_number}</td>
                      <td>{row.section}</td>
                      <td>{row.room ?? t("examWeeks.print.noSeat")}</td>
                      <td>{row.seat_number === null ? "—" : formatNumber(row.seat_number)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </article>
          ))}
        </div>
      ) : (
        <div className="ew-print">
          {doorSheets(period, seating.data.slots).map((sheet) => (
            <article
              key={sheet.key}
              className="ew-sheet"
              aria-label={`${sheet.room.name} ${sheet.exam_date} ${sheet.starts_at}`}
            >
              <header>
                <p className="ag-muted">{period.name}</p>
                <h2 className="ew-sheet__room">
                  {sheet.room.name} <span className="ag-muted">{sheet.room.code}</span>
                </h2>
                <p>
                  {day(sheet.exam_date)} ·{" "}
                  <span dir="ltr">
                    {sheet.starts_at}–{sheet.ends_at}
                  </span>
                </p>
                <p>{sheet.exams.map(examLabel).join(" · ")}</p>
                <p>
                  {t("examWeeks.print.invigilators", {
                    names: sheet.invigilators.join(", ") || "—",
                  })}
                </p>
              </header>
              <table className="ew-sheet__table">
                <thead>
                  <tr>
                    <th scope="col">{t("examWeeks.print.columns.seat")}</th>
                    <th scope="col">{t("examWeeks.print.columns.student")}</th>
                    <th scope="col">{t("examWeeks.print.columns.admission")}</th>
                    <th scope="col">{t("examWeeks.print.columns.section")}</th>
                    <th scope="col">{t("examWeeks.print.columns.exam")}</th>
                  </tr>
                </thead>
                <tbody>
                  {sheet.rows.map((row) => (
                    <tr key={`${row.seat_number}-${row.admission_number}`}>
                      <td>{formatNumber(row.seat_number)}</td>
                      <td>{row.name}</td>
                      <td>{row.admission_number}</td>
                      <td>{row.section}</td>
                      <td>{row.exam}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
              {sheet.rows.length === 0 ? (
                <p className="ag-muted">{t("examWeeks.print.emptyRoom")}</p>
              ) : null}
            </article>
          ))}
        </div>
      )}
    </>
  );
}
