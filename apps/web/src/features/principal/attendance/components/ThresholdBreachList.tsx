import { Card } from "@studafy/ui";

import type { AttendanceMatrixRow } from "../types";

export const BREACH_THRESHOLD = 10;

export function ThresholdBreachList({
  rows,
  onSelectStudent,
}: {
  rows: AttendanceMatrixRow[];
  onSelectStudent: (row: AttendanceMatrixRow) => void;
}) {
  const breaches = rows.filter((row) => row.absentPercent > BREACH_THRESHOLD);
  return (
    <Card>
      <div className="attendance-card-heading">
        <div>
          <h2>Chronic absenteeism alerts</h2>
          <p>Students above {BREACH_THRESHOLD}% unexcused absence</p>
        </div>
        <span className="attendance-alert-count" aria-label={`${breaches.length} alerts`}>
          {breaches.length}
        </span>
      </div>
      {breaches.length === 0 ? (
        <p>No threshold breaches in this view.</p>
      ) : (
        <ul className="attendance-breach-list">
          {breaches.slice(0, 8).map((row) => (
            <li key={row.studentId}>
              <button type="button" onClick={() => onSelectStudent(row)}>
                <span>
                  <strong>{row.studentName}</strong>
                  <small>{row.classCode}</small>
                </span>
                <span>{row.absentPercent.toFixed(1)}%</span>
              </button>
            </li>
          ))}
        </ul>
      )}
    </Card>
  );
}
