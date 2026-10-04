import { Button, Card, CardBody, Select } from "@studafy/ui";
import { useState } from "react";

import { HelpLink } from "../../../features/help/HelpLink";
import { onboardingStepHelpPath } from "../../../features/help/onboarding-guide-links";
import { useTranslation } from "../../../lib/i18n";
import { parseEmailList, staffInviteBatchSchema, STAFF_INVITE_ROLES } from "../schema";

import type { StaffInviteBatch } from "../schema";
import type { FormEvent } from "react";

/** Translation keys for each role's option label — resolved with `t()` at render time. */
const ROLE_LABEL_KEYS: Record<(typeof STAFF_INVITE_ROLES)[number], string> = {
  ORG_ADMIN: "onboarding.setup.staff.roles.orgAdmin",
  INSTRUCTOR: "onboarding.setup.staff.roles.instructor",
  TEACHING_ASSISTANT: "onboarding.setup.staff.roles.teachingAssistant",
};

interface BatchDraft {
  role: (typeof STAFF_INVITE_ROLES)[number];
  emailsRaw: string;
}

const EMPTY_BATCH: BatchDraft = { role: "INSTRUCTOR", emailsRaw: "" };

export interface StaffInvitationsStepProps {
  onNext: (batches: StaffInviteBatch[]) => void;
  onSkip: () => void;
  submitting: boolean;
}

/**
 * Step 5: bulk-invites staff (`POST /api/invitations/bulk`, one call per role group since the
 * endpoint takes a single role per batch). Restricted to the staff-facing roles the bulk-invite API
 * accepts (it also allows STUDENT/GUEST, which belong to the student import step instead).
 */
export function StaffInvitationsStep({ onNext, onSkip, submitting }: StaffInvitationsStepProps) {
  const { t } = useTranslation();
  const [batches, setBatches] = useState<BatchDraft[]>([EMPTY_BATCH]);
  const [errors, setErrors] = useState<Record<number, string>>({});

  function updateBatch(index: number, patch: Partial<BatchDraft>) {
    setBatches((prev) => prev.map((batch, i) => (i === index ? { ...batch, ...patch } : batch)));
    setErrors((prev) => {
      const next = { ...prev };
      // eslint-disable-next-line security/detect-object-injection -- `index` is this batch's array position, not user input
      delete next[index];
      return next;
    });
  }

  function removeBatch(index: number) {
    setBatches((prev) => prev.filter((_, i) => i !== index));
  }

  function handleSubmit(event: FormEvent) {
    event.preventDefault();
    const parsed: StaffInviteBatch[] = [];
    const nextErrors: Record<number, string> = {};

    batches.forEach((batch, index) => {
      const emails = parseEmailList(batch.emailsRaw);
      const result = staffInviteBatchSchema.safeParse({ role: batch.role, emails });
      if (!result.success) {
        // eslint-disable-next-line security/detect-object-injection -- `index` is this batch's array position, not user input
        nextErrors[index] = result.error.issues[0]?.message ?? "onboarding.setup.staff.checkBatch";
        return;
      }
      parsed.push(result.data);
    });

    if (Object.keys(nextErrors).length > 0) {
      setErrors(nextErrors);
      return;
    }
    onNext(parsed);
  }

  return (
    <Card>
      <CardBody>
        <form onSubmit={handleSubmit} noValidate aria-label={t("onboarding.setup.staff.title")}>
          <h2>{t("onboarding.setup.staff.title")}</h2>
          <p>{t("onboarding.setup.staff.description")}</p>
          <p>
            <HelpLink to={onboardingStepHelpPath("staff")}>
              {t("onboarding.setup.needHelp")}
            </HelpLink>
          </p>

          {batches.map((batch, index) => (
            <fieldset key={index}>
              <legend>{t("onboarding.setup.staff.batch", { number: index + 1 })}</legend>
              {/* eslint-disable-next-line security/detect-object-injection -- `index` is this batch's array position, not user input */}
              {errors[index] ? (
                <p role="alert">
                  {t(
                    // eslint-disable-next-line security/detect-object-injection -- `index` is this batch's array position, not user input
                    errors[index],
                  )}
                </p>
              ) : null}

              <Select
                label={t("onboarding.setup.staff.role")}
                options={STAFF_INVITE_ROLES.map((role) => ({
                  value: role,
                  // eslint-disable-next-line security/detect-object-injection -- `role` comes from iterating this module's own fixed `STAFF_INVITE_ROLES` tuple, not user input
                  label: t(ROLE_LABEL_KEYS[role]),
                }))}
                value={batch.role}
                onChange={(value) => updateBatch(index, { role: value as BatchDraft["role"] })}
                required
              />

              <label htmlFor={`batch-emails-${index}`}>{t("onboarding.setup.staff.emails")}</label>
              <textarea
                id={`batch-emails-${index}`}
                value={batch.emailsRaw}
                onChange={(e) => updateBatch(index, { emailsRaw: e.target.value })}
                rows={4}
              />

              {batches.length > 1 ? (
                <Button type="button" variant="tertiary" onClick={() => removeBatch(index)}>
                  {t("onboarding.setup.staff.removeBatch")}
                </Button>
              ) : null}
            </fieldset>
          ))}

          <Button
            type="button"
            variant="secondary"
            onClick={() => setBatches((prev) => [...prev, { ...EMPTY_BATCH }])}
          >
            {t("onboarding.setup.staff.addBatch")}
          </Button>

          <Button type="submit" loading={submitting}>
            {t("onboarding.setup.staff.submit")}
          </Button>
          <Button type="button" variant="tertiary" onClick={onSkip} disabled={submitting}>
            {t("onboarding.setup.skipForNow")}
          </Button>
        </form>
      </CardBody>
    </Card>
  );
}
