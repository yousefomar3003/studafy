import { Button, Input } from "@studafy/ui";
import { useQuery } from "@tanstack/react-query";
import { useEffect, useState } from "react";

import { searchStudents, studentDisplayName, studentSearchQueryKey } from "./queries";

import type { StudentProfile } from "./queries";

const SEARCH_DEBOUNCE_MS = 300;

export interface StudentPickerFieldProps {
  value: StudentProfile | null;
  onChange: (student: StudentProfile | null) => void;
}

/**
 * Search-as-you-type student picker for the preview panel's "sample student." Same shape as
 * `admin/audit/ActorFilterField`'s actor picker — there is no combobox primitive in `@studafy/ui`,
 * so search-then-pick-a-result is the established pattern for resolving a name into an id.
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
      <div className="fee-builder__student-selected">
        <div>
          <span className="sf-field__label">Sample student</span>
          <p>
            {studentDisplayName(value)} — {value.admission_number}
          </p>
        </div>
        <Button type="button" variant="tertiary" onClick={() => onChange(null)}>
          Clear
        </Button>
      </div>
    );
  }

  return (
    <div className="fee-builder__student-picker">
      <Input
        label="Sample student"
        type="search"
        placeholder="Search by name or admission number"
        value={searchInput}
        onChange={(event) => setSearchInput(event.target.value)}
        helperText="Picks a real student to preview the invoice this structure would generate."
      />
      {debouncedSearch.trim() ? (
        <ul className="fee-builder__student-results">
          {(resultsQuery.data ?? []).map((student) => (
            <li key={student.id}>
              <button
                type="button"
                className="fee-builder__student-result"
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
            <li className="fee-builder__student-empty">No students match.</li>
          ) : null}
        </ul>
      ) : null}
    </div>
  );
}
