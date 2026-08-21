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
 * Search-as-you-type student picker for the scholarship award flow's maker step. Same shape as
 * `fees/StudentPickerField` and `payments/InvoicePickerField` — there is no combobox primitive in
 * `@studafy/ui`, so search-then-pick-a-result is the established pattern, reimplemented here (not
 * imported) because each feature folder owns its own picker markup and stylesheet, same as those two.
 * The search/fetch logic itself (`searchStudents`) is reused directly from `fees/queries`, not
 * duplicated — only the presentational component is feature-local.
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
      <div className="adjustments-form__student-selected">
        <div>
          <span className="sf-field__label">Student</span>
          <p>
            {studentDisplayName(value)} &mdash; {value.admission_number}
          </p>
        </div>
        <Button type="button" variant="tertiary" onClick={() => onChange(null)}>
          Change
        </Button>
      </div>
    );
  }

  return (
    <div className="adjustments-form__student-picker">
      <Input
        label="Student"
        type="search"
        placeholder="Search by name or admission number"
        value={searchInput}
        onChange={(event) => setSearchInput(event.target.value)}
        required
      />
      {debouncedSearch.trim() ? (
        <ul className="adjustments-form__student-results">
          {(resultsQuery.data ?? []).map((student) => (
            <li key={student.id}>
              <button
                type="button"
                className="adjustments-form__student-result"
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
            <li className="adjustments-form__student-empty">No students match.</li>
          ) : null}
        </ul>
      ) : null}
    </div>
  );
}
