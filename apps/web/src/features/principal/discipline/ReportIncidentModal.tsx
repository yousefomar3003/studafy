import { ApiError } from "@studafy/api-client";
import { Button, Input, Modal, Select, useToast } from "@studafy/ui";
import { useEffect, useId, useState } from "react";
import { useNavigate } from "react-router-dom";

import { useTranslation } from "../../../lib/i18n";
import { SearchList, studentName } from "../../admin/people-links/LinkPickers";
import { searchStudents, studentSearchQueryKey } from "../../admin/people-links/queries";

import { DISCIPLINE_SEVERITY_LABEL_KEYS, DISCIPLINE_TYPE_LABEL_KEYS } from "./labels";
import { useCreateIncident } from "./mutations";

import type { CreateIncidentInput } from "./mutations";
import type { StudentProfile } from "../../admin/people-links/queries";

import "../../admin/people-links/people-links.css";
import "../sections/sections.css";

const TITLE_MAX_LENGTH = 200;
const DESCRIPTION_MAX_LENGTH = 5000;

type IncidentType = CreateIncidentInput["incident_type"];
type Severity = CreateIncidentInput["severity"];

/** Now, as a `datetime-local` value (the browser's local time, minutes precision). */
function nowLocal(): string {
  const now = new Date();
  now.setSeconds(0, 0);
  return new Date(now.getTime() - now.getTimezoneOffset() * 60_000).toISOString().slice(0, 16);
}

export interface ReportIncidentModalProps {
  open: boolean;
  onClose: () => void;
}

/**
 * Reports a discipline incident from the principal's side (`discipline:incident:create`): the
 * student, what kind of incident and how serious, when it happened and what happened. The student
 * is searched and picked by staff, never guessed. On success it opens the new incident, where
 * actions are recorded and it is resolved.
 */
export function ReportIncidentModal({ open, onClose }: ReportIncidentModalProps) {
  const { t } = useTranslation();
  const { show } = useToast();
  const navigate = useNavigate();
  const create = useCreateIncident();
  const descriptionId = useId();
  const [student, setStudent] = useState<StudentProfile | null>(null);
  const [type, setType] = useState<IncidentType>("behavioral");
  const [severity, setSeverity] = useState<Severity>("minor");
  const [title, setTitle] = useState("");
  const [description, setDescription] = useState("");
  const [incidentAt, setIncidentAt] = useState("");

  useEffect(() => {
    if (!open) return;
    setStudent(null);
    setType("behavioral");
    setSeverity("minor");
    setTitle("");
    setDescription("");
    setIncidentAt(nowLocal());
  }, [open]);

  const canSubmit = student !== null && title.trim() !== "" && incidentAt !== "";

  function handleSubmit() {
    if (!student || !canSubmit) return;
    create.mutate(
      {
        student_id: student.id,
        incident_type: type,
        severity,
        title: title.trim(),
        description: description.trim() || undefined,
        incident_at: new Date(incidentAt).toISOString(),
      },
      {
        onSuccess: (incident) => {
          show({ variant: "success", title: t("principal.discipline.report.created") });
          onClose();
          navigate(`/portal/principal/discipline/${incident.id}`);
        },
        onError: (error) =>
          show({
            variant: "error",
            title: t("principal.discipline.report.failed"),
            description: error instanceof ApiError ? (error.detail ?? error.title) : undefined,
          }),
      },
    );
  }

  return (
    <Modal open={open} onClose={onClose} title={t("principal.discipline.report.title")}>
      <Modal.Body>
        <div className="sections-form">
          {student ? (
            <div className="people-links__row-head">
              <div>
                <span className="sf-field__label">{t("principal.discipline.report.student")}</span>
                <p>
                  <strong>{studentName(student)}</strong> · {student.admission_number}
                </p>
              </div>
              <Button type="button" variant="tertiary" onClick={() => setStudent(null)}>
                {t("principal.discipline.report.changeStudent")}
              </Button>
            </div>
          ) : (
            <SearchList<StudentProfile>
              label={t("principal.discipline.report.student")}
              placeholder={t("principal.discipline.report.studentPlaceholder")}
              noMatches={t("principal.discipline.report.noMatches")}
              queryKeyFor={studentSearchQueryKey}
              search={searchStudents}
              getKey={(candidate) => candidate.id}
              renderItem={(candidate) => (
                <>
                  <strong>{studentName(candidate)}</strong>
                  <span>{candidate.admission_number}</span>
                </>
              )}
              onPick={setStudent}
            />
          )}
          <Select
            label={t("principal.discipline.report.type")}
            options={(Object.keys(DISCIPLINE_TYPE_LABEL_KEYS) as IncidentType[]).map((value) => ({
              value,
              label: t(DISCIPLINE_TYPE_LABEL_KEYS[value]),
            }))}
            value={type}
            onChange={(value) => setType(value as IncidentType)}
          />
          <Select
            label={t("principal.discipline.report.severity")}
            options={(Object.keys(DISCIPLINE_SEVERITY_LABEL_KEYS) as Severity[]).map((value) => ({
              value,
              label: t(DISCIPLINE_SEVERITY_LABEL_KEYS[value]),
            }))}
            value={severity}
            onChange={(value) => setSeverity(value as Severity)}
          />
          <Input
            label={t("principal.discipline.report.titleLabel")}
            value={title}
            required
            maxLength={TITLE_MAX_LENGTH}
            placeholder={t("principal.discipline.report.titlePlaceholder")}
            onChange={(event) => setTitle(event.target.value)}
          />
          <Input
            label={t("principal.discipline.report.when")}
            type="datetime-local"
            value={incidentAt}
            max={nowLocal()}
            required
            onChange={(event) => setIncidentAt(event.target.value)}
          />
          <div className="sf-field">
            <label className="sf-field__label" htmlFor={descriptionId}>
              {t("principal.discipline.report.description")}
            </label>
            <div className="sf-input">
              <textarea
                id={descriptionId}
                className="sf-input__control"
                rows={4}
                maxLength={DESCRIPTION_MAX_LENGTH}
                value={description}
                onChange={(event) => setDescription(event.target.value)}
              />
            </div>
          </div>
        </div>
      </Modal.Body>
      <Modal.Footer>
        <Button type="button" variant="tertiary" onClick={onClose}>
          {t("principal.common.cancel")}
        </Button>
        <Button
          type="button"
          loading={create.isPending}
          disabled={!canSubmit}
          onClick={handleSubmit}
        >
          {t("principal.discipline.report.submit")}
        </Button>
      </Modal.Footer>
    </Modal>
  );
}
