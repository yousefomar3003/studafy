import { Button, Input } from "@studafy/ui";
import { useQuery } from "@tanstack/react-query";
import { useEffect, useState } from "react";

import { actorSearchQueryKey, searchActorUsers } from "./queries";

import type { UserWithRoles } from "./queries";

const SEARCH_DEBOUNCE_MS = 300;

export interface ActorFilterFieldProps {
  value: UserWithRoles | null;
  onChange: (actor: UserWithRoles | null) => void;
}

/**
 * The filter bar's actor picker: audit entries are filtered by `actor_id` (a UUID), not a name, so
 * this resolves a search-as-you-type pick into that id the same way `students/LinkGuardianModal`'s
 * parent picker does — there is no combobox primitive in `@studafy/ui` to reach for instead.
 */
export function ActorFilterField({ value, onChange }: ActorFilterFieldProps) {
  const [searchInput, setSearchInput] = useState("");
  const [debouncedSearch, setDebouncedSearch] = useState("");

  useEffect(() => {
    const handle = setTimeout(() => setDebouncedSearch(searchInput), SEARCH_DEBOUNCE_MS);
    return () => clearTimeout(handle);
  }, [searchInput]);

  const resultsQuery = useQuery({
    queryKey: actorSearchQueryKey(debouncedSearch),
    queryFn: () => searchActorUsers(debouncedSearch),
    enabled: debouncedSearch.trim().length > 0 && value === null,
  });

  if (value) {
    return (
      <div className="audit-explorer__actor-selected">
        <div>
          <span className="sf-field__label">Actor</span>
          <p>{value.display_name ?? value.email}</p>
        </div>
        <Button type="button" variant="tertiary" onClick={() => onChange(null)}>
          Clear
        </Button>
      </div>
    );
  }

  return (
    <div className="audit-explorer__actor-picker">
      <Input
        label="Actor"
        type="search"
        placeholder="Search by name or email"
        value={searchInput}
        onChange={(event) => setSearchInput(event.target.value)}
      />
      {debouncedSearch.trim() ? (
        <ul className="audit-explorer__actor-results">
          {(resultsQuery.data ?? []).map((user) => (
            <li key={user.id}>
              <button
                type="button"
                className="audit-explorer__actor-result"
                onClick={() => {
                  onChange(user);
                  setSearchInput("");
                  setDebouncedSearch("");
                }}
              >
                <strong>{user.display_name ?? user.email}</strong>
                <span>{user.email}</span>
              </button>
            </li>
          ))}
          {!resultsQuery.isPending && resultsQuery.data?.length === 0 ? (
            <li className="audit-explorer__actor-empty">No users match.</li>
          ) : null}
        </ul>
      ) : null}
    </div>
  );
}
