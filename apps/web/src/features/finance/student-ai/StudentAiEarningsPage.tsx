import { Link } from "react-router-dom";

import { useFormatters, useTranslation } from "../../../lib/i18n";
import {
  EarningsSum,
  EntryDestination,
  ShareFormula,
  ShareStatusPill,
  StatRow,
  useCurrencyMoney,
  useDay,
} from "../../ai-programme/components";
import {
  useSchoolLedgerQuery,
  useSchoolProgrammeQuery,
  useSchoolStatementsQuery,
} from "../../ai-programme/queries";
import { useMoney } from "../../platform/licensing/format";

import type { StatItem } from "../../ai-programme/components";
import type {
  ProgrammeDashboard,
  RevenueShareEntry,
  RevenueShareLedger,
  StatementStatus,
} from "../../ai-programme/queries";

const P = "finance.studentAiEarnings";

/**
 * Student AI earnings (`/portal/finance/student-ai`), gated by `aiRevenueShare:read` (finance, the
 * school admin and the principal): what the school owes and paid Studafy for its licence; the
 * revenue share per period, worked out as collected -> conversion % + bonus % = total % -> amount,
 * with where each share went (credited on which invoice, paid out, forfeited); the payouts; and the
 * school's total earnings for the year, each part labelled with what it counts. Read-only.
 */
export default function StudentAiEarningsPage() {
  const { t } = useTranslation();
  const summary = useSchoolProgrammeQuery();
  const ledger = useSchoolLedgerQuery();

  return (
    <div className="aip-stack">
      <div>
        <h1>{t(`${P}.title`)}</h1>
        <p>{t(`${P}.intro`)}</p>
        <p>
          <Link to="/portal/finance/settings/student-ai">{t(`${P}.billingLink`)}</Link>
        </p>
      </div>
      {summary.isPending ? <p role="status">{t("finance.common.loading")}</p> : null}
      {summary.isError ? <p role="alert">{t(`${P}.loadError`)}</p> : null}
      {summary.data ? (
        <>
          <Headline dashboard={summary.data} />
          <section className="aip-section" aria-labelledby="earnings-sum">
            <h2 id="earnings-sum">{t(`${P}.earningsTitle`)}</h2>
            <EarningsSum
              earnings={summary.data.earnings}
              currencyCode={summary.data.currencyCode}
              minorUnit={summary.data.minorUnit}
              yearName={summary.data.academicYear?.name ?? null}
            />
          </section>
        </>
      ) : null}
      <section className="aip-section" aria-labelledby="earnings-periods">
        <h2 id="earnings-periods">{t(`${P}.periodsTitle`)}</h2>
        <p className="aip-muted">{t(`${P}.periodsIntro`)}</p>
        {ledger.isPending ? <p role="status">{t("finance.common.loading")}</p> : null}
        {ledger.isError ? <p role="alert">{t(`${P}.loadError`)}</p> : null}
        {ledger.data ? <SharePeriods ledger={ledger.data} /> : null}
      </section>
      {ledger.data ? <Payouts ledger={ledger.data} /> : null}
      <Statements />
    </div>
  );
}

