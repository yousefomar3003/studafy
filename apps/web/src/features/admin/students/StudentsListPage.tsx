import { PERMISSIONS } from "@studafy/constants";
import { Button, DataGrid, FilterBar, Select } from "@studafy/ui";
import { keepPreviousData, useQuery } from "@tanstack/react-query";
import { useEffect, useMemo, useState } from "react";
import { useNavigate } from "react-router-dom";

import { usePermissions } from "../../../lib/auth";

import { CreateStudentModal } from "./CreateStudentModal";
import {
  fetchActiveClasses,
  fetchStudentsInClass,
  fetchStudentsPage,
  studentsInClassQueryKey,
  studentsListQueryKey,
} from "./queries";
import { STATUS_LABELS } from "./schema";

import "./students.css";

import type { StudentProfile, StudentsFilters } from "./queries";
import type { DateRangeValue, SelectOption } from "@studafy/ui";

const SEARCH_DEBOUNCE_MS = 300;

const STATUS_OPTIONS: SelectOption<StudentsFilters["status"]>[] = [
  { value: "", label: "All statuses" },
  ...(Object.entries(STATUS_LABELS) as [StudentsFilters["status"], string][]).map(
    ([value, label]) => ({ value, label }),
  ),
];

function fullName(student: StudentProfile): string {
  return [student.first_name, student.middle_name, student.last_name].filter(Boolean).join(" ");
}

/**
 * Student directory (`/portal/admin/students`), gated by `organization:manageSettings` like the rest
 * of `/portal/admin` — see `UsersListPage` for why this app uses TanStack Query rather than
 * `@studafy/ui`'s `useCursorPagination` for admin lists (every mutation needs one cache to patch
 * optimistically).
 *
 * The class filter is not part of the server-driven search/pagination path: `GET /api/students` has
 * no `class_id` filter, so selecting a class swaps the query over to `fetchStudentsInClass`, a
 * bounded client-side fan-out (see its doc in `queries.ts`). That path has no cursor, so pagination
 * controls are hidden while a class filter is active.
 */
