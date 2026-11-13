import { ApiError } from "@studafy/api-client";
import { Button, Input, Modal, useToast } from "@studafy/ui";
import { useEffect, useState } from "react";

import { useTranslation } from "../../../lib/i18n";
import { studentDisplayName } from "../school/queries";

import { usePlaceStudent, useRemoveStudent } from "./mutations";
import {
  sectionDisplayName,
  useSectionClasses,
  useSectionStudents,
  useStudentSearch,
} from "./queries";

import type { Section } from "./queries";

const SEARCH_DEBOUNCE_MS = 300;

export interface SectionStudentsModalProps {
  /** The section whose roster is open; `null` closes the modal. */
  section: Section | null;
  onClose: () => void;
}

function apiErrorDescription(error: unknown): string | undefined {
  return error instanceof ApiError ? (error.detail ?? error.title) : undefined;
}

/**
 * A section's students: remove one, or search the school's students and add one. Adding a student
 * moves them out of any other section of the same year and enrols them into this section's classes;
 * a class that is already full is skipped, and the modal names those classes so the gap is visible.
 * Search uses the student directory's server-side search — `Select` takes a fixed option list, so,
 * like `LinkGuardianModal`, this is a debounced search list instead.
 */
export function SectionStudentsModal({ section, onClose }: SectionStudentsModalProps) {
  const { t } = useTranslation();
  const { show } = useToast();
  const sectionId = section?.id;
  const students = useSectionStudents(sectionId);
  const classes = useSectionClasses(sectionId);
  const place = usePlaceStudent();
  const remove = useRemoveStudent();

  const [searchInput, setSearchInput] = useState("");
  const [debouncedSearch, setDebouncedSearch] = useState("");
  const [skippedClassIds, setSkippedClassIds] = useState<readonly string[]>([]);
  const results = useStudentSearch(debouncedSearch);

  useEffect(() => {
    const handle = setTimeout(() => setDebouncedSearch(searchInput), SEARCH_DEBOUNCE_MS);
    return () => clearTimeout(handle);
  }, [searchInput]);

  // Each section opens on a clean search and no stale capacity notice.
  useEffect(() => {
    setSearchInput("");
    setDebouncedSearch("");
    setSkippedClassIds([]);
  }, [sectionId]);

  if (!section) return null;

  const roster = [...(students.data ?? [])].sort((a, b) =>
    `${a.last_name} ${a.first_name}`.localeCompare(`${b.last_name} ${b.first_name}`),
  );
  const placedIds = new Set(roster.map((student) => student.student_id));
  const classCode = new Map((classes.data ?? []).map((klass) => [klass.id, klass.code]));
  const skippedCodes = skippedClassIds.map(
    (id) => classCode.get(id) ?? t("principal.sections.students.unknownClass"),
  );

  function handleAdd(studentId: string, name: string) {
    place.mutate(
      { sectionId: section!.id, studentId },
      {
        onSuccess: (result) => {
          show({ variant: "success", title: t("principal.sections.students.added", { name }) });
          setSkippedClassIds(result.skipped_class_ids);
          setSearchInput("");
          setDebouncedSearch("");
        },
        onError: (error) =>
          show({
            variant: "error",
            title: t("principal.sections.students.addFailed"),
            description: apiErrorDescription(error),
          }),
      },
    );
  }

  function handleRemove(studentId: string, name: string) {
    remove.mutate(
      { sectionId: section!.id, studentId },
      {
        onSuccess: () =>
          show({ variant: "success", title: t("principal.sections.students.removed", { name }) }),
        onError: (error) =>
          show({
            variant: "error",
            title: t("principal.sections.students.removeFailed"),
            description: apiErrorDescription(error),
          }),
      },
    );
  }

  const matches = results.data?.students ?? [];

  return (
    <Modal
      open
      onClose={onClose}
      title={t("principal.sections.students.title", { section: sectionDisplayName(section, t) })}
      description={t("principal.sections.students.description")}
    >
      <Modal.Body>
        {skippedCodes.length > 0 ? (
          <p role="status" className="sections-notice">
            {t("principal.sections.students.skipped", {
              count: skippedCodes.length,
              classes: skippedCodes.join(", "),
            })}
          </p>
        ) : null}

        <Input
          label={t("principal.sections.students.search")}
          type="search"
          placeholder={t("principal.sections.students.searchPlaceholder")}
          value={searchInput}
          onChange={(event) => setSearchInput(event.target.value)}
        />
        {debouncedSearch.trim() ? (
          <ul className="sections-list" aria-label={t("principal.sections.students.searchResults")}>
            {matches.map((student) => {
              const name = studentDisplayName(student);
              const placed = placedIds.has(student.id);
              return (
                <li key={student.id} className="sections-list__row">
                  <span>
                    <strong>{name}</strong>
                    <span className="sections-list__meta">{student.admission_number}</span>
                  </span>
                  {placed ? (
                    <span className="sections-list__meta">
                      {t("principal.sections.students.alreadyPlaced")}
                    </span>
                  ) : (
                    <Button
                      type="button"
                      variant="secondary"
                      disabled={place.isPending}
                      aria-label={t("principal.sections.students.addLabel", { name })}
                      onClick={() => handleAdd(student.id, name)}
                    >
                      {t("principal.sections.students.add")}
                    </Button>
                  )}
                </li>
              );
            })}
            {!results.isPending && matches.length === 0 ? (
              <li className="sections-list__empty">{t("principal.sections.students.noMatches")}</li>
            ) : null}
          </ul>
        ) : null}

        <h3 className="sections-modal__heading">
          {t("principal.sections.students.rosterHeading", { count: roster.length })}
        </h3>
        {students.isPending ? (
          <p role="status">{t("principal.common.loading")}</p>
        ) : students.isError ? (
          <p role="alert">{t("principal.sections.students.loadError")}</p>
        ) : roster.length === 0 ? (
          <p className="sections-list__empty">{t("principal.sections.students.empty")}</p>
        ) : (
          <ul className="sections-list">
            {roster.map((student) => {
              const name = `${student.first_name} ${student.last_name}`;
              return (
                <li key={student.student_id} className="sections-list__row">
                  <span>
                    <strong>{name}</strong>
                    <span className="sections-list__meta">{student.admission_number}</span>
                  </span>
                  <Button
                    type="button"
                    variant="tertiary"
                    disabled={remove.isPending}
                    aria-label={t("principal.sections.students.removeLabel", { name })}
                    onClick={() => handleRemove(student.student_id, name)}
                  >
                    {t("principal.sections.students.remove")}
                  </Button>
                </li>
              );
            })}
          </ul>
        )}
      </Modal.Body>
      <Modal.Footer>
        <Button type="button" variant="secondary" onClick={onClose}>
          {t("principal.sections.students.done")}
        </Button>
      </Modal.Footer>
    </Modal>
  );
}
