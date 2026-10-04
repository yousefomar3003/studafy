import { ApiError } from "@studafy/api-client";
import { Button, Input, Modal, Select, useToast } from "@studafy/ui";
import { useState } from "react";

import { useTranslation } from "../../../lib/i18n";

import { useCreateStudent } from "./mutations";
import { createStudentSchema, fieldErrors, STATUS_LABEL_KEYS } from "./schema";

import type { CreateStudentValues } from "./schema";
import type { SelectOption } from "@studafy/ui";
import type { FormEvent } from "react";

const EMPTY_VALUES = {
  first_name: "",
  last_name: "",
  middle_name: "",
  preferred_name: "",
  email: "",
  admission_number: "",
  admission_date: "",
  date_of_birth: "",
  status: "applicant" as CreateStudentValues["status"],
};

export interface CreateStudentModalProps {
  open: boolean;
  onClose: () => void;
}

/** `POST /api/students` — creates the student profile and its linked user account (STUDENT role) in
 * one call. Guardian links are added afterward from the profile page, not here, to keep this form to
 * the fields every new student needs. */
export function CreateStudentModal({ open, onClose }: CreateStudentModalProps) {
  const { t } = useTranslation();
  const { show } = useToast();
  const createStudent = useCreateStudent();

  const statusOptions: SelectOption<CreateStudentValues["status"]>[] = (
    Object.entries(STATUS_LABEL_KEYS) as [CreateStudentValues["status"], string][]
  ).map(([value, key]) => ({ value, label: t(key) }));

  const [values, setValues] = useState(EMPTY_VALUES);
  const [errors, setErrors] = useState<Partial<Record<keyof CreateStudentValues, string>>>({});

  function setField<K extends keyof typeof values>(key: K, value: (typeof values)[K]) {
    setValues((prev) => ({ ...prev, [key]: value }));
    setErrors((prev) => ({ ...prev, [key]: undefined }));
  }

  function reset() {
    setValues(EMPTY_VALUES);
    setErrors({});
  }

  function handleClose() {
    reset();
    onClose();
  }

  function handleSubmit(event: FormEvent) {
    event.preventDefault();
    const result = createStudentSchema.safeParse(values);
    if (!result.success) {
      setErrors(fieldErrors(result.error));
      return;
    }

    createStudent.mutate(result.data, {
      onSuccess: () => {
        show({
          variant: "success",
          title: t("adminPeople.students.create.addedToast", {
            firstName: result.data.first_name,
            lastName: result.data.last_name,
          }),
        });
        handleClose();
      },
      onError: (error) => {
        show({
          variant: "error",
          title: t("adminPeople.students.create.error"),
          description: error instanceof ApiError ? (error.detail ?? error.title) : undefined,
        });
      },
    });
  }

  return (
    <Modal
      open={open}
      onClose={handleClose}
      title={t("adminPeople.students.create.title")}
      description={t("adminPeople.students.create.description")}
    >
      <form onSubmit={handleSubmit} noValidate aria-label={t("adminPeople.students.create.title")}>
        <Modal.Body>
          <Input
            label={t("adminPeople.students.form.firstName")}
            value={values.first_name}
            onChange={(e) => setField("first_name", e.target.value)}
            error={errors.first_name && t(errors.first_name)}
            required
            autoFocus
          />
          <Input
            label={t("adminPeople.students.form.middleName")}
            value={values.middle_name}
            onChange={(e) => setField("middle_name", e.target.value)}
            error={errors.middle_name && t(errors.middle_name)}
          />
          <Input
            label={t("adminPeople.students.form.lastName")}
            value={values.last_name}
            onChange={(e) => setField("last_name", e.target.value)}
            error={errors.last_name && t(errors.last_name)}
            required
          />
          <Input
            label={t("adminPeople.students.form.preferredName")}
            value={values.preferred_name}
            onChange={(e) => setField("preferred_name", e.target.value)}
            error={errors.preferred_name && t(errors.preferred_name)}
            helperText={t("adminPeople.students.create.preferredNameHelper")}
          />
          <Input
            label={t("adminPeople.students.form.email")}
            type="email"
            value={values.email}
            onChange={(e) => setField("email", e.target.value)}
            error={errors.email && t(errors.email)}
            required
            helperText={t("adminPeople.students.create.emailHelper")}
          />
          <Input
            label={t("adminPeople.students.form.dateOfBirth")}
            type="date"
            value={values.date_of_birth}
            onChange={(e) => setField("date_of_birth", e.target.value)}
            error={errors.date_of_birth && t(errors.date_of_birth)}
          />
          <Input
            label={t("adminPeople.students.form.admissionNumber")}
            value={values.admission_number}
            onChange={(e) => setField("admission_number", e.target.value)}
            error={errors.admission_number && t(errors.admission_number)}
            required
            helperText={t("adminPeople.students.create.admissionNumberHelper")}
          />
          <Input
            label={t("adminPeople.students.form.admissionDate")}
            type="date"
            value={values.admission_date}
            onChange={(e) => setField("admission_date", e.target.value)}
            error={errors.admission_date && t(errors.admission_date)}
          />
          <Select
            label={t("adminPeople.students.form.status")}
            options={statusOptions}
            value={values.status}
            onChange={(value) => setField("status", value)}
            required
          />
        </Modal.Body>
        <Modal.Footer>
          <Button type="button" variant="tertiary" onClick={handleClose}>
            {t("adminPeople.common.cancel")}
          </Button>
          <Button type="submit" loading={createStudent.isPending}>
            {t("adminPeople.students.create.submit")}
          </Button>
        </Modal.Footer>
      </form>
    </Modal>
  );
}