export default function StudentsListPage() {
  const navigate = useNavigate();
  const permissions = usePermissions();
  const canViewAdmissionData = permissions.has(PERMISSIONS.BILLING_READ);
  const canCreate = permissions.has(PERMISSIONS.STUDENT_CREATE);
  const canImport = permissions.has(PERMISSIONS.STUDENT_IMPORT);

  const [searchInput, setSearchInput] = useState("");
  const [debouncedSearch, setDebouncedSearch] = useState("");
  const [status, setStatus] = useState<StudentsFilters["status"]>("");
  const [classId, setClassId] = useState("");
  const [dateRange, setDateRange] = useState<DateRangeValue>({});

  useEffect(() => {
    const handle = setTimeout(() => setDebouncedSearch(searchInput), SEARCH_DEBOUNCE_MS);
    return () => clearTimeout(handle);
  }, [searchInput]);

  const filters: StudentsFilters = useMemo(
    () => ({ search: debouncedSearch, status, classId, dateRange }),
    [debouncedSearch, status, classId, dateRange],
  );

  const [cursor, setCursor] = useState<string | undefined>(undefined);
  const [cursorHistory, setCursorHistory] = useState<(string | undefined)[]>([]);

  // A new filter set always starts back at page one — the cursor from the previous filters names a
  // position in a different result set and would page through the wrong rows.
  useEffect(() => {
    setCursor(undefined);
    setCursorHistory([]);
  }, [
    filters.search,
    filters.status,
    filters.classId,
    filters.dateRange.from,
    filters.dateRange.to,
  ]);

  const classesQuery = useQuery({ queryKey: ["classes", "active"], queryFn: fetchActiveClasses });
  const classOptions: SelectOption<string>[] = [
    { value: "", label: "All classes" },
    ...(classesQuery.data ?? []).map((klass) => ({ value: klass.id, label: klass.code })),
  ];

  const pagedQuery = useQuery({
    queryKey: studentsListQueryKey(filters, cursor),
    queryFn: () => fetchStudentsPage(filters, cursor),
    placeholderData: keepPreviousData,
    enabled: filters.classId === "",
  });

  const classFilteredQuery = useQuery({
    queryKey: studentsInClassQueryKey(filters.classId, filters),
    queryFn: () => fetchStudentsInClass(filters.classId, filters),
    placeholderData: keepPreviousData,
    enabled: filters.classId !== "",
  });

  const isClassFiltered = filters.classId !== "";
  const rows = isClassFiltered
    ? (classFilteredQuery.data ?? [])
    : (pagedQuery.data?.students ?? []);
  const isPending = isClassFiltered ? classFilteredQuery.isPending : pagedQuery.isPending;
  const isError = isClassFiltered ? classFilteredQuery.isError : pagedQuery.isError;

  const [createOpen, setCreateOpen] = useState(false);

  const columns = [
    {
      id: "name",
      header: "Name",
      renderCell: (student: StudentProfile) => fullName(student) || "—",
    },
    ...(canViewAdmissionData
      ? [
          {
            id: "admission_number",
            header: "Admission #",
            renderCell: (student: StudentProfile) => student.admission_number || "—",
          },
        ]
      : []),
    {
      id: "status",
      header: "Status",
      renderCell: (student: StudentProfile) => (
        <span className="students-list__status-pill" data-status={student.status}>
          {STATUS_LABELS[student.status]}
        </span>
      ),
    },
    {
      id: "date_of_birth",
      header: "Date of birth",
      renderCell: (student: StudentProfile) => student.date_of_birth ?? "—",
    },
    {
      id: "actions",
      header: "Actions",
      renderCell: (student: StudentProfile) => (
        <Button variant="tertiary" onClick={() => navigate(`/portal/admin/students/${student.id}`)}>
          View
        </Button>
      ),
    },
  ];

  return (
    <>
      <div className="students-list__header">
        <div>
          <h1>Students</h1>
          <p>Search the student directory, review profiles, and manage guardian links.</p>
        </div>
        <div className="students-list__header-actions">
          {canImport ? (
            <Button variant="secondary" onClick={() => navigate("/portal/admin/students/import")}>
              Import CSV
            </Button>
          ) : null}
          {canCreate ? <Button onClick={() => setCreateOpen(true)}>New student</Button> : null}
        </div>
      </div>

      <div className="students-list__toolbar">
        <FilterBar
          searchLabel="Search"
          searchPlaceholder="Search by name or admission number"
          search={searchInput}
          onSearchChange={setSearchInput}
          dateRange={dateRange}
          dateRangeLabel="Admitted between"
          onDateRangeChange={setDateRange}
        />
        <Select
          label="Status"
          options={STATUS_OPTIONS}
          value={status}
          onChange={(value) => setStatus(value)}
        />
        <Select
          label="Class"
          options={classOptions}
          value={classId}
          onChange={(value) => setClassId(value)}
        />
      </div>

      <DataGrid
        caption="Students"
        columns={columns}
        rows={rows}
        getRowId={(student) => student.id}
        getRowLabel={(student) => fullName(student)}
        loading={isPending}
        empty={isError ? "Unable to load students." : "No students match these filters."}
      />

      {isClassFiltered ? null : (
        <div className="students-list__pagination">
          <Button
            variant="secondary"
            disabled={cursorHistory.length === 0}
            onClick={() => {
              const next = [...cursorHistory];
              const previous = next.pop();
              setCursorHistory(next);
              setCursor(previous);
            }}
          >
            Previous
          </Button>
          <Button
            variant="secondary"
            disabled={!pagedQuery.data?.next_cursor}
            onClick={() => {
              const nextCursor = pagedQuery.data?.next_cursor;
              if (!nextCursor) return;
              setCursorHistory([...cursorHistory, cursor]);
              setCursor(nextCursor);
            }}
          >
            Next
          </Button>
        </div>
      )}

      <CreateStudentModal open={createOpen} onClose={() => setCreateOpen(false)} />
    </>
  );
}
