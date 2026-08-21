import { Button, Input } from "@studafy/ui";
import { useQuery } from "@tanstack/react-query";
import { useEffect, useState } from "react";

import { familySearchQueryKey, searchFamilies } from "./queries";

import type { Family } from "./queries";

const SEARCH_DEBOUNCE_MS = 300;

export interface FamilyPickerFieldProps {
  value: Family | null;
  onChange: (family: Family | null) => void;
}

/** Search-as-you-type household picker for the family statement report, same search-then-pick
 * shape as `StudentPickerField` in this folder. A family statement always needs exactly one
 * household — there is no "every family" run, unlike the other three report types' optional
 * student scope. */
export function FamilyPickerField({ value, onChange }: FamilyPickerFieldProps) {
  const [searchInput, setSearchInput] = useState("");
  const [debouncedSearch, setDebouncedSearch] = useState("");

  useEffect(() => {
    const handle = setTimeout(() => setDebouncedSearch(searchInput), SEARCH_DEBOUNCE_MS);
    return () => clearTimeout(handle);
  }, [searchInput]);

  const resultsQuery = useQuery({
    queryKey: familySearchQueryKey(debouncedSearch),
    queryFn: () => searchFamilies(debouncedSearch),
    enabled: debouncedSearch.trim().length > 0 && value === null,
  });

  if (value) {
    return (
      <div className="reports-filter__student-selected">
        <div>
          <span className="sf-field__label">Family</span>
          <p>{value.display_name}</p>
        </div>
        <Button type="button" variant="tertiary" onClick={() => onChange(null)}>
          Change
        </Button>
      </div>
    );
  }

  return (
    <div className="reports-filter__student-picker">
      <Input
        label="Family"
        type="search"
        placeholder="Search by household name"
        value={searchInput}
        onChange={(event) => setSearchInput(event.target.value)}
        required
      />
      {debouncedSearch.trim() ? (
        <ul className="reports-filter__student-results">
          {(resultsQuery.data ?? []).map((family) => (
            <li key={family.id}>
              <button
                type="button"
                className="reports-filter__student-result"
                onClick={() => {
                  onChange(family);
                  setSearchInput("");
                  setDebouncedSearch("");
                }}
              >
                <strong>{family.display_name}</strong>
              </button>
            </li>
          ))}
          {!resultsQuery.isPending && resultsQuery.data?.length === 0 ? (
            <li className="reports-filter__student-empty">No families match.</li>
          ) : null}
        </ul>
      ) : null}
    </div>
  );
}
