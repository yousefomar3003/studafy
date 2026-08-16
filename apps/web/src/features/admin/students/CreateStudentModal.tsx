import { ApiError } from "@studafy/api-client";
import { Button, Input, Modal, Select, useToast } from "@studafy/ui";
import { useState } from "react";

import { useCreateStudent } from "./mutations";
import { createStudentSchema, fieldErrors, STATUS_LABELS } from "./schema";

import type { CreateStudentValues } from "./schema";
import type { SelectOption } from "@studafy/ui";
import type { FormEvent } from "react";

const STATUS_OPTIONS: SelectOption<CreateStudentValues["status"]>[] = (
  Object.entries(STATUS_LABELS) as [CreateStudentValues["status"], string][]
).map(([value, label]) => ({ value, label }));

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
  const { show } = useToast();
  const createStudent = useCreateStudent();

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
          title: `Added ${result.data.first_name} ${result.data.last_name}`,
        });
        handleClose();
      },
      onError: (error) => {
        show({
          variant: "error",
          title: "Couldn't create student",
          description: error instanceof ApiError ? (error.detail ?? error.title) : undefined,
        });
      },
    });
  }

  return (
    <Modal
      open={open}
      onClose={handleClose}
      title="New student"
      description="Create a student profile and linked account."
    >
      <form onSubmit={handleSubmit} noValidate aria-label="New student">
        <Modal.Body>
          <Input
            label="First name"
            value={values.first_name}
            onChange={(e) => setField("first_name", e.target.value)}
            error={errors.first_name}
            required
            autoFocus
          />
          <Input
            label="Middle name"
            value={values.middle_name}
            onChange={(e) => setField("middle_name", e.target.value)}
            error={errors.middle_name}
          />
          <Input
            label="Last name"
            value={values.last_name}
            onChange={(e) => setField("last_name", e.target.value)}
            error={errors.last_name}
            required
          />
          <Input
            label="Preferred name"
            value={values.preferred_name}
            onChange={(e) => setField("preferred_name", e.target.value)}
            error={errors.preferred_name}
            helperText="Optional — shown instead of the legal name where it fits."
          />
          <Input
            label="Email"
            type="email"
            value={values.email}
            onChange={(e) => setField("email", e.target.value)}
            error={errors.email}
            required
            helperText="Used to create the student's linked account."
          />
          <Input
            label="Date of birth"
            type="date"
            value={values.date_of_birth}
            onChange={(e) => setField("date_of_birth", e.target.value)}
            error={errors.date_of_birth}
          />
          <Input
            label="Admission number"
            value={values.admission_number}
            onChange={(e) => setField("admission_number", e.target.value)}
            error={errors.admission_number}
            required
            helperText="Must be unique within this school."
          />
          <Input
            label="Admission date"
            type="date"
            value={values.admission_date}
            onChange={(e) => setField("admission_date", e.target.value)}
            error={errors.admission_date}
          />
          <Select
            label="Status"
            options={STATUS_OPTIONS}
            value={values.status}
            onChange={(value) => setField("status", value)}
            required
          />
        </Modal.Body>
        <Modal.Footer>
          <Button type="button" variant="tertiary" onClick={handleClose}>
            Cancel
          </Button>
          <Button type="submit" loading={createStudent.isPending}>
            Create student
          </Button>
        </Modal.Footer>
      </form>
    </Modal>
  );
}
