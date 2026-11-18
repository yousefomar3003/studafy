import { Checkbox, Input } from "@studafy/ui";
import { useMemo, useState } from "react";
import { Link } from "react-router-dom";

import { useFormatters, useTranslation } from "../../../lib/i18n";
import { usePercent } from "../../ai-programme/components";
import { useProgrammeSchoolsQuery } from "../../ai-programme/queries";
import { PlatformPageHeader } from "../PlatformNav";

import { useMoney } from "./format";
import { LicenseStatusPill } from "./LicensesPage";

import type { ProgrammeSchoolRow } from "../../ai-programme/queries";

import "../platform.css";
import "./licensing.css";

const P = "platformLicensing.programmeSchools";

type SortKey =
  | "school"
  | "optedIn"
  | "conversion"
  | "uploads"
  | "share"
  | "collected"
  | "owed"
  | "paidOut"
  | "forfeited"
  | "netPerSeat";

const SORT_VALUE: Record<SortKey, (row: ProgrammeSchoolRow) => number | string> = {
  school: (row) => row.schoolName.toLocaleLowerCase(),
  optedIn: (row) => row.optedIn,
  conversion: (row) => row.conversionBps ?? -1,
  uploads: (row) => row.uploadConsistencyBps ?? -1,
  share: (row) => row.totalBps,
  collected: (row) => row.collectedMinor,
  owed: (row) => row.owedMinor + row.payoutDueMinor,
  paidOut: (row) => row.creditedMinor + row.paidOutMinor,
  forfeited: (row) => row.forfeitedMinor,
  netPerSeat: (row) => row.studafyNetPerSeatMinor ?? Number.NEGATIVE_INFINITY,
};

export interface ProgrammeSchoolFilters {
  search: string;
  inProgrammeOnly: boolean;
  owedOnly: boolean;
  belowTier: boolean;
}

/** The rows a filter keeps (exported for the page's tests). */
export function filterProgrammeSchools(
  rows: readonly ProgrammeSchoolRow[],
  filters: ProgrammeSchoolFilters,
): ProgrammeSchoolRow[] {
  const search = filters.search.trim().toLocaleLowerCase();
  return rows.filter(
    (row) =>
      (search === "" || row.schoolName.toLocaleLowerCase().includes(search)) &&
      (!filters.inProgrammeOnly || row.inProgramme) &&
      (!filters.owedOnly || row.owedMinor + row.payoutDueMinor > 0) &&
      (!filters.belowTier || row.conversionShareBps === 0),
  );
}

export function sortProgrammeSchools(
  rows: readonly ProgrammeSchoolRow[],
  key: SortKey,
  direction: "ascending" | "descending",
): ProgrammeSchoolRow[] {
  const value = SORT_VALUE[key];
  const sign = direction === "ascending" ? 1 : -1;
  return [...rows].sort((a, b) => {
    const x = value(a);
    const y = value(b);
    const order =
      typeof x === "string" && typeof y === "string"
        ? x.localeCompare(y)
        : (x as number) - (y as number);
    return order * sign || a.schoolName.localeCompare(b.schoolName);
  });
}

/**
 * Every school in the Student AI programme (`/portal/platform/ai-programme/schools`, platform:read):
 * enrolled and opted in, the conversion in force (locked or not yet), upload consistency, the share
 * rate, the year's revenue share (collected, owed, credited or paid out, forfeited) and what Studafy
 * keeps per seat. Sortable by any figure and filtered by name, programme, money owed or no share.
 * Each school opens its ledger; its licence and settings are linked from there.
 */
export default function AiProgrammeSchoolsPage() {
  const { t } = useTranslation();
  const schools = useProgrammeSchoolsQuery();
  const [filters, setFilters] = useState<ProgrammeSchoolFilters>({
    search: "",
    inProgrammeOnly: true,
    owedOnly: false,
    belowTier: false,
  });
  const [sort, setSort] = useState<{ key: SortKey; direction: "ascending" | "descending" }>({
    key: "school",
    direction: "ascending",
  });
  const rows = useMemo(
    () =>
      sortProgrammeSchools(
        filterProgrammeSchools(schools.data ?? [], filters),
        sort.key,
        sort.direction,
      ),
    [schools.data, filters, sort],
  );

  return (
    <>
      <PlatformPageHeader title={t(`${P}.title`)} description={t(`${P}.description`)} />
      <p>
        <Link to="/portal/platform/ai-programme">{t(`${P}.settingsLink`)}</Link>
      </p>
      <div className="platform-toolbar licensing-row" role="group" aria-label={t(`${P}.filters`)}>
        <Input
          label={t(`${P}.search`)}
          type="search"
          value={filters.search}
          onChange={(event) => setFilters((prev) => ({ ...prev, search: event.target.value }))}
        />
        <Checkbox
          label={t(`${P}.inProgrammeOnly`)}
          checked={filters.inProgrammeOnly}
          onChange={(event) =>
            setFilters((prev) => ({ ...prev, inProgrammeOnly: event.target.checked }))
          }
        />
        <Checkbox
          label={t(`${P}.owedOnly`)}
          checked={filters.owedOnly}
          onChange={(event) => setFilters((prev) => ({ ...prev, owedOnly: event.target.checked }))}
        />
        <Checkbox
          label={t(`${P}.belowTier`)}
          checked={filters.belowTier}
          onChange={(event) => setFilters((prev) => ({ ...prev, belowTier: event.target.checked }))}
        />
      </div>
      {schools.isPending ? <p role="status">{t("site.common.loading")}</p> : null}
      {schools.isError ? <p role="alert">{t("platformLicensing.common.loadError")}</p> : null}
      {schools.data && rows.length === 0 ? (
        <p className="platform-muted">{t(`${P}.empty`)}</p>
      ) : null}
      {rows.length > 0 ? (
        <SchoolTable
          rows={rows}
          sort={sort}
          onSort={(key) =>
            setSort((prev) => ({
              key,
              direction:
                prev.key === key && prev.direction === "ascending" ? "descending" : "ascending",
            }))
          }
        />
      ) : null}
    </>
  );
}

