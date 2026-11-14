import { useFormatters, useTranslation } from "../../lib/i18n";
import { useMoney } from "../platform/licensing/format";

import type { ReactNode } from "react";

/** One row of a schedule: a quote's preview has only these; an invoice's instalments have more. */
export interface ScheduleRow {
  position: number;
  amountMinor: number;
  dueDate: string;
  paidMinor?: number;
  status?: "due" | "partially_paid" | "paid";
  overdue?: boolean;
  current?: boolean;
}

/**
 * A licence payment schedule (docs/adr/0021): when each instalment is due and how much, and for an
 * invoice how much of each is paid. Shared by the school's quote and invoice pages and the console's
 * calculator and invoice page. `action` adds a last column (the console's payment-link editor).
 */
export function PaymentSchedule({
  rows,
  currencyCode,
  minorUnit,
  caption,
  action,
  actionHeader,
}: {
  rows: readonly ScheduleRow[];
  currencyCode: string;
  minorUnit?: number;
  caption: string;
  action?: (row: ScheduleRow) => ReactNode;
  actionHeader?: string;
}) {
  const { t } = useTranslation();
  const { formatDate } = useFormatters();
  const money = useMoney();
  const withStatus = rows.some((row) => row.status !== undefined);
  const m = (amount: number) => money(amount, currencyCode, minorUnit);

  return (
    <div className="platform-table-scroll">
      <table className="platform-table license-schedule">
        <caption className="sf-visually-hidden">{caption}</caption>
        <thead>
          <tr>
            <th scope="col">{t("schoolLicense.schedule.columns.number")}</th>
            <th scope="col">{t("schoolLicense.schedule.columns.dueDate")}</th>
            <th scope="col">{t("schoolLicense.schedule.columns.amount")}</th>
            {withStatus ? (
              <>
                <th scope="col">{t("schoolLicense.schedule.columns.paid")}</th>
                <th scope="col">{t("schoolLicense.schedule.columns.status")}</th>
              </>
            ) : null}
            {action ? <th scope="col">{actionHeader}</th> : null}
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => (
            <tr key={row.position} data-current={row.current ? "true" : undefined}>
              <td>{row.position}</td>
              <td>{formatDate(new Date(`${row.dueDate}T00:00:00Z`), { dateStyle: "medium" })}</td>
              <td className="licensing-amount">{m(row.amountMinor)}</td>
              {withStatus ? (
                <>
                  <td className="licensing-amount">{m(row.paidMinor ?? 0)}</td>
                  <td>
                    <span
                      className="platform-pill"
                      data-status={row.overdue ? "overdue" : (row.status ?? "due")}
                    >
                      {row.overdue
                        ? t("schoolLicense.schedule.status.overdue")
                        : t(`schoolLicense.schedule.status.${row.status ?? "due"}`)}
                    </span>
                    {row.current ? (
                      <span className="license-muted"> {t("schoolLicense.schedule.current")}</span>
                    ) : null}
                  </td>
                </>
              ) : null}
              {action ? <td>{action(row)}</td> : null}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
