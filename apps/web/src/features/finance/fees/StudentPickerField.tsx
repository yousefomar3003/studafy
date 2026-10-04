import { Button, Input } from "@studafy/ui";
import { useQuery } from "@tanstack/react-query";
import { useEffect, useState } from "react";

import { useTranslation } from "../../../lib/i18n";

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
  const { t } = useTranslation();
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
          <span className="sf-field__label">{t("finance.fees.studentPicker.label")}</span>
          <p>
            {studentDisplayName(value)} — {value.admission_number}
          </p>
        </div>
        <Button type="button" variant="tertiary" onClick={() => onChange(null)}>
          {t("finance.fees.studentPicker.clear")}
        </Button>
      </div>
    );
  }

  return (
    <div className="fee-builder__student-picker">
      <Input
        label={t("finance.fees.studentPicker.label")}
        type="search"
        placeholder={t("finance.fees.studentPicker.placeholder")}
        value={searchInput}
        onChange={(event) => setSearchInput(event.target.value)}
        helperText={t("finance.fees.studentPicker.helper")}
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
            <li className="fee-builder__student-empty">{t("finance.fees.studentPicker.empty")}</li>
          ) : null}
        </ul>
      ) : null}
    </div>
  );
}
