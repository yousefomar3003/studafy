import { Button, Input, Select } from "@studafy/ui";
import { useQuery } from "@tanstack/react-query";
import { useEffect, useState } from "react";

import { useTranslation } from "../../../lib/i18n";
import { parentSearchQueryKey, searchParentUsers } from "../students/queries";
import { RELATIONSHIP_LABEL_KEYS } from "../students/schema";

import {
  familySearchQueryKey,
  searchFamilies,
  searchStudents,
  studentSearchQueryKey,
} from "./queries";

import "./people-links.css";

import type { Family, StudentProfile } from "./queries";
import type { UserWithRoles } from "../students/queries";
import type { GuardianRelationship } from "../students/schema";
import type { SelectOption } from "@studafy/ui";
import type { ReactNode } from "react";

/**
 * Pickers for linking parents and students while creating one of them. Staff search and pick each
 * person themselves: nothing is matched or linked by name, email or any ID number. The searches are
 * plain debounced lists, as in LinkGuardianModal -- `@studafy/ui` has no combobox, and `Select`'s
 * options are a fixed synchronous list.
 */

const SEARCH_DEBOUNCE_MS = 300;

function useDebounced(value: string): string {
  const [debounced, setDebounced] = useState(value);
  useEffect(() => {
    const handle = setTimeout(() => setDebounced(value), SEARCH_DEBOUNCE_MS);
    return () => clearTimeout(handle);
  }, [value]);
  return debounced;
}

function useRelationshipOptions(): SelectOption<GuardianRelationship>[] {
  const { t } = useTranslation();
  return (Object.entries(RELATIONSHIP_LABEL_KEYS) as [GuardianRelationship, string][]).map(
    ([value, key]) => ({ value, label: t(key) }),
  );
}

interface SearchListProps<T> {
  label: string;
  placeholder: string;
  noMatches: string;
  queryKeyFor: (term: string) => readonly unknown[];
  search: (term: string) => Promise<T[]>;
  /** Hides results already picked. */
  exclude?: (item: T) => boolean;
  getKey: (item: T) => string;
  renderItem: (item: T) => ReactNode;
  onPick: (item: T) => void;
}

function SearchList<T>({
  label,
  placeholder,
  noMatches,
  queryKeyFor,
  search,
  exclude,
  getKey,
  renderItem,
  onPick,
}: SearchListProps<T>) {
  const [input, setInput] = useState("");
  const term = useDebounced(input).trim();
  const results = useQuery({
    queryKey: queryKeyFor(term),
    queryFn: () => search(term),
    enabled: term.length > 0,
  });
  const items = (results.data ?? []).filter((item) => !exclude?.(item));

  return (
    <div className="people-links__search">
      <Input
        label={label}
        type="search"
        placeholder={placeholder}
        value={input}
        onChange={(event) => setInput(event.target.value)}
      />
      {term ? (
        <ul className="people-links__results">
          {items.map((item) => (
            <li key={getKey(item)}>
              <button
                type="button"
                className="people-links__result"
                onClick={() => {
                  onPick(item);
                  setInput("");
                }}
              >
                {renderItem(item)}
              </button>
            </li>
          ))}
          {!results.isPending && items.length === 0 ? (
            <li className="people-links__empty">{noMatches}</li>
          ) : null}
        </ul>
      ) : null}
    </div>
  );
}

function parentName(parent: UserWithRoles, fallback: string): string {
  return parent.display_name ?? parent.email ?? fallback;
}

export function studentName(student: StudentProfile): string {
  return `${student.preferred_name ?? student.first_name} ${student.last_name}`;
}

// ---------------------------------------------------------------------------
// Guardians (Create student)
// ---------------------------------------------------------------------------

export interface GuardianDraft {
  parent: UserWithRoles;
  relationship: GuardianRelationship;
  /** An existing household to join; null keeps the guardian's own (created on their first link). */
  family: Family | null;
}

export interface GuardianPickerProps {
  value: GuardianDraft[];
  onChange: (next: GuardianDraft[]) => void;
}

