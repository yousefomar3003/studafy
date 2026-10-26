import { ApiError } from "@studafy/api-client";
import { Button, Input, Modal, Select, useToast } from "@studafy/ui";
import { useEffect, useState } from "react";

import { useTranslation } from "../../../lib/i18n";
import { useSubjects } from "../school/queries";

import { useCreateCourse, useCreateSubject } from "./mutations";

import type { Course } from "../school/queries";
import type { TFunction } from "i18next";

import "../sections/sections.css";

/** `Select` values are strings; this one stands for "create a new subject". */
const NEW_SUBJECT = "new";
/** Mirrors the catalog body schemas: a 1–50 character code and a 1–200 character name. */
const MAX_CODE_LENGTH = 50;
const MAX_NAME_LENGTH = 200;

export interface AddCourseModalProps {
  open: boolean;
  onClose: () => void;
  /** Called with the new course once it exists, so the opener can select it. */
  onCreated: (course: Course) => void;
}

function saveErrorDescription(error: unknown, t: TFunction): string | undefined {
  if (!(error instanceof ApiError)) return undefined;
  if (error.status === 409) return t("principal.classes.courseModal.duplicateCode");
  return error.detail ?? error.title;
}

/**
 * Adds a course to the catalog ("Algebra I"), under an existing subject or a new one created here
 * ("Mathematics"). Both are created active, so the course can carry classes straight away. When the
 * subject is created but the course isn't (say, a duplicate code), the form switches to that new
 * subject so a retry doesn't try to create it twice.
 */
export function AddCourseModal({ open, onClose, onCreated }: AddCourseModalProps) {
  const { t } = useTranslation();
  const { show } = useToast();
  const subjects = useSubjects(open);
  const createSubject = useCreateSubject();
  const createCourse = useCreateCourse();
  const [subjectId, setSubjectId] = useState<string>();
  const [subjectName, setSubjectName] = useState("");
  const [subjectCode, setSubjectCode] = useState("");
  const [courseName, setCourseName] = useState("");
  const [courseCode, setCourseCode] = useState("");

  useEffect(() => {
    if (!open) return;
    setSubjectId(undefined);
    setSubjectName("");
    setSubjectCode("");
    setCourseName("");
    setCourseCode("");
  }, [open]);

  const subjectList = [...(subjects.data ?? [])].sort((a, b) => a.name.localeCompare(b.name));
  // With no subjects yet, the only choice is a new one.
  const chosenSubject =
    subjectId ?? (subjects.isSuccess && subjectList.length === 0 ? NEW_SUBJECT : undefined);
  const isNewSubject = chosenSubject === NEW_SUBJECT;
  const saving = createSubject.isPending || createCourse.isPending;
  const canSubmit =
    chosenSubject !== undefined &&
    (!isNewSubject || (subjectName.trim() !== "" && subjectCode.trim() !== "")) &&
    courseName.trim() !== "" &&
    courseCode.trim() !== "";

  const subjectOptions = [
    ...subjectList.map((subject) => ({
      value: subject.id,
      label: t("principal.classes.courseModal.subjectOption", {
        code: subject.code,
        name: subject.name,
      }),
    })),
    { value: NEW_SUBJECT, label: t("principal.classes.courseModal.newSubject") },
  ];

  function onError(error: unknown) {
    show({
      variant: "error",
      title: t("principal.classes.courseModal.saveFailed"),
      description: saveErrorDescription(error, t),
    });
  }

  async function handleSubmit() {
    if (!canSubmit || chosenSubject === undefined) return;
    let targetSubjectId = chosenSubject;
    try {
      if (isNewSubject) {
        const subject = await createSubject.mutateAsync({
          code: subjectCode.trim(),
          name: subjectName.trim(),
          status: "active",
        });
        targetSubjectId = subject.id;
        setSubjectId(subject.id);
      }
      const course = await createCourse.mutateAsync({
        subjectId: targetSubjectId,
        body: {
          // The body schema repeats the parent subject; the server takes it from the path.
          subject_id: targetSubjectId,
          code: courseCode.trim(),
          name: courseName.trim(),
          status: "active",
          credit_hours: 1,
        },
      });
      show({ variant: "success", title: t("principal.classes.courseModal.created") });
      onCreated(course);
      onClose();
    } catch (error) {
      onError(error);
    }
  }

  return (
    <Modal
      open={open}
      onClose={onClose}
      title={t("principal.classes.courseModal.title")}
      description={t("principal.classes.courseModal.description")}
    >
      <Modal.Body>
        <div className="sections-form">
          <Select
            label={t("principal.classes.courseModal.subject")}
            options={subjectOptions}
            value={chosenSubject}
            onChange={setSubjectId}
            placeholder={t("principal.classes.courseModal.subjectPlaceholder")}
            disabled={subjects.isPending}
            required
          />
          {isNewSubject ? (
            <>
              <Input
                label={t("principal.classes.courseModal.subjectName")}
                value={subjectName}
                required
                maxLength={MAX_NAME_LENGTH}
                placeholder={t("principal.classes.courseModal.subjectNamePlaceholder")}
                onChange={(event) => setSubjectName(event.target.value)}
              />
              <Input
                label={t("principal.classes.courseModal.subjectCode")}
                value={subjectCode}
                required
                maxLength={MAX_CODE_LENGTH}
                placeholder={t("principal.classes.courseModal.subjectCodePlaceholder")}
                onChange={(event) => setSubjectCode(event.target.value)}
              />
            </>
          ) : null}
          <Input
            label={t("principal.classes.courseModal.courseName")}
            value={courseName}
            required
            maxLength={MAX_NAME_LENGTH}
            placeholder={t("principal.classes.courseModal.courseNamePlaceholder")}
            onChange={(event) => setCourseName(event.target.value)}
          />
          <Input
            label={t("principal.classes.courseModal.courseCode")}
            value={courseCode}
            required
            maxLength={MAX_CODE_LENGTH}
            placeholder={t("principal.classes.courseModal.courseCodePlaceholder")}
            onChange={(event) => setCourseCode(event.target.value)}
          />
        </div>
      </Modal.Body>
      <Modal.Footer>
        <Button type="button" variant="tertiary" onClick={onClose}>
          {t("principal.common.cancel")}
        </Button>
        <Button
          type="button"
          loading={saving}
          disabled={!canSubmit}
          onClick={() => void handleSubmit()}
        >
          {t("principal.classes.courseModal.add")}
        </Button>
      </Modal.Footer>
    </Modal>
  );
}
