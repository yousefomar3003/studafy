import { useQuery } from "@tanstack/react-query";

import { api } from "../../../lib/api";
import { useFormatters, useTranslation } from "../../../lib/i18n";

import { buildInvoicePreview, scholarshipDiscount } from "./preview";

import type { FeeComponentDraft, PreviewScholarship } from "./preview";
import type { ScholarshipAward } from "../adjustments/scholarships-api";
import type { StudentIdentity } from "../students/FinanceStudentPicker";

export interface InvoicePreviewPanelProps {
  components: FeeComponentDraft[];
  currency: string;
  /** The structure's student, when it has one: their approved scholarships come off the preview. */
  student: StudentIdentity | null;
}

/**
 * The invoice this structure produces, computed the same way `generateInvoice` computes a real one
 * (see `preview.ts`'s doc comment for why this is a client-side simulation rather than a call to a
 * preview endpoint — none exists). For a structure with a student, that student's approved awards of
 * active scholarships come off it, exactly as the billing worker will take them off the real one.
 */
/** Three fixed decimals, ungrouped — the same `toFixed(3)` shape ERPNext amounts use. */
const AMOUNT_FORMAT: Intl.NumberFormatOptions = {
  minimumFractionDigits: 3,
  maximumFractionDigits: 3,
  useGrouping: false,
};

export function InvoicePreviewPanel({ components, currency, student }: InvoicePreviewPanelProps) {
  const { t } = useTranslation();
  const { formatNumber } = useFormatters();
  const validComponents = components.filter(
    (component) => component.fee_category.trim() !== "" && Number.isFinite(component.amount),
  );
  const preview = buildInvoicePreview(validComponents);

  const awards = useQuery({
    queryKey: ["finance", "scholarships", "awards", "approved", student?.id],
    queryFn: async () => {
      const { data } = await api.GET("/api/finance/scholarship-awards", {
        params: { query: { student_id: student!.id, status: "approved", limit: 100, offset: 0 } },
      });
      return ((data?.awards ?? []) as ScholarshipAward[]).filter(
        (award) => award.scholarship_is_active,
      );
    },
    enabled: student !== null,
  });
  const scholarships: readonly PreviewScholarship[] = awards.data ?? [];
  const discount = student ? scholarshipDiscount(validComponents, scholarships, currency) : 0;

  return (
    <section className="fee-builder__preview" aria-label={t("finance.fees.preview.title")}>
      <h2>{t("finance.fees.preview.title")}</h2>
      <p className="fee-builder__preview-note">{t("finance.fees.preview.note")}</p>

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
              <tr className="fee-builder__preview-total">
                <th scope="row">{t("finance.common.total")}</th>
                <td>
                  {formatNumber(preview.total, AMOUNT_FORMAT)} {currency}
                </td>
              </tr>
              {student && awards.data ? (
                <>
                  <tr>
                    <th scope="row">
                      {scholarships.length > 0
                        ? t("finance.fees.preview.scholarships", {
                            names: awards.data.map((a) => a.scholarship_name).join(", "),
                          })
                        : t("finance.fees.preview.noScholarships")}
                    </th>
                    <td>
                      −{formatNumber(discount, AMOUNT_FORMAT)} {currency}
                    </td>
                  </tr>
                  <tr className="fee-builder__preview-total">
                    <th scope="row">
                      {t("finance.fees.preview.studentTotal", { name: student.name })}
                    </th>
                    <td>
                      {formatNumber(preview.total - discount, AMOUNT_FORMAT)} {currency}
                    </td>
                  </tr>
                </>
              ) : null}
            </tfoot>
          </table>
        </>
      )}
    </section>
  );
}
