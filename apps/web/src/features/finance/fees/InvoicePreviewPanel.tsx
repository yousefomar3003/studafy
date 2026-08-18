import { useQuery } from "@tanstack/react-query";
import { useState } from "react";

import { buildInvoicePreview } from "./preview";
import {
  confirmedAwardsQueryKey,
  fetchConfirmedAwards,
  fetchScholarshipDiscounts,
  SCHOLARSHIP_DISCOUNTS_KEY,
} from "./queries";
import { StudentPickerField } from "./StudentPickerField";

import type { FeeComponentDraft } from "./preview";
import type { StudentProfile } from "./queries";

export interface InvoicePreviewPanelProps {
  components: FeeComponentDraft[];
  currency: string;
}

/**
 * Estimates the invoice a sample student would receive from this structure, computed the same way
 * `generateInvoice` computes a real one (see `preview.ts`'s doc comment for why this is a client-side
 * simulation rather than a call to a preview endpoint — none exists). Selecting a student is optional:
 * with none selected this just totals the components with no discounts applied.
 */
export function InvoicePreviewPanel({ components, currency }: InvoicePreviewPanelProps) {
  const [student, setStudent] = useState<StudentProfile | null>(null);

  const discountsQuery = useQuery({
    queryKey: SCHOLARSHIP_DISCOUNTS_KEY,
    queryFn: fetchScholarshipDiscounts,
  });
  const awardsQuery = useQuery({
    queryKey: confirmedAwardsQueryKey(student?.id ?? ""),
    queryFn: () => fetchConfirmedAwards(student!.id),
    enabled: student !== null,
  });

  const validComponents = components.filter(
    (component) => component.fee_category.trim() !== "" && Number.isFinite(component.amount),
  );
  const awards = student ? (awardsQuery.data ?? []) : [];
  const preview = buildInvoicePreview(validComponents, awards, discountsQuery.data ?? []);
  const isLoadingDiscountInputs =
    student !== null && (awardsQuery.isPending || discountsQuery.isPending);

  return (
    <section className="fee-builder__preview" aria-label="Invoice preview">
      <h2>Invoice preview</h2>
      <p className="fee-builder__preview-note">
        Estimated from the components below, computed the same way invoice generation computes a
        real one. ERPNext's own total is authoritative once an invoice actually exists.
      </p>

      <StudentPickerField value={student} onChange={setStudent} />

      {validComponents.length === 0 ? (
        <p className="fee-builder__preview-empty">Add at least one component to see a preview.</p>
      ) : (
        <>
          <table className="fee-builder__preview-table">
            <caption className="sf-visually-hidden">Estimated invoice line items</caption>
            <thead>
              <tr>
                <th scope="col">Category</th>
                <th scope="col">Amount</th>
              </tr>
            </thead>
            <tbody>
              {preview.lineItems.map((line, index) => (
                <tr key={`${line.feeCategory}-${index}`}>
                  <td>{line.feeCategory}</td>
                  <td>
                    {line.amount.toFixed(3)} {currency}
                  </td>
                </tr>
              ))}
            </tbody>
            <tfoot>
              <tr>
                <th scope="row">Subtotal</th>
                <td>
                  {preview.subtotal.toFixed(3)} {currency}
                </td>
              </tr>
              {student ? (
                <tr>
                  <th scope="row">
                    {isLoadingDiscountInputs ? "Discount (loading…)" : "Discount"}
                  </th>
                  <td>
                    -{preview.discountAmount.toFixed(3)} {currency}
                  </td>
                </tr>
              ) : null}
              <tr className="fee-builder__preview-total">
                <th scope="row">Total</th>
                <td>
                  {preview.total.toFixed(3)} {currency}
                </td>
              </tr>
            </tfoot>
          </table>
          {student && !isLoadingDiscountInputs && awards.length === 0 ? (
            <p className="fee-builder__preview-note">
              {student.first_name} has no confirmed scholarship or discount awards, so no discount
              applies.
            </p>
          ) : null}
        </>
      )}
    </section>
  );
}
