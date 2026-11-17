import { useFormatters, useTranslation } from "../../lib/i18n";
import { useMoney } from "../platform/licensing/format";

/** One licence year's total, as the API and @studafy/license-pricing `yearTotals` give it. */
export interface YearTotalRow {
  year: number;
  /** YYYY-MM-DD. */
  startDate: string;
  /** YYYY-MM-DD, the day after the year's last day. */
  endDate: string;
  months: number;
  amountMinor: number;
  payments: number;
}

const DAY_MS = 86_400_000;

/** The last day of a licence year: the day before `endDate`. */
export function lastDay(endDate: string): Date {
  return new Date(Date.parse(`${endDate}T00:00:00Z`) - DAY_MS);
}

/**
 * What the school pays in each licence year (year 1, year 2, ...): the payments falling due in it and
 * their total. Shared by the school's quote and invoice pages and the console's calculator and
 * invoice page; with `shares`, a request's shares of a total not yet priced.
 */
export function YearTotals({
  rows,
  currencyCode,
  minorUnit,
  caption,
  shares = false,
}: {
  rows: readonly YearTotalRow[];
  currencyCode: string;
  minorUnit?: number;
  caption?: string;
  /** Amounts are basis points of the total (a request's shares), shown as percentages. */
  shares?: boolean;
}) {
  const { t } = useTranslation();
  const { formatDate, formatNumber } = useFormatters();
  const money = useMoney();
  const date = (iso: string | Date) =>
    formatDate(typeof iso === "string" ? new Date(`${iso}T00:00:00Z`) : iso, {
      dateStyle: "medium",
    });
  const title = caption ?? t("schoolLicense.years.title");
  if (rows.length === 0) return null;
  return (
    <div className="platform-table-scroll">
      <table className="platform-table license-years" data-testid="year-totals">
        <caption className="sf-visually-hidden">{title}</caption>
        <thead>
          <tr>
            <th scope="col">{t("schoolLicense.years.columns.year")}</th>
            <th scope="col">{t("schoolLicense.years.columns.period")}</th>
            <th scope="col">{t("schoolLicense.years.columns.payments")}</th>
            <th scope="col">
              {shares
                ? t("schoolLicense.years.columns.share")
                : t("schoolLicense.years.columns.amount")}
            </th>
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => (
            <tr key={row.year}>
              <th scope="row">{t("schoolLicense.years.year", { year: row.year })}</th>
              <td>
                {t("schoolLicense.years.period", {
                  from: date(row.startDate),
                  to: date(lastDay(row.endDate)),
                  count: row.months,
                })}
              </td>
              <td>{formatNumber(row.payments)}</td>
              <td className="licensing-amount">
                {shares
                  ? `${formatNumber(row.amountMinor / 100, { maximumFractionDigits: 2 })}%`
                  : money(row.amountMinor, currencyCode, minorUnit)}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