function SchoolTable({
  rows,
  sort,
  onSort,
}: {
  rows: ProgrammeSchoolRow[];
  sort: { key: SortKey; direction: "ascending" | "descending" };
  onSort: (key: SortKey) => void;
}) {
  const { t } = useTranslation();
  const { formatNumber } = useFormatters();
  const pct = usePercent();
  const money = useMoney();

  const header = (key: SortKey, numeric = true) => (
    <th
      scope="col"
      className={numeric ? "licensing-amount" : undefined}
      aria-sort={sort.key === key ? sort.direction : "none"}
    >
      <button type="button" className="aip-sort" onClick={() => onSort(key)}>
        {t(`${P}.columns.${key}`)}
        <span aria-hidden="true">
          {sort.key === key ? (sort.direction === "ascending" ? "▲" : "▼") : "↕"}
        </span>
      </button>
    </th>
  );

  return (
    <div className="platform-table-scroll">
      <table className="platform-table" data-testid="programme-schools">
        <caption className="sf-visually-hidden">{t(`${P}.title`)}</caption>
        <thead>
          <tr>
            {header("school", false)}
            <th scope="col">{t(`${P}.columns.licence`)}</th>
            {header("optedIn")}
            {header("conversion")}
            {header("uploads")}
            {header("share")}
            {header("collected")}
            {header("owed")}
            {header("paidOut")}
            {header("forfeited")}
            {header("netPerSeat")}
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => {
            const m = (amount: number) => money(amount, row.currencyCode, row.minorUnit);
            return (
              <tr key={row.schoolId}>
                <td>
                  <Link to={`/portal/platform/ai-programme/schools/${row.schoolId}`}>
                    {row.schoolName}
                  </Link>
                </td>
                <td>
                  <div className="platform-cell-stack">
                    {row.licenseStatus ? <LicenseStatusPill status={row.licenseStatus} /> : "—"}
                    {row.commitment ? (
                      <span className="platform-muted">
                        {t(`platformLicensing.commitment.${row.commitment}`)}
                      </span>
                    ) : null}
                    {!row.inProgramme ? (
                      <span className="platform-muted">{t(`${P}.notInProgramme`)}</span>
                    ) : null}
                  </div>
                </td>
                <td className="licensing-amount">
                  {t(`${P}.optedInValue`, {
                    optedIn: formatNumber(row.optedIn),
                    enrolled: formatNumber(row.enrolled),
                  })}
                </td>
                <td className="licensing-amount">
                  <div className="platform-cell-stack">
                    <span>{row.conversionBps === null ? "—" : pct(row.conversionBps)}</span>
                    {row.conversionSource ? (
                      <span className="platform-muted">
                        {t(`${P}.source.${row.conversionSource}`)}
                      </span>
                    ) : null}
                  </div>
                </td>
                <td className="licensing-amount">
                  {row.uploadConsistencyBps === null ? "—" : pct(row.uploadConsistencyBps)}
                </td>
                <td className="licensing-amount">
                  <div className="platform-cell-stack">
                    <span>{pct(row.totalBps)}</span>
                    <span className="platform-muted">
                      {t(`${P}.shareParts`, {
                        conversion: pct(row.conversionShareBps),
                        bonus: pct(row.bonusBps),
                      })}
                    </span>
                  </div>
                </td>
                <td className="licensing-amount">{m(row.collectedMinor)}</td>
                <td className="licensing-amount">
                  <div className="platform-cell-stack">
                    <span>{m(row.owedMinor + row.payoutDueMinor)}</span>
                    {row.payoutDueMinor > 0 ? (
                      <span className="platform-muted">
                        {t(`${P}.payoutDue`, { amount: m(row.payoutDueMinor) })}
                      </span>
                    ) : null}
                    {row.pendingMinor > 0 ? (
                      <span className="platform-muted">
                        {t(`${P}.pending`, { amount: m(row.pendingMinor) })}
                      </span>
                    ) : null}
                  </div>
                </td>
                <td className="licensing-amount">
                  <div className="platform-cell-stack">
                    <span>{m(row.creditedMinor + row.paidOutMinor)}</span>
                    <span className="platform-muted">
                      {t(`${P}.creditedPaid`, {
                        credited: m(row.creditedMinor),
                        paid: m(row.paidOutMinor),
                      })}
                    </span>
                  </div>
                </td>
                <td className="licensing-amount">{m(row.forfeitedMinor)}</td>
                <td className="licensing-amount">
                  <div className="platform-cell-stack">
                    <span>
                      {row.studafyNetPerSeatMinor === null ? "—" : m(row.studafyNetPerSeatMinor)}
                    </span>
                    <span className="platform-muted">
                      {t(`${P}.netTotal`, { amount: m(row.studafyNetMinor) })}
                    </span>
                  </div>
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