export function GuardianPicker({ value, onChange }: GuardianPickerProps) {
  const { t } = useTranslation();
  const relationshipOptions = useRelationshipOptions();
  const [choosingFamilyFor, setChoosingFamilyFor] = useState<string | null>(null);
  const fallback = t("adminPeople.students.linkGuardian.guardianFallback");

  function update(parentId: string, patch: Partial<GuardianDraft>) {
    onChange(value.map((draft) => (draft.parent.id === parentId ? { ...draft, ...patch } : draft)));
  }

  return (
    <fieldset className="people-links">
      <legend>{t("adminPeople.links.guardians.legend")}</legend>
      <p className="people-links__hint">{t("adminPeople.links.guardians.hint")}</p>

      {value.length > 0 ? (
        <ul className="people-links__picked" aria-label={t("adminPeople.links.guardians.picked")}>
          {value.map((draft) => {
            const name = parentName(draft.parent, fallback);
            return (
              <li key={draft.parent.id} className="people-links__row">
                <div className="people-links__row-head">
                  <div>
                    <strong>{name}</strong>
                    {draft.parent.email ? <p>{draft.parent.email}</p> : null}
                  </div>
                  <Button
                    type="button"
                    variant="tertiary"
                    onClick={() => onChange(value.filter((d) => d.parent.id !== draft.parent.id))}
                  >
                    {t("adminPeople.links.remove", { name })}
                  </Button>
                </div>
                <Select
                  label={t("adminPeople.links.relationshipFor", { name })}
                  options={relationshipOptions}
                  value={draft.relationship}
                  onChange={(relationship) => update(draft.parent.id, { relationship })}
                  required
                />
                <div className="people-links__family">
                  <span>
                    {draft.family
                      ? t("adminPeople.links.guardians.joinsFamily", {
                          family: draft.family.display_name,
                        })
                      : t("adminPeople.links.guardians.ownFamily")}
                  </span>
                  {draft.family ? (
                    <Button
                      type="button"
                      variant="tertiary"
                      onClick={() => update(draft.parent.id, { family: null })}
                    >
                      {t("adminPeople.links.guardians.useOwnFamily")}
                    </Button>
                  ) : choosingFamilyFor !== draft.parent.id ? (
                    <Button
                      type="button"
                      variant="tertiary"
                      onClick={() => setChoosingFamilyFor(draft.parent.id)}
                    >
                      {t("adminPeople.links.guardians.chooseFamily")}
                    </Button>
                  ) : null}
                </div>
                {choosingFamilyFor === draft.parent.id && !draft.family ? (
                  <SearchList<Family>
                    label={t("adminPeople.links.guardians.searchFamilies")}
                    placeholder={t("adminPeople.links.guardians.searchFamiliesPlaceholder")}
                    noMatches={t("adminPeople.links.guardians.noFamilies")}
                    queryKeyFor={familySearchQueryKey}
                    search={searchFamilies}
                    getKey={(family) => family.id}
                    renderItem={(family) => <strong>{family.display_name}</strong>}
                    onPick={(family) => {
                      update(draft.parent.id, { family });
                      setChoosingFamilyFor(null);
                    }}
                  />
                ) : null}
              </li>
            );
          })}
        </ul>
      ) : null}

      <SearchList<UserWithRoles>
        label={t("adminPeople.students.linkGuardian.searchParents")}
        placeholder={t("adminPeople.students.linkGuardian.searchPlaceholder")}
        noMatches={t("adminPeople.students.linkGuardian.noMatches")}
        queryKeyFor={parentSearchQueryKey}
        search={searchParentUsers}
        exclude={(parent) => value.some((draft) => draft.parent.id === parent.id)}
        getKey={(parent) => parent.id}
        renderItem={(parent) => (
          <>
            <strong>{parentName(parent, fallback)}</strong>
            <span>{parent.email}</span>
          </>
        )}
        onPick={(parent) =>
          onChange([...value, { parent, relationship: "guardian", family: null }])
        }
      />
    </fieldset>
  );
}

// ---------------------------------------------------------------------------
// Children (Create user with the PARENT role, and linking an existing parent)
// ---------------------------------------------------------------------------

export interface ChildDraft {
  student: StudentProfile;
  relationship: GuardianRelationship;
}

export interface ChildrenPickerProps {
  value: ChildDraft[];
  onChange: (next: ChildDraft[]) => void;
  /** Overrides the legend, e.g. when the picker is a modal's only content. */
  legend?: string;
}

export function ChildrenPicker({ value, onChange, legend }: ChildrenPickerProps) {
  const { t } = useTranslation();
  const relationshipOptions = useRelationshipOptions();

  return (
    <fieldset className="people-links">
      <legend>{legend ?? t("adminPeople.links.children.legend")}</legend>
      <p className="people-links__hint">{t("adminPeople.links.children.hint")}</p>

      {value.length > 0 ? (
        <ul className="people-links__picked" aria-label={t("adminPeople.links.children.picked")}>
          {value.map((draft) => {
            const name = studentName(draft.student);
            return (
              <li key={draft.student.id} className="people-links__row">
                <div className="people-links__row-head">
                  <div>
                    <strong>{name}</strong>
                    <p>{draft.student.admission_number}</p>
                  </div>
                  <Button
                    type="button"
                    variant="tertiary"
                    onClick={() => onChange(value.filter((d) => d.student.id !== draft.student.id))}
                  >
                    {t("adminPeople.links.remove", { name })}
                  </Button>
                </div>
                <Select
                  label={t("adminPeople.links.relationshipFor", { name })}
                  options={relationshipOptions}
                  value={draft.relationship}
                  onChange={(relationship) =>
                    onChange(
                      value.map((d) =>
                        d.student.id === draft.student.id ? { ...d, relationship } : d,
                      ),
                    )
                  }
                  required
                />
              </li>
            );
          })}
        </ul>
      ) : null}

      <SearchList<StudentProfile>
        label={t("adminPeople.links.children.searchStudents")}
        placeholder={t("adminPeople.links.children.searchPlaceholder")}
        noMatches={t("adminPeople.links.children.noMatches")}
        queryKeyFor={studentSearchQueryKey}
        search={searchStudents}
        exclude={(student) => value.some((draft) => draft.student.id === student.id)}
        getKey={(student) => student.id}
        renderItem={(student) => (
          <>
            <strong>{studentName(student)}</strong>
            <span>{student.admission_number}</span>
          </>
        )}
        onPick={(student) => onChange([...value, { student, relationship: "guardian" }])}
      />
    </fieldset>
  );
}