function Headline({ dashboard }: { dashboard: ProgrammeDashboard }) {
  const { t } = useTranslation();
  const m = useCurrencyMoney(dashboard.currencyCode, dashboard.minorUnit);
  const studafy = dashboard.studafy;
  const year = dashboard.academicYear?.name;
  const items: StatItem[] = [
    {
      key: "owed",
      label: t(`${P}.stats.owed`),
      value: studafy ? m(studafy.outstandingMinor) : "—",
      hint:
        studafy && studafy.overdueMinor > 0
          ? t(`${P}.stats.overdue`, { amount: m(studafy.overdueMinor) })
          : t(`${P}.stats.owedHint`),
      tone: studafy && studafy.overdueMinor > 0 ? "warning" : undefined,
    },
    {
      key: "paid",
      label: t(`${P}.stats.paid`),
      value: studafy ? m(studafy.paidMinor) : "—",
      hint: studafy ? t(`${P}.stats.paidHint`, { invoiced: m(studafy.invoicedMinor) }) : undefined,
    },
    {
      key: "share",
      label: year ? t(`${P}.stats.shareFor`, { year }) : t(`${P}.stats.share`),
      value: m(dashboard.earnings.share.earnedMinor),
      hint: t(`${P}.stats.shareHint`, { collected: m(dashboard.earnings.share.collectedMinor) }),
    },
    {
      key: "total",
      label: year ? t(`${P}.stats.totalFor`, { year }) : t(`${P}.stats.total`),
      value: m(dashboard.earnings.totalMinor),
      hint: dashboard.earnings.estimated
        ? t("schoolLicense.programme.earnings.estimated")
        : undefined,
      tone: "success",
    },
  ];
  return <StatRow items={items} label={t(`${P}.stats.label`)} />;
}

function periodKey(entry: RevenueShareEntry): string {
  return `${entry.periodFrom}|${entry.periodTo}`;
}

/** The ledger by the period each share pays for, newest first; each share on its own row. */
function SharePeriods({ ledger }: { ledger: RevenueShareLedger }) {
  const { t } = useTranslation();
  const money = useMoney();
  const day = useDay();
  const { formatNumber } = useFormatters();
  if (ledger.entries.length === 0) {
    return <p className="aip-muted">{t(`${P}.empty`)}</p>;
  }
  const groups = new Map<string, RevenueShareEntry[]>();
  for (const entry of ledger.entries) {
    groups.set(periodKey(entry), [...(groups.get(periodKey(entry)) ?? []), entry]);
  }
  const ordered = [...groups.entries()].sort(([a], [b]) => b.localeCompare(a));
  return (
    <div className="aip-table-scroll">
      <table className="aip-table" data-testid="share-periods">
        <caption className="sf-visually-hidden">{t(`${P}.periodsTitle`)}</caption>
        <thead>
          <tr>
            <th scope="col">{t(`${P}.columns.period`)}</th>
            <th scope="col">{t(`${P}.columns.payment`)}</th>
            <th scope="col">{t(`${P}.columns.share`)}</th>
            <th scope="col">{t(`${P}.columns.status`)}</th>
            <th scope="col">{t(`${P}.columns.destination`)}</th>
          </tr>
        </thead>
        <tbody>
          {ordered.flatMap(([key, entries]) =>
            entries.map((entry, index) => {
              const m = (amount: number) => money(amount, entry.currencyCode, entry.minorUnit);
              return (
                <tr key={entry.id} data-period={key}>
                  {index === 0 ? (
                    <th scope="rowgroup" rowSpan={entries.length}>
                      {t("schoolLicense.programme.periodValue", {
                        from: day(entry.periodFrom),
                        to: day(entry.periodTo),
                      })}
                    </th>
                  ) : null}
                  <td>
                    <div>{t(`${P}.paidOn`, { date: day(entry.receivedOn) })}</div>
                    <div className="aip-muted">
                      {t(`${P}.instalment`, {
                        number: entry.invoiceNumber,
                        position: formatNumber(entry.instalmentPosition),
                      })}
                    </div>
                  </td>
                  <td>
                    <ShareFormula
                      collected={m(entry.baseMinor)}
                      conversionBps={entry.conversionShareBps}
                      bonusBps={entry.bonusBps}
                      totalBps={entry.totalBps}
                      amount={m(entry.amountMinor)}
                      capped={entry.capped}
                      multiplierBps={entry.multiplierBps}
                    />
                    {entry.kind === "reversal" ? (
                      <div className="aip-muted">{t(`${P}.reversal`)}</div>
                    ) : null}
                  </td>
                  <td>
                    <ShareStatusPill status={entry.status} />
                  </td>
                  <td>
                    <EntryDestination entry={entry} />
                  </td>
                </tr>
              );
            }),
          )}
        </tbody>
      </table>
    </div>
  );
}

