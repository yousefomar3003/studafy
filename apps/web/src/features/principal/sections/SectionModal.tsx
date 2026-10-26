import { ApiError } from "@studafy/api-client";
import { Button, Input, Modal, Select, useToast } from "@studafy/ui";
import { useEffect, useState } from "react";

import { useTranslation } from "../../../lib/i18n";

import { useCreateSection, useRenameSection } from "./mutations";
import { sectionDisplayName } from "./queries";

import type { GradeLevel, Section } from "./queries";

/** Mirrors `createSectionBodySchema`'s 1–50 character name. */
const MAX_NAME_LENGTH = 50;

export interface SectionModalProps {
  open: boolean;
  /** `null` adds a section to `academicYearId`; otherwise renames this one. */
  section: Section | null;
  academicYearId: string;
  grades: readonly GradeLevel[];
  onClose: () => void;
}

function apiErrorDescription(error: unknown): string | undefined {
  return error instanceof ApiError ? (error.detail ?? error.title) : undefined;
}

/** Adds a section ("C") to a grade for the selected year, or renames one. A section's grade and
 * year are fixed once it exists. */
export function SectionModal({
  open,
  section,
  academicYearId,
  grades,
  onClose,
}: SectionModalProps) {
  const { t } = useTranslation();
  const { show } = useToast();
  const create = useCreateSection();
  const rename = useRenameSection();
  const saving = section ? rename : create;
  const [gradeId, setGradeId] = useState("");
  const [name, setName] = useState("");

  useEffect(() => {
    if (!open) return;
    setGradeId(section?.grade_level_id ?? "");
    setName(section?.name ?? "");
  }, [open, section]);

  const canSubmit = name.trim() !== "" && (section !== null || gradeId !== "");

  function handleSubmit() {
    if (!canSubmit) return;
    const onSuccess = () => {
      show({
        variant: "success",
        title: section
          ? t("principal.sections.sectionModal.updated")
          : t("principal.sections.sectionModal.created"),
      });
      onClose();
    };
    const onError = (error: unknown) =>
      show({
        variant: "error",
        title: t("principal.sections.sectionModal.saveFailed"),
        description: apiErrorDescription(error),
      });

    if (section) {
      rename.mutate({ sectionId: section.id, name: name.trim() }, { onSuccess, onError });
    } else {
      create.mutate(
        { academic_year_id: academicYearId, grade_level_id: gradeId, name: name.trim() },
        { onSuccess, onError },
      );
    }
  }

  return (
    <Modal
      open={open}
      onClose={onClose}
      title={
        section
          ? t("principal.sections.sectionModal.editTitle")
          : t("principal.sections.sectionModal.addTitle")
      }
      description={section ? sectionDisplayName(section, t) : undefined}
    >
      <Modal.Body>
        <div className="sections-form">
          {section ? null : (
            <Select
              label={t("principal.sections.sectionModal.grade")}
              options={grades.map((grade) => ({ value: grade.id, label: grade.name }))}
              value={gradeId}
              onChange={setGradeId}
              placeholder={t("principal.sections.sectionModal.gradePlaceholder")}
              required
            />
          )}
          <Input
            label={t("principal.sections.sectionModal.name")}
            value={name}
            required
            maxLength={MAX_NAME_LENGTH}
            placeholder={t("principal.sections.sectionModal.namePlaceholder")}
            onChange={(event) => setName(event.target.value)}
          />
        </div>
      </Modal.Body>
      <Modal.Footer>
        <Button type="button" variant="tertiary" onClick={onClose}>
          {t("principal.common.cancel")}
        </Button>
        <Button
          type="button"
          loading={saving.isPending}
          disabled={!canSubmit}
          onClick={handleSubmit}
        >
          {section
            ? t("principal.sections.sectionModal.save")
            : t("principal.sections.sectionModal.add")}
        </Button>
      </Modal.Footer>
    </Modal>
  );
}
