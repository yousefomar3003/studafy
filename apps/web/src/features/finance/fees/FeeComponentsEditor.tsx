import { Button, Input } from "@studafy/ui";

import { useFormatters, useTranslation } from "../../../lib/i18n";

import { componentsSubtotal } from "./preview";

import type { FeeComponentDraft } from "./preview";

export interface FeeComponentRowErrors {
  fee_category?: string;
  amount?: string;
}

export interface FeeComponentsEditorProps {
  components: FeeComponentDraft[];
  onChange: (components: FeeComponentDraft[]) => void;
  errors?: Record<number, FeeComponentRowErrors>;
  disabled?: boolean;
  currency: string;
}

/** Three fixed decimals, ungrouped — the same `toFixed(3)` shape ERPNext amounts use. */
const AMOUNT_FORMAT: Intl.NumberFormatOptions = {
  minimumFractionDigits: 3,
  maximumFractionDigits: 3,
  useGrouping: false,
};

const EMPTY_ROW: FeeComponentDraft = { fee_category: "", amount: 0, description: "" };

/**
 * The fee structure's item composition: one row per ERPNext Fee Category, matching
 * `feeComponentSchema` on the wire (`fee_category`, `amount`, optional `description`). There is no
 * endpoint that lists valid Fee Category names — the gateway is a thin pass-through and doesn't
 * validate them either (see `createFeeStructureBodySchema`'s doc comment) — so this is free text,
 * not a picker backed by data Studafy doesn't have.
 */
export function FeeComponentsEditor({
  components,
  onChange,
  errors,
  disabled = false,
  currency,
}: FeeComponentsEditorProps) {
  const { t } = useTranslation();
  const { formatNumber } = useFormatters();
  function updateRow(index: number, patch: Partial<FeeComponentDraft>) {
    onChange(components.map((row, i) => (i === index ? { ...row, ...patch } : row)));
  }

  function removeRow(index: number) {
    onChange(components.filter((_, i) => i !== index));
  }

  function addRow() {
    onChange([...components, { ...EMPTY_ROW }]);
  }

  return (
    <fieldset className="fee-builder__components">
      <legend className="fee-builder__components-legend">
        {t("finance.fees.components.legend")}
      </legend>

      {components.length === 0 ? (
        <p className="fee-builder__components-empty">{t("finance.fees.components.empty")}</p>
      ) : (
        <ol className="fee-builder__component-rows">
          {components.map((row, index) => {
            // `index` comes from mapping `components` itself, never external input — the same
            // bounded-key shape `finance/queries.ts` documents for this rule.
            // eslint-disable-next-line security/detect-object-injection
            const rowErrors = errors?.[index];
            return (
              // Rows are positional, not identity-bearing until saved — index is the only stable
              // key available while the admin is still composing them.
              <li key={index} className="fee-builder__component-row">
                <fieldset className="fee-builder__component-row-fields">
                  <legend className="sf-visually-hidden">
                    {t("finance.fees.components.rowLegend", { number: index + 1 })}
                  </legend>
                  <Input
                    label={t("finance.fees.components.feeCategory")}
                    value={row.fee_category}
                    onChange={(event) => updateRow(index, { fee_category: event.target.value })}
                    error={rowErrors?.fee_category}
                    disabled={disabled}
                    required
                    placeholder={t("finance.fees.components.feeCategoryPlaceholder")}
                  />
                  <Input
                    label={t("finance.common.amount")}
                    type="number"
                    min={0}
                    step="0.001"
                    inputMode="decimal"
                    value={Number.isFinite(row.amount) ? row.amount : ""}
                    onChange={(event) => updateRow(index, { amount: event.target.valueAsNumber })}
                    error={rowErrors?.amount}
                    disabled={disabled}
                    required
                    suffix={currency}
                  />
                  <Input
                    label={t("finance.common.description")}
                    value={row.description ?? ""}
                    onChange={(event) => updateRow(index, { description: event.target.value })}
                    disabled={disabled}
                  />
                </fieldset>
                <Button
                  type="button"
                  variant="tertiary"
                  disabled={disabled}
                  onClick={() => removeRow(index)}
                  aria-label={t("finance.fees.components.removeLabel", { number: index + 1 })}
                >
                  {t("finance.fees.components.remove")}
                </Button>
              </li>
            );
          })}
        </ol>
      )}

      <div className="fee-builder__components-footer">
        <Button type="button" variant="secondary" disabled={disabled} onClick={addRow}>
          {t("finance.fees.components.add")}
        </Button>
        <p className="fee-builder__components-subtotal">
          {t("finance.fees.components.subtotal", {
            amount: formatNumber(componentsSubtotal(components), AMOUNT_FORMAT),
            currency,
          })}
        </p>
      </div>
    </fieldset>
  );
}
