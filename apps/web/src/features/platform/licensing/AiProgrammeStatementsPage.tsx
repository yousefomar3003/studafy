import { Select } from "@studafy/ui";
import { useState } from "react";
import { Link } from "react-router-dom";

import { useFormatters, useTranslation } from "../../../lib/i18n";
import { useDay } from "../../ai-programme/components";
import { STATEMENT_STATUSES, usePlatformStatementsQuery } from "../../ai-programme/queries";
import { PlatformPageHeader } from "../PlatformNav";

import { useMoney } from "./format";

import type { StatementStatus } from "../../ai-programme/queries";

import "../platform.css";
import "./licensing.css";

const P = "platformLicensing.statements";

export function StatementStatusPill({ status }: { status: StatementStatus }) {
  const { t } = useTranslation();
  return (
    <span className="platform-pill" data-status={status} data-testid="statement-status">
      {t(`${P}.status.${status}`)}
    </span>
  );
}

/**
 * The Student AI weekly statements (`/portal/platform/ai-programme/statements`, platform:read):
 * every school's statements, waiting ones first (filtered by status) -- the opt-in months each
 * school collected that week, what it owes Studafy for them less its share, and its licence shares.
 * Each opens to be approved, held or rejected.
 */
export default function AiProgrammeStatementsPage() {
  const { t } = useTranslation();
  const { formatNumber } = useFormatters();
  const money = useMoney();
  const day = useDay();
  const [status, setStatus] = useState<StatementStatus | "">("awaiting_approval");
  const statements = usePlatformStatementsQuery(status);

  return (
    <>
      <PlatformPageHeader title={t(`${P}.title`)} description={t(`${P}.description`)} />
      <p>
        <Link to="/portal/platform/ai-programme/schools">{t(`${P}.schoolsLink`)}</Link>
      </p>
      <div className="platform-toolbar licensing-row">
        <Select
          label={t(`${P}.statusFilter`)}
          value={status}
          onChange={(value) => setStatus(value)}
          options={[
            { value: "" as const, label: t(`${P}.allStatuses`) },
            ...STATEMENT_STATUSES.map((value) => ({ value, label: t(`${P}.status.${value}`) })),
          ]}
        />
      </div>
      {statements.isPending ? <p role="status">{t("site.common.loading")}</p> : null}
      {statements.isError ? <p role="alert">{t("platformLicensing.common.loadError")}</p> : null}
      {statements.data && statements.data.length === 0 ? (
        <p className="platform-muted">{t(`${P}.empty`)}</p>
      ) : null}
      {statements.data && statements.data.length > 0 ? (
        <div className="platform-table-scroll">
          <table className="platform-table" data-testid="statements">
            <caption className="sf-visually-hidden">{t(`${P}.title`)}</caption>
            <thead>
              <tr>
                <th scope="col">{t(`${P}.columns.school`)}</th>
                <th scope="col">{t(`${P}.columns.week`)}</th>
                <th scope="col" className="licensing-amount">
                  {t(`${P}.columns.months`)}
                </th>
                <th scope="col" className="licensing-amount">
                  {t(`${P}.columns.gross`)}
                </th>
                <th scope="col" className="licensing-amount">
                  {t(`${P}.columns.share`)}
                </th>
                <th scope="col" className="licensing-amount">
                  {t(`${P}.columns.net`)}
                </th>
                <th scope="col" className="licensing-amount">
                  {t(`${P}.columns.licenceShares`)}
                </th>
                <th scope="col">{t(`${P}.columns.status`)}</th>
              </tr>
            </thead>
            <tbody>
              {statements.data.map((s) => (
                <tr key={s.id}>
                  <th scope="row">
                    <Link
                      to={`/portal/platform/ai-programme/statements/${s.schoolId}/${s.id}`}
                      aria-label={t(`${P}.open`, { school: s.schoolName, week: day(s.weekStart) })}
                    >
                      {s.schoolName}
                    </Link>
                  </th>
                  <td>{t(`${P}.weekOf`, { start: day(s.weekStart), end: day(s.weekEnd) })}</td>
                  <td className="licensing-amount">{formatNumber(s.monthsCount)}</td>
                  <td className="licensing-amount">
                    {money(s.grossMinor, s.currencyCode, s.minorUnit)}
                  </td>
                  <td className="licensing-amount">
                    {money(s.shareMinor, s.currencyCode, s.minorUnit)}
                  </td>
                  <td className="licensing-amount">
                    <strong>{money(s.netMinor, s.currencyCode, s.minorUnit)}</strong>
                  </td>
                  <td className="licensing-amount">
                    {money(s.licenceShareMinor, s.currencyCode, s.minorUnit)}
                  </td>
                  <td>
                    <StatementStatusPill status={s.status} />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : null}
    </>
  );
}
