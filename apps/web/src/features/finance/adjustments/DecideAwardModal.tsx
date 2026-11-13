import { ApiError } from "@studafy/api-client";
import { Button, Modal, useToast } from "@studafy/ui";
import { useId, useState } from "react";

import { useTranslation } from "../../../lib/i18n";

import { discountSummary, useDecideAward } from "./scholarships-api";

import type { AwardDecision, ScholarshipAward } from "./scholarships-api";
import type { FormEvent } from "react";

export interface DecideAwardModalProps {
  award: ScholarshipAward | null;
  decision: AwardDecision;
  onClose: () => void;
}

/**
 * The school admin's decision on one award: approve, reject (a reason is required — the API's
 * `rejectAwardBodySchema` demands it, and finance sees it) or revoke. Remount with
 * `key={award?.id ?? "closed"}` so notes typed for one award never carry over to the next.
 */
export function DecideAwardModal({ award, decision, onClose }: DecideAwardModalProps) {
  const { t } = useTranslation();
  const { show } = useToast();
  const decide = useDecideAward();
  const [notes, setNotes] = useState("");
  const [touched, setTouched] = useState(false);
  const notesId = useId();
  const errorId = `${notesId}-error`;
  const notesRequired = decision === "reject";
  const invalid = notesRequired && touched && notes.trim() === "";
  const keyPrefix = `financeReports.adjustments.scholarships.decide.${decision}`;

  function handleSubmit(event: FormEvent) {
    event.preventDefault();
    setTouched(true);
    if (!award || (notesRequired && notes.trim() === "")) return;
    decide.mutate(
      { awardId: award.id, decision, notes: notes.trim() || undefined },
      {
        onSuccess: () => {
          show({ variant: "success", title: t(`${keyPrefix}.toast`) });
          onClose();
        },
        onError: (error) =>
          show({
            variant: "error",
            title: t(`${keyPrefix}.error`),
            description: error instanceof ApiError ? (error.detail ?? error.title) : undefined,
          }),
      },
    );
  }

  return (
    <Modal
      open={award !== null}
      onClose={onClose}
      title={t(`${keyPrefix}.title`)}
      description={
        award
          ? t(`${keyPrefix}.description`, {
              student: award.student_name,
              scholarship: award.scholarship_name,
            })
          : undefined
      }
    >
      <form onSubmit={handleSubmit} noValidate>
        <Modal.Body>
          {award ? (
            <dl className="adjustments-effect">
              <div>
                <dt>{t("financeReports.adjustments.scholarships.columns.student")}</dt>
                <dd>{award.student_name}</dd>
              </div>
              <div>
                <dt>{t("financeReports.adjustments.scholarships.columns.discount")}</dt>
                <dd>{discountSummary(t, award)}</dd>
              </div>
              {award.notes ? (
                <div>
                  <dt>{t("financeReports.adjustments.scholarships.columns.notes")}</dt>
                  <dd>{award.notes}</dd>
                </div>
              ) : null}
            </dl>
          ) : null}
          <div className="sf-field">
            <label className="sf-field__label" htmlFor={notesId}>
              {t(
                notesRequired
                  ? "financeReports.adjustments.scholarships.decide.reason"
                  : "financeReports.adjustments.scholarships.decide.notes",
              )}
              {notesRequired ? (
                <span className="sf-field__required" aria-hidden="true">
                  *
                </span>
              ) : null}
            </label>
            <div className="sf-input adjustments-reason-input">
              <textarea
                id={notesId}
                className="sf-input__control"
                rows={3}
                maxLength={1000}
                required={notesRequired}
                value={notes}
                onChange={(e) => setNotes(e.target.value)}
                aria-invalid={invalid ? true : undefined}
                aria-describedby={invalid ? errorId : undefined}
              />
            </div>
            {invalid ? (
              <p className="sf-field__error" id={errorId} role="alert">
                {t("financeReports.adjustments.scholarships.decide.reasonRequired")}
              </p>
            ) : null}
          </div>
        </Modal.Body>
        <Modal.Footer>
          <Button type="button" variant="tertiary" onClick={onClose}>
            {t("financeReports.adjustments.common.cancel")}
          </Button>
          <Button type="submit" variant="primary" loading={decide.isPending}>
            {t(`${keyPrefix}.confirm`)}
          </Button>
        </Modal.Footer>
      </form>
    </Modal>
  );
}
