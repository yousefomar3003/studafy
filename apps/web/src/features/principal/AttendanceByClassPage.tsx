import { Select, Table } from "@studafy/ui";
import { useQuery } from "@tanstack/react-query";
import { useState } from "react";
import { Link, useSearchParams } from "react-router-dom";

import { fetchClassAttendanceSummary, lastNDaysRange } from "./queries";

import type { SelectOption } from "@studafy/ui";

const COLUMN_COUNT = 5;

type RangePreset = "7" | "30" | "90";

const RANGE_OPTIONS: SelectOption<RangePreset>[] = [
  { value: "7", label: "Last 7 days" },
  { value: "30", label: "Last 30 days" },
  { value: "90", label: "Last 90 days" },
];

function formatPercent(value: number): string {
  return `${Math.round(value)}%`;
}

/**
 * Attendance by class (`/portal/principal/attendance`), drill-through target for the principal
 * dashboard's heat map tile. `?class_id=` (set when a heat map cell is clicked) narrows the table
 * to that one class via the summary endpoint's own `class_id` filter; clearing it goes back to
 * every class.
 */
export default function AttendanceByClassPage() {
  const [searchParams] = useSearchParams();
  const classId = searchParams.get("class_id") ?? undefined;
  const [rangeDays, setRangeDays] = useState<RangePreset>("7");

  const range = lastNDaysRange(Number(rangeDays));

  const { data, isPending, isError } = useQuery({
    queryKey: ["attendance-summary", "by-class", range.startDate, range.endDate, classId],
    queryFn: () => fetchClassAttendanceSummary(range, classId),
  });

  const classes = data ?? [];

  return (
    <>
      <h1>Attendance by class</h1>
      <p>Present, absent, late, and excused rates for the selected period.</p>

      <Select
        label="Period"
        options={RANGE_OPTIONS}
        value={rangeDays}
        onChange={(value) => setRangeDays(value)}
      />

      {classId ? (
        <p>
          Filtered to one class. <Link to="/portal/principal/attendance">Clear filter</Link>
        </p>
      ) : null}

      <Table caption="Attendance by class">
        <Table.Header>
          <Table.Row>
            <Table.HeaderCell>Class</Table.HeaderCell>
            <Table.HeaderCell>Present</Table.HeaderCell>
            <Table.HeaderCell>Absent</Table.HeaderCell>
            <Table.HeaderCell>Late</Table.HeaderCell>
            <Table.HeaderCell>Excused</Table.HeaderCell>
          </Table.Row>
        </Table.Header>
        <Table.Body
          columnCount={COLUMN_COUNT}
          loading={isPending}
          empty={isError ? "Unable to load attendance." : "No attendance recorded in this period."}
        >
          {classes.map((klass) => (
            <Table.Row key={klass.class_id}>
              <Table.Cell>{klass.class_code}</Table.Cell>
              <Table.Cell>{formatPercent(klass.present_percent)}</Table.Cell>
              <Table.Cell>{formatPercent(klass.absent_percent)}</Table.Cell>
              <Table.Cell>{formatPercent(klass.late_percent)}</Table.Cell>
              <Table.Cell>{formatPercent(klass.excused_percent)}</Table.Cell>
            </Table.Row>
          ))}
        </Table.Body>
      </Table>
    </>
  );
}
