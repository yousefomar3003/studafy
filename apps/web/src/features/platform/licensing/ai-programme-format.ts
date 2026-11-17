import { useTranslation } from "../../../lib/i18n";

import { bpsToPercent, useMoney } from "./format";

import type {
  AiProgrammeField,
  AiProgrammeSettings,
  AiProgrammeTier,
} from "@studafy/license-pricing";

const P = "platformLicensing.aiProgramme";

/** One row of a diff between two sets of Student AI programme values. */
export interface ChangeLine {
  field: AiProgrammeField | "prices";
  before?: unknown;
  after: unknown;
  currency: string;
}

/** A programme value as the console shows it: money, percentages, tier lists, days, labels. */
export function useFormatProgrammeValue() {
  const { t } = useTranslation();
  const money = useMoney();
  return (field: ChangeLine["field"], value: unknown, currency: string): string => {
    if (value === undefined || value === null) return "—";
    if (field === "prices") {
      return (value as AiProgrammeSettings["prices"])
        .map(
          (p) =>
            `${p.currencyCode}: ${money(p.iapPriceMinor, p.currencyCode)} / ${money(
              p.licensePriceMinor,
              p.currencyCode,
            )} / ${money(p.parentPriceMinor, p.currencyCode)}`,
        )
        .join("; ");
    }
    if (
      field === "licensePriceMinor" ||
      field === "parentPriceMinor" ||
      field === "iapPriceMinor"
    ) {
      return money(value as number, currency);
    }
    if (field === "conversionTiers" || field === "contentBonusTiers") {
      return (value as AiProgrammeTier[])
        .map((tier) => `${bpsToPercent(tier.fromBps)} → ${bpsToPercent(tier.shareBps)}`)
        .join(", ");
    }
    if (field.endsWith("Bps")) return bpsToPercent(value as number);
    if (field.endsWith("Days")) return t(`${P}.days`, { count: value as number });
    if (field === "payoutMode") return t(`${P}.payoutMode.${value as string}`);
    if (typeof value === "boolean") {
      return value ? t("platform.common.yes") : t("platformLicensing.common.no");
    }
    return String(value);
  };
}
