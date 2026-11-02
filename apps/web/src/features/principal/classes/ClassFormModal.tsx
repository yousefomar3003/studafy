import { ApiError } from "@studafy/api-client";
import { Button, Input, Modal, Select, useToast } from "@studafy/ui";
import { useEffect, useState } from "react";

import { useTranslation } from "../../../lib/i18n";
import { useCourses, useTeacherContacts, useTerms } from "../school/queries";
import { sectionDisplayName, useSections } from "../sections/queries";

import { AddCourseModal } from "./AddCourseModal";
import { useCreateClass, useUpdateClass } from "./mutations";

import type { UpdateClassInput } from "./mutations";
import type { AcademicYear, Class } from "../../admin/timetable/queries";
import type { TFunction } from "i18next";

import "../school/principal-school.css";
import "../sections/sections.css";

export const CLASS_STATUSES = ["planned", "active", "completed", "cancelled"] as const;
type ClassStatus = (typeof CLASS_STATUSES)[number];

/** `Select` values are strings; this one stands for "no section". */
const NO_SECTION = "none";
/** Mirrors `createClassBodySchema`: a 1–50 character code. */
const MAX_CODE_LENGTH = 50;

export interface ClassFormModalProps {
  open: boolean;
  /** `null` adds a class; otherwise edits this one. */
  klass: Class | null;
  /** The years a new class can be created in, and the page's selection to start from. */
  years: readonly AcademicYear[];
  defaultYearId: string | undefined;
  defaultTermId: string | undefined;
  onClose: () => void;
}

/** The refusals a save can hit, in words; anything else falls back to the server's own detail. */
function saveErrorDescription(error: unknown, code: string, t: TFunction): string | undefined {
  if (!(error instanceof ApiError)) return undefined;
  if (error.status === 409) return t("principal.classes.form.duplicateCode", { code });
  if (error.status === 404 && /section/i.test(error.detail ?? "")) {
    return t("principal.classes.form.sectionNotInYear");
  }
  return error.detail ?? error.title;
}

/**
 * Adds a class (a course taught in one term by a lead teacher, optionally to one grade section) or
 * edits one. A class's course, year and term are fixed once it exists, so an edit shows them
 * read-only and sends only the fields that changed. The section is what puts the class's lessons on
 * that section's timetable and what a newly placed student is enrolled through.
 */
