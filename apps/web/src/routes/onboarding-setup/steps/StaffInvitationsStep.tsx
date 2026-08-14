import { Button, Card, CardBody, Select } from "@studafy/ui";
import { useState } from "react";

import { parseEmailList, staffInviteBatchSchema, STAFF_INVITE_ROLES } from "../schema";

import type { StaffInviteBatch } from "../schema";
import type { FormEvent } from "react";

const ROLE_LABELS: Record<(typeof STAFF_INVITE_ROLES)[number], string> = {
  ORG_ADMIN: "Admin",
  INSTRUCTOR: "Teacher",
  TEACHING_ASSISTANT: "Teaching assistant",
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
        nextErrors[index] = result.error.issues[0]?.message ?? "Check this batch.";
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
        <form onSubmit={handleSubmit} noValidate aria-label="Staff invitations">
          <h2>Staff invitations</h2>
          <p>Invite staff by role. Paste one email per line, or separate them with commas.</p>

          {batches.map((batch, index) => (
            <fieldset key={index}>
              <legend>Batch {index + 1}</legend>
              {/* eslint-disable-next-line security/detect-object-injection -- `index` is this batch's array position, not user input */}
              {errors[index] ? <p role="alert">{errors[index]}</p> : null}

              <Select
                label="Role"
                options={STAFF_INVITE_ROLES.map((role) => ({
                  value: role,
                  // eslint-disable-next-line security/detect-object-injection -- `role` comes from iterating this module's own fixed `STAFF_INVITE_ROLES` tuple, not user input
                  label: ROLE_LABELS[role],
                }))}
                value={batch.role}
                onChange={(value) => updateBatch(index, { role: value as BatchDraft["role"] })}
                required
              />

              <label htmlFor={`batch-emails-${index}`}>Emails</label>
              <textarea
                id={`batch-emails-${index}`}
                value={batch.emailsRaw}
                onChange={(e) => updateBatch(index, { emailsRaw: e.target.value })}
                rows={4}
              />

              {batches.length > 1 ? (
                <Button type="button" variant="tertiary" onClick={() => removeBatch(index)}>
                  Remove batch
                </Button>
              ) : null}
            </fieldset>
          ))}

          <Button
            type="button"
            variant="secondary"
            onClick={() => setBatches((prev) => [...prev, { ...EMPTY_BATCH }])}
          >
            Add another role
          </Button>

          <Button type="submit" loading={submitting}>
            Send invitations
          </Button>
          <Button type="button" variant="tertiary" onClick={onSkip} disabled={submitting}>
            Skip for now
          </Button>
        </form>
      </CardBody>
    </Card>
  );
}
