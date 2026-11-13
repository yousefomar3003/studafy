import { Card } from "@studafy/ui";

import { useFormatters, useTranslation } from "../../../../lib/i18n";
import { ONE_DECIMAL_PERCENT_OPTIONS, WHOLE_PERCENT_OPTIONS } from "../../format";

import type { AttendanceMatrixRow } from "../types";

export const BREACH_THRESHOLD = 10;

export function ThresholdBreachList({
  rows,
  onSelectStudent,
}: {
  rows: AttendanceMatrixRow[];
  onSelectStudent: (row: AttendanceMatrixRow) => void;
}) {
  const { t } = useTranslation();
  const { formatNumber } = useFormatters();
  const breaches = rows.filter((row) => row.absentPercent > BREACH_THRESHOLD);
  return (
    <Card>
      <div className="attendance-card-heading">
        <div>
          <h2>{t("principal.attendance.breaches.title")}</h2>
          <p>
            {t("principal.attendance.breaches.description", {
              threshold: formatNumber(BREACH_THRESHOLD / 100, WHOLE_PERCENT_OPTIONS),
            })}
          </p>
        </div>
        <span
          className="attendance-alert-count"
          aria-label={t("principal.attendance.breaches.alertCount", { count: breaches.length })}
        >
          {formatNumber(breaches.length)}
        </span>
      </div>
      {breaches.length === 0 ? (
        <p>{t("principal.attendance.breaches.empty")}</p>
      ) : (
        <ul className="attendance-breach-list">
          {breaches.slice(0, 8).map((row) => (
            <li key={row.studentId}>
              <button type="button" onClick={() => onSelectStudent(row)}>
                <span>
                  <strong>{row.studentName}</strong>
                  <small>{row.classCode}</small>
                </span>
                <span>{formatNumber(row.absentPercent / 100, ONE_DECIMAL_PERCENT_OPTIONS)}</span>
              </button>
            </li>
          ))}
        </ul>
      )}
    </Card>
  );
}
