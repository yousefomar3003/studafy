import { ApiError } from "@studafy/api-client";
import { Button, Card, Select } from "@studafy/ui";
import { useQuery } from "@tanstack/react-query";
import { useState } from "react";
import { Link } from "react-router-dom";

import { fetchScholarshipDiscounts, SCHOLARSHIP_DISCOUNTS_KEY } from "../fees/queries";

import { AdjustmentConfirmDialog } from "./AdjustmentConfirmDialog";
import { discountEffectLine } from "./labels";
import { useCreateAward } from "./mutations";
import { StudentPickerField } from "./StudentPickerField";

import "./adjustments.css";

import type { Award } from "./queries";
import type { StudentProfile } from "../fees/queries";
import type { SelectOption } from "@studafy/ui";
import type { FormEvent } from "react";

function apiErrorMessage(error: unknown, fallback: string): string {
  if (!(error instanceof ApiError)) return fallback;
  return error.detail ?? error.title;
}

/**
 * Scholarship award, maker step (`/portal/finance/adjustments/scholarships/new`), gated by
 * `billing:update`. Creates a `pending` award; a different user must confirm it from
 * `ScholarshipAwardsListPage` before it applies to any invoice ERPNext generates afterward — this
 * page only ever produces the maker half of that pair (see `createAward`'s doc comment in the API).
 */
export default function NewScholarshipAwardPage() {
  const [award, setAward] = useState<Award | null>(null);

  return (
    <>
      <p className="adjustments-form__back">
        <Link to="/portal/finance/adjustments/scholarships">&larr; Back to scholarship awards</Link>
      </p>
      <h1>Award a scholarship or discount</h1>

      {award ? (
        <AwardCreated award={award} onReset={() => setAward(null)} />
      ) : (
        <AwardForm onCreated={setAward} />
      )}
    </>
  );
}

// ---------------------------------------------------------------------------
// Form
// ---------------------------------------------------------------------------

interface AwardFormProps {
  onCreated: (award: Award) => void;
}

function AwardForm({ onCreated }: AwardFormProps) {
  const createAward = useCreateAward();
  const [student, setStudent] = useState<StudentProfile | null>(null);
  const [discountId, setDiscountId] = useState("");
  const [confirmOpen, setConfirmOpen] = useState(false);

  const discountsQuery = useQuery({
    queryKey: SCHOLARSHIP_DISCOUNTS_KEY,
    queryFn: fetchScholarshipDiscounts,
  });
  const discounts = discountsQuery.data ?? [];
  const discountOptions: SelectOption<string>[] = [
    {
      value: "",
      label: discountsQuery.isPending ? "Loading…" : "Select a scholarship or discount",
    },
    ...discounts.map((discount) => ({ value: discount.id, label: discount.title })),
  ];
  const selectedDiscount = discounts.find((discount) => discount.id === discountId) ?? null;

  const canSubmit = student !== null && selectedDiscount !== null;

  function handleSubmit(event: FormEvent) {
    event.preventDefault();
    if (!canSubmit) return;
    setConfirmOpen(true);
  }

  function handleConfirm() {
    if (!student || !selectedDiscount) return;
    createAward.mutate(
      { student_id: student.id, scholarship_discount_id: selectedDiscount.id },
      { onSuccess: (created) => onCreated(created) },
    );
  }

  return (
    <>
      <Card as="section" aria-label="Scholarship award form">
        <Card.Body>
          <form onSubmit={handleSubmit} className="adjustments-form">
            <StudentPickerField value={student} onChange={setStudent} />

            <Select
              label="Scholarship / discount"
              options={discountOptions}
              value={discountId}
              onChange={setDiscountId}
              disabled={!student}
            />

            {selectedDiscount ? (
              <p className="adjustments-form__math" role="status">
                {discountEffectLine(selectedDiscount)}
              </p>
            ) : null}

            <div className="adjustments-form__actions">
              <Button type="submit" disabled={!canSubmit}>
                Review award
              </Button>
            </div>
          </form>
        </Card.Body>
      </Card>

      <AdjustmentConfirmDialog
        open={confirmOpen}
        title="Award scholarship?"
        description="This creates a pending award. A different user must confirm it before it applies to any invoice."
        confirmLabel="Create award"
        loading={createAward.isPending}
        error={
          createAward.isError
            ? apiErrorMessage(createAward.error, "The award could not be created.")
            : undefined
        }
        onConfirm={handleConfirm}
        onClose={() => setConfirmOpen(false)}
      >
        {student && selectedDiscount ? (
          <dl className="adjustments-effect">
            <div>
              <dt>Student</dt>
              <dd>
                {student.first_name} {student.last_name} &middot; {student.admission_number}
              </dd>
            </div>
            <div>
              <dt>Scholarship / discount</dt>
              <dd>{selectedDiscount.title}</dd>
            </div>
            <div>
              <dt>Effect</dt>
              <dd>{discountEffectLine(selectedDiscount)}</dd>
            </div>
          </dl>
        ) : null}
      </AdjustmentConfirmDialog>
    </>
  );
}

// ---------------------------------------------------------------------------
// Success
// ---------------------------------------------------------------------------

interface AwardCreatedProps {
  award: Award;
  onReset: () => void;
}

function AwardCreated({ award, onReset }: AwardCreatedProps) {
  return (
    <Card as="section" aria-label="Award created">
      <Card.Body>
        <p role="status" className="adjustments-success__headline">
          Award created &mdash; {award.scholarship_discount_title}
        </p>
        <p>
          Pending confirmation from a different user. It will not apply to any invoice until
          confirmed.
        </p>

        <div className="adjustments-success__actions">
          <Button type="button" variant="secondary" onClick={onReset}>
            Award another scholarship
          </Button>
          <Link to="/portal/finance/adjustments/scholarships">View scholarship awards</Link>
        </div>
      </Card.Body>
    </Card>
  );
}