export function ClassFormModal({
  open,
  klass,
  years,
  defaultYearId,
  defaultTermId,
  onClose,
}: ClassFormModalProps) {
  const { t } = useTranslation();
  const { show } = useToast();
  const create = useCreateClass();
  const update = useUpdateClass();
  const saving = klass ? update : create;

  const [courseId, setCourseId] = useState<string>();
  const [yearId, setYearId] = useState<string>();
  const [termId, setTermId] = useState<string>();
  const [teacherId, setTeacherId] = useState<string>();
  const [sectionId, setSectionId] = useState(NO_SECTION);
  const [code, setCode] = useState("");
  const [capacity, setCapacity] = useState("");
  const [status, setStatus] = useState<ClassStatus>("planned");
  const [addingCourse, setAddingCourse] = useState(false);

  useEffect(() => {
    if (!open) return;
    setCourseId(klass?.course_id);
    setYearId(klass?.academic_year_id ?? defaultYearId);
    setTermId(klass?.term_id ?? defaultTermId);
    setTeacherId(klass?.lead_teacher_id);
    setSectionId(klass?.section_id ?? NO_SECTION);
    setCode(klass?.code ?? "");
    setCapacity(klass && klass.capacity !== null ? String(klass.capacity) : "");
    setStatus(klass?.status ?? "planned");
    setAddingCourse(false);
  }, [open, klass, defaultYearId, defaultTermId]);

  const courses = useCourses(open);
  const teachers = useTeacherContacts();
  const terms = useTerms(yearId);
  const sections = useSections(yearId);

  const trimmedCode = code.trim();
  const parsedCapacity = capacity.trim() === "" ? null : Number(capacity);
  const capacityValid =
    parsedCapacity === null || (Number.isInteger(parsedCapacity) && parsedCapacity >= 1);
  const section = sectionId === NO_SECTION ? null : sectionId;

  const changes: UpdateClassInput = klass
    ? {
        ...(teacherId !== klass.lead_teacher_id && teacherId ? { lead_teacher_id: teacherId } : {}),
        ...(trimmedCode !== klass.code ? { code: trimmedCode } : {}),
        ...(parsedCapacity !== klass.capacity ? { capacity: parsedCapacity } : {}),
        ...(status !== klass.status ? { status } : {}),
        ...(section !== klass.section_id ? { section_id: section } : {}),
      }
    : {};
  const canSubmit =
    trimmedCode !== "" &&
    capacityValid &&
    teacherId !== undefined &&
    (klass
      ? Object.keys(changes).length > 0
      : courseId !== undefined && yearId !== undefined && termId !== undefined);

  const courseOptions = [...(courses.data ?? [])]
    .sort((a, b) => a.code.localeCompare(b.code))
    .map((course) => ({
      value: course.id,
      label: t("principal.classes.form.courseOption", { code: course.code, name: course.name }),
    }));
  const teacherOptions = [...(teachers.data ?? [])]
    .sort((a, b) => a.display_name.localeCompare(b.display_name))
    .map((teacher) => ({ value: teacher.id, label: teacher.display_name }));
  const sectionOptions = [
    { value: NO_SECTION, label: t("principal.classes.section.none") },
    ...(sections.data ?? []).map((candidate) => ({
      value: candidate.id,
      label: sectionDisplayName(candidate, t),
    })),
  ];
  const statusOptions = CLASS_STATUSES.map((value) => ({
    value,
    label: t(`principal.classes.status.${value}`),
  }));

  function handleSubmit() {
    if (!canSubmit || teacherId === undefined) return;
    const onSuccess = () => {
      show({
        variant: "success",
        title: klass ? t("principal.classes.form.updated") : t("principal.classes.form.created"),
      });
      onClose();
    };
    const onError = (error: unknown) =>
      show({
        variant: "error",
        title: t("principal.classes.form.saveFailed"),
        description: saveErrorDescription(error, trimmedCode, t),
      });

    if (klass) {
      update.mutate({ classId: klass.id, body: changes }, { onSuccess, onError });
    } else if (courseId && yearId && termId) {
      create.mutate(
        {
          course_id: courseId,
          academic_year_id: yearId,
          term_id: termId,
          lead_teacher_id: teacherId,
          code: trimmedCode,
          capacity: parsedCapacity,
          status,
          section_id: section,
        },
        { onSuccess, onError },
      );
    }
  }

  return (
    <>
      <Modal
        open={open && !addingCourse}
        onClose={onClose}
        title={
          klass
            ? t("principal.classes.form.editTitle", { code: klass.code })
            : t("principal.classes.form.addTitle")
        }
        description={klass ? t("principal.classes.form.editDescription") : undefined}
      >
        <Modal.Body>
          <div className="sections-form">
            <div className="principal-school__field-action">
              <Select
                label={t("principal.classes.form.course")}
                options={courseOptions}
                value={courseId}
                onChange={setCourseId}
                placeholder={
                  courses.isSuccess && courseOptions.length === 0
                    ? t("principal.classes.form.noCourses")
                    : t("principal.classes.form.coursePlaceholder")
                }
                disabled={klass !== null || courses.isPending}
                required
              />
              {klass ? null : (
                <Button type="button" variant="tertiary" onClick={() => setAddingCourse(true)}>
                  {t("principal.classes.form.addCourse")}
                </Button>
              )}
            </div>
            <Select
              label={t("principal.classes.form.year")}
              options={years.map((year) => ({ value: year.id, label: year.name }))}
              value={yearId}
              onChange={(id) => {
                setYearId(id);
                setTermId(undefined);
                setSectionId(NO_SECTION);
              }}
              placeholder={t("principal.school.noYears")}
              disabled={klass !== null || years.length === 0}
              required
            />
            <Select
              label={t("principal.classes.form.term")}
              options={(terms.data ?? []).map((term) => ({ value: term.id, label: term.name }))}
              value={termId}
              onChange={setTermId}
              placeholder={t("principal.school.noTerms")}
              disabled={klass !== null || (terms.data ?? []).length === 0}
              required
            />
            <Select
              label={t("principal.classes.form.teacher")}
              options={teacherOptions}
              value={teacherId}
              onChange={setTeacherId}
              placeholder={t("principal.classes.form.teacherPlaceholder")}
              disabled={teachers.isPending}
              required
            />
            <Select
              label={t("principal.classes.section.label")}
              options={sectionOptions}
              value={sectionId}
              onChange={setSectionId}
              disabled={yearId === undefined || sections.isPending}
              helperText={
                sections.isSuccess && sections.data.length === 0
                  ? t("principal.classes.section.noSections")
                  : t("principal.classes.section.helper")
              }
            />
            <Input
              label={t("principal.classes.form.code")}
              value={code}
              required
              maxLength={MAX_CODE_LENGTH}
              placeholder={t("principal.classes.form.codePlaceholder")}
              onChange={(event) => setCode(event.target.value)}
            />
            <Input
              label={t("principal.classes.capacity")}
              type="number"
              min={1}
              step={1}
              value={capacity}
              onChange={(event) => setCapacity(event.target.value)}
              helperText={t("principal.classes.form.capacityHelper")}
              error={capacityValid ? undefined : t("principal.classes.form.capacityInvalid")}
            />
            <Select
              label={t("principal.classes.form.status")}
              options={statusOptions}
              value={status}
              onChange={setStatus}
              required
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
            {klass ? t("principal.classes.form.save") : t("principal.classes.form.add")}
          </Button>
        </Modal.Footer>
      </Modal>
      <AddCourseModal
        open={open && addingCourse}
        onClose={() => setAddingCourse(false)}
        onCreated={(course) => setCourseId(course.id)}
      />
    </>
  );
}
