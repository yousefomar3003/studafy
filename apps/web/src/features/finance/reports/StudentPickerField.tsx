import { Button, Input } from "@studafy/ui";
import { useQuery } from "@tanstack/react-query";
import { useEffect, useState } from "react";

import { searchStudents, studentDisplayName, studentSearchQueryKey } from "../fees/queries";

import type { StudentProfile } from "../fees/queries";

const SEARCH_DEBOUNCE_MS = 300;

export interface StudentPickerFieldProps {
  value: StudentProfile | null;
  onChange: (student: StudentProfile | null) => void;
}

/**
 * Optional single-student scope for a report run — same search-then-pick shape as
 * `adjustments/StudentPickerField` and `fees/StudentPickerField`, reimplemented here rather than
 * imported (each feature folder owns its own picker markup, per those components' own doc
 * comments). Scoped to at most one student: the report endpoints themselves accept many
 * (`student_ids`), but narrowing a report to "this household's kid" is the report center's actual
 * use case, and a multi-select adds real UI weight for a filter most runs leave off entirely.
 */
export function StudentPickerField({ value, onChange }: StudentPickerFieldProps) {
  const [searchInput, setSearchInput] = useState("");
  const [debouncedSearch, setDebouncedSearch] = useState("");

  useEffect(() => {
    const handle = setTimeout(() => setDebouncedSearch(searchInput), SEARCH_DEBOUNCE_MS);
    return () => clearTimeout(handle);
  }, [searchInput]);

  const resultsQuery = useQuery({
    queryKey: studentSearchQueryKey(debouncedSearch),
    queryFn: () => searchStudents(debouncedSearch),
    enabled: debouncedSearch.trim().length > 0 && value === null,
  });

  if (value) {
    return (
      <div className="reports-filter__student-selected">
        <div>
          <span className="sf-field__label">Student</span>
          <p>
            {studentDisplayName(value)} &mdash; {value.admission_number}
          </p>
        </div>
        <Button type="button" variant="tertiary" onClick={() => onChange(null)}>
          Clear
        </Button>
      </div>
    );
  }

  return (
    <div className="reports-filter__student-picker">
      <Input
        label="Student (optional)"
        type="search"
        placeholder="Search by name or admission number"
        value={searchInput}
        onChange={(event) => setSearchInput(event.target.value)}
        helperText="Leave blank to run the report for every student."
      />
      {debouncedSearch.trim() ? (
        <ul className="reports-filter__student-results">
          {(resultsQuery.data ?? []).map((student) => (
            <li key={student.id}>
              <button
                type="button"
                className="reports-filter__student-result"
                onClick={() => {
                  onChange(student);
                  setSearchInput("");
                  setDebouncedSearch("");
                }}
              >
                <strong>{studentDisplayName(student)}</strong>
                <span>{student.admission_number}</span>
              </button>
            </li>
          ))}
          {!resultsQuery.isPending && resultsQuery.data?.length === 0 ? (
            <li className="reports-filter__student-empty">No students match.</li>
          ) : null}
        </ul>
      ) : null}
    </div>
  );
}
