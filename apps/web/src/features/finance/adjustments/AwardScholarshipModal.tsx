import { ApiError } from "@studafy/api-client";
import { Button, Modal, Select, useToast } from "@studafy/ui";
import { useId, useState } from "react";

import { useTranslation } from "../../../lib/i18n";
import { FinanceStudentPicker } from "../students/FinanceStudentPicker";

import { discountSummary, useRequestAward } from "./scholarships-api";

import type { Scholarship } from "./scholarships-api";
import type { StudentIdentity } from "../students/FinanceStudentPicker";
import type { FormEvent } from "react";

export interface AwardScholarshipModalProps {
  open: boolean;
  scholarships: readonly Scholarship[];
  onClose: () => void;
}

/**
 * Finance's request to give one student a scholarship. It creates a `pending_approval` award; the
 * school admin approves it before any invoice is discounted.
 */
export function AwardScholarshipModal({ open, scholarships, onClose }: AwardScholarshipModalProps) {
  const { t } = useTranslation();
  const { show } = useToast();
  const request = useRequestAward();
  const notesId = useId();
  const active = scholarships.filter((s) => s.is_active);
  const [scholarshipId, setScholarshipId] = useState("");
  const [student, setStudent] = useState<StudentIdentity | null>(null);
  const [notes, setNotes] = useState("");
  const [submitted, setSubmitted] = useState(false);

  const scholarshipError =
    submitted && !scholarshipId
      ? t("financeReports.adjustments.scholarships.award.scholarshipRequired")
      : undefined;
  const studentError =
    submitted && !student
      ? t("financeReports.adjustments.scholarships.award.studentRequired")
      : undefined;

  function handleSubmit(event: FormEvent) {
    event.preventDefault();
    setSubmitted(true);
    if (!scholarshipId || !student) return;
    request.mutate(
      { scholarship_id: scholarshipId, student_id: student.id, notes: notes.trim() || undefined },
      {
        onSuccess: () => {
          show({
            variant: "success",
            title: t("financeReports.adjustments.scholarships.award.requestedToast"),
          });
          onClose();
        },
        onError: (error) =>
          show({
            variant: "error",
            title: t("financeReports.adjustments.scholarships.award.requestError"),
            description: error instanceof ApiError ? (error.detail ?? error.title) : undefined,
          }),
      },
    );
  }

  return (
    <Modal
      open={open}
      onClose={onClose}
      title={t("financeReports.adjustments.scholarships.award.title")}
      description={t("financeReports.adjustments.scholarships.award.description")}
    >
      <form onSubmit={handleSubmit} noValidate>
        <Modal.Body>
          <div className="adjustments-form">
            <Select
              label={t("financeReports.adjustments.scholarships.award.scholarship")}
              placeholder={t("financeReports.adjustments.scholarships.award.selectScholarship")}
              options={active.map((s) => ({
                value: s.id,
                label: `${s.name} — ${discountSummary(t, s)}`,
              }))}
              value={scholarshipId || undefined}
              onChange={setScholarshipId}
              error={scholarshipError}
              required
            />

            <FinanceStudentPicker
              label={t("financeReports.adjustments.scholarships.award.student")}
              helperText={t("financeReports.adjustments.scholarships.award.studentHelper")}
              error={studentError}
              required
              selected={student ? [student] : []}
              onChange={(next) => setStudent(next[0] ?? null)}
            />

            <div className="sf-field">
              <label className="sf-field__label" htmlFor={notesId}>
                {t("financeReports.adjustments.scholarships.award.notes")}
              </label>
              <div className="sf-input adjustments-reason-input">
                <textarea
                  id={notesId}
                  className="sf-input__control"
                  rows={3}
                  maxLength={1000}
                  value={notes}
                  onChange={(e) => setNotes(e.target.value)}
                />
              </div>
            </div>
          </div>
        </Modal.Body>
        <Modal.Footer>
          <Button type="button" variant="tertiary" onClick={onClose}>
            {t("financeReports.adjustments.common.cancel")}
          </Button>
          <Button type="submit" loading={request.isPending}>
            {t("financeReports.adjustments.scholarships.award.submit")}
          </Button>
        </Modal.Footer>
      </form>
    </Modal>
  );
}
