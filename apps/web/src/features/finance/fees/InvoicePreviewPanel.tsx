import { useQuery } from "@tanstack/react-query";
import { useState } from "react";

import { useFormatters, useTranslation } from "../../../lib/i18n";

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
/** Three fixed decimals, ungrouped — the same `toFixed(3)` shape ERPNext amounts use. */
const AMOUNT_FORMAT: Intl.NumberFormatOptions = {
  minimumFractionDigits: 3,
  maximumFractionDigits: 3,
  useGrouping: false,
};

export function InvoicePreviewPanel({ components, currency }: InvoicePreviewPanelProps) {
  const { t } = useTranslation();
  const { formatNumber } = useFormatters();
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
    <section className="fee-builder__preview" aria-label={t("finance.fees.preview.title")}>
      <h2>{t("finance.fees.preview.title")}</h2>
      <p className="fee-builder__preview-note">{t("finance.fees.preview.note")}</p>

      <StudentPickerField value={student} onChange={setStudent} />

      {validComponents.length === 0 ? (
        <p className="fee-builder__preview-empty">{t("finance.fees.preview.empty")}</p>
      ) : (
        <>
          <table className="fee-builder__preview-table">
            <caption className="sf-visually-hidden">{t("finance.fees.preview.caption")}</caption>
            <thead>
              <tr>
                <th scope="col">{t("finance.common.category")}</th>
                <th scope="col">{t("finance.common.amount")}</th>
              </tr>
            </thead>
            <tbody>
              {preview.lineItems.map((line, index) => (
                <tr key={`${line.feeCategory}-${index}`}>
                  <td>{line.feeCategory}</td>
                  <td>
                    {formatNumber(line.amount, AMOUNT_FORMAT)} {currency}
                  </td>
                </tr>
              ))}
            </tbody>
            <tfoot>
              <tr>
                <th scope="row">{t("finance.fees.preview.subtotal")}</th>
                <td>
                  {formatNumber(preview.subtotal, AMOUNT_FORMAT)} {currency}
                </td>
              </tr>
              {student ? (
                <tr>
                  <th scope="row">
                    {isLoadingDiscountInputs
                      ? t("finance.fees.preview.discountLoading")
                      : t("finance.fees.preview.discount")}
                  </th>
                  <td>
                    -{formatNumber(preview.discountAmount, AMOUNT_FORMAT)} {currency}
                  </td>
                </tr>
              ) : null}
              <tr className="fee-builder__preview-total">
                <th scope="row">{t("finance.common.total")}</th>
                <td>
                  {formatNumber(preview.total, AMOUNT_FORMAT)} {currency}
                </td>
              </tr>
            </tfoot>
          </table>
          {student && !isLoadingDiscountInputs && awards.length === 0 ? (
            <p className="fee-builder__preview-note">
              {t("finance.fees.preview.noAwards", { name: student.first_name })}
            </p>
          ) : null}
        </>
      )}
    </section>
  );
}
