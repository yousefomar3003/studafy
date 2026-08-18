import { ApiError } from "@studafy/api-client";
import { Button, Input, Modal, Select, useToast } from "@studafy/ui";
import { useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";

import { EVALUATION_TYPE_LABELS } from "./labels";
import { useCreateEvaluation } from "./mutations";

import type { CreateEvaluationInput } from "./mutations";
import type { TeacherContact } from "./queries";
import type { SelectOption } from "@studafy/ui";

const TYPE_OPTIONS = Object.entries(EVALUATION_TYPE_LABELS).map(([value, label]) => ({
  value,
  label,
})) as SelectOption<CreateEvaluationInput["evaluation_type"]>[];

const DEFAULT_TYPE: CreateEvaluationInput["evaluation_type"] = "formal_observation";

export interface CreateEvaluationModalProps {
  open: boolean;
  teachers: TeacherContact[];
  onClose: () => void;
}

function apiErrorDescription(error: unknown): string | undefined {
  return error instanceof ApiError ? (error.detail ?? error.title) : undefined;
}

function todayIsoDate(): string {
  return new Date().toISOString().slice(0, 10);
}

/**
 * Starts a new evaluation cycle for a teacher, always in `draft` status. Scoring against criteria
 * templates, the narrative, and sharing with the teacher all happen afterward on
 * `EvaluationDetailPage`, which this navigates to once the record exists.
 */
export function CreateEvaluationModal({ open, teachers, onClose }: CreateEvaluationModalProps) {
  const { show } = useToast();
  const navigate = useNavigate();
  const [teacherId, setTeacherId] = useState("");
  const [evaluationType, setEvaluationType] =
    useState<CreateEvaluationInput["evaluation_type"]>(DEFAULT_TYPE);
  const [evaluatedAt, setEvaluatedAt] = useState(todayIsoDate());
  const create = useCreateEvaluation();

  const teacherOptions: SelectOption<string>[] = teachers.map((teacher) => ({
    value: teacher.id,
    label: teacher.display_name,
  }));

  useEffect(() => {
    if (!open) return;
    setTeacherId(teachers[0]?.id ?? "");
    setEvaluationType(DEFAULT_TYPE);
    setEvaluatedAt(todayIsoDate());
    // Only reseed when the modal opens — `teachers` is read fresh from the closure each time.
  }, [open]);

  function handleSubmit() {
    if (!teacherId) return;
    create.mutate(
      {
        teacher_id: teacherId,
        evaluation_type: evaluationType,
        evaluated_at: new Date(evaluatedAt).toISOString(),
      },
      {
        onSuccess: (evaluation) => {
          show({ variant: "success", title: "Evaluation started" });
          onClose();
          navigate(`/portal/principal/evaluations/${evaluation.id}`);
        },
        onError: (error) =>
          show({
            variant: "error",
            title: "Couldn't start evaluation",
            description: apiErrorDescription(error),
          }),
      },
    );
  }

  return (
    <Modal open={open} onClose={onClose} title="Start a teacher evaluation">
      <Modal.Body>
        <div className="evaluations-form">
          <Select
            label="Teacher"
            options={teacherOptions}
            value={teacherId || undefined}
            onChange={setTeacherId}
            placeholder="Select a teacher"
          />
          <Select
            label="Evaluation type"
            options={TYPE_OPTIONS}
            value={evaluationType}
            onChange={setEvaluationType}
          />
          <Input
            label="Evaluated at"
            type="date"
            value={evaluatedAt}
            onChange={(event) => setEvaluatedAt(event.target.value)}
          />
          {create.isError ? (
            <p role="alert" className="evaluations-detail__hint">
              {apiErrorDescription(create.error) ?? "The evaluation could not be started."}
            </p>
          ) : null}
        </div>
      </Modal.Body>
      <Modal.Footer>
        <Button type="button" variant="tertiary" onClick={onClose}>
          Cancel
        </Button>
        <Button
          type="button"
          variant="primary"
          loading={create.isPending}
          disabled={!teacherId}
          onClick={handleSubmit}
        >
          Start evaluation
        </Button>
      </Modal.Footer>
    </Modal>
  );
}
