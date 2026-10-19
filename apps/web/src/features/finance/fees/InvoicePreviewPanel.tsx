import { useFormatters, useTranslation } from "../../../lib/i18n";

import { buildInvoicePreview } from "./preview";

import type { FeeComponentDraft } from "./preview";

export interface InvoicePreviewPanelProps {
  components: FeeComponentDraft[];
  currency: string;
}

/**
 * The invoice this structure produces, computed the same way `generateInvoice` computes a real one
 * (see `preview.ts`'s doc comment for why this is a client-side simulation rather than a call to a
 * preview endpoint — none exists). With scholarships and discounts switched off it is the same for
 * every student, so there is no sample-student picker.
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
  const validComponents = components.filter(
    (component) => component.fee_category.trim() !== "" && Number.isFinite(component.amount),
  );
  const preview = buildInvoicePreview(validComponents);

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
            </tfoot>
          </table>
        </>
      )}
    </section>
  );
}