function Payouts({ ledger }: { ledger: RevenueShareLedger }) {
  const { t } = useTranslation();
  const money = useMoney();
  const day = useDay();
  return (
    <section className="aip-section" aria-labelledby="earnings-payouts">
      <h2 id="earnings-payouts">{t(`${P}.payoutsTitle`)}</h2>
      {ledger.payouts.length === 0 ? (
        <p className="aip-muted">{t(`${P}.noPayouts`)}</p>
      ) : (
        <div className="aip-table-scroll">
          <table className="aip-table" data-testid="payouts">
            <caption className="sf-visually-hidden">{t(`${P}.payoutsTitle`)}</caption>
            <thead>
              <tr>
                <th scope="col">{t(`${P}.columns.paidOn`)}</th>
                <th scope="col">{t(`${P}.columns.reference`)}</th>
                <th scope="col" className="aip-num">
                  {t(`${P}.columns.amount`)}
                </th>
              </tr>
            </thead>
            <tbody>
              {ledger.payouts.map((payout) => (
                <tr key={payout.id}>
                  <td>{day(payout.paidOn)}</td>
                  <td>{payout.reference}</td>
                  <td className="aip-num">{money(payout.amountMinor, payout.currencyCode)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}

/**
 * The weekly statements (000251): each week, the Student AI months the school collected from
 * parents, what it owes Studafy for them less its share, and Studafy's decision. An approved one is
 * billed on the invoice shown; the months turn on for the students once that invoice is paid.
 */
function Statements() {
  const { t } = useTranslation();
  const { formatNumber } = useFormatters();
  const money = useMoney();
  const day = useDay();
  const statements = useSchoolStatementsQuery();
  return (
    <section className="aip-section" aria-labelledby="earnings-statements">
      <h2 id="earnings-statements">{t(`${P}.statementsTitle`)}</h2>
      <p className="aip-muted">{t(`${P}.statementsIntro`)}</p>
      {statements.isPending ? <p role="status">{t("finance.common.loading")}</p> : null}
      {statements.isError ? <p role="alert">{t(`${P}.loadError`)}</p> : null}
      {statements.data && statements.data.length === 0 ? (
        <p className="aip-muted">{t(`${P}.noStatements`)}</p>
      ) : null}
      {statements.data && statements.data.length > 0 ? (
        <div className="aip-table-scroll">
          <table className="aip-table" data-testid="statements">
            <caption className="sf-visually-hidden">{t(`${P}.statementsTitle`)}</caption>
            <thead>
              <tr>
                <th scope="col">{t(`${P}.columns.week`)}</th>
                <th scope="col" className="aip-num">
                  {t(`${P}.columns.months`)}
                </th>
                <th scope="col" className="aip-num">
                  {t(`${P}.columns.owed`)}
                </th>
                <th scope="col" className="aip-num">
                  {t(`${P}.columns.yourShare`)}
                </th>
                <th scope="col" className="aip-num">
                  {t(`${P}.columns.net`)}
                </th>
                <th scope="col">{t(`${P}.columns.decision`)}</th>
              </tr>
            </thead>
            <tbody>
              {statements.data.map((s) => (
                <tr key={s.id}>
                  <td>{day(s.weekStart)}</td>
                  <td className="aip-num">{formatNumber(s.monthsCount)}</td>
                  <td className="aip-num">{money(s.grossMinor, s.currencyCode, s.minorUnit)}</td>
                  <td className="aip-num">{money(s.shareMinor, s.currencyCode, s.minorUnit)}</td>
                  <td className="aip-num">
                    <strong>{money(s.netMinor, s.currencyCode, s.minorUnit)}</strong>
                  </td>
                  <td>
                    {t(`${P}.statementStatus.${s.status as StatementStatus}`)}
                    {s.invoiceNumber ? ` · ${s.invoiceNumber}` : ""}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : null}
    </section>
  );
}
