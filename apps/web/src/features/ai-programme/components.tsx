import { contentBonusAimBps } from "@studafy/license-pricing";

import { useFormatters, useTranslation } from "../../lib/i18n";
import { useMoney } from "../platform/licensing/format";

import type {
  ProgrammeDashboard,
  ProgrammeEarnings,
  ProgrammeTier,
  RevenueShareEntry,
  RevenueShareStatus,
  UploadConsistency,
} from "./queries";
import type { ReactNode } from "react";

import "./ai-programme.css";

/**
 * The pieces every Student AI dashboard shares (the school's results page, finance's earnings page,
 * the console): percentages, the stat row, the conversion bar and its tier ladder, the next-tier
 * hint, the share formula, the earnings sum and the upload consistency tables. Strings live in the
 * schoolLicense catalog under `programme`, which every route showing these loads.
 */

const P = "schoolLicense.programme";

/** Basis points in the user's locale: 1300 -> "13%", 1250 -> "12.5%". */
export function usePercent() {
  const { formatNumber } = useFormatters();
  return (bps: number) =>
    formatNumber(bps / 10_000, { style: "percent", maximumFractionDigits: 2 });
}

/** Money in one currency, bound once. */
export function useCurrencyMoney(currencyCode: string, minorUnit: number) {
  const money = useMoney();
  return (amountMinor: number) => money(amountMinor, currencyCode, minorUnit);
}

/** "2026-11-18" in the user's locale. */
export function useDay() {
  const { formatDate } = useFormatters();
  return (iso: string) =>
    formatDate(new Date(`${iso.slice(0, 10)}T00:00:00Z`), { dateStyle: "medium", timeZone: "UTC" });
}

// ---------------------------------------------------------------------------------------------------
// Stats
// ---------------------------------------------------------------------------------------------------

export interface StatItem {
  key: string;
  label: string;
  value: ReactNode;
  hint?: ReactNode;
  tone?: "success" | "warning";
}

export function StatRow({ items, label }: { items: StatItem[]; label: string }) {
  return (
    <dl className="aip-stats" aria-label={label}>
      {items.map((item) => (
        <div
          key={item.key}
          className="aip-stat"
          data-tone={item.tone}
          data-testid={`stat-${item.key}`}
        >
          <dt>{item.label}</dt>
          <dd>{item.value}</dd>
          {item.hint ? <dd className="aip-stat__hint">{item.hint}</dd> : null}
        </div>
      ))}
    </dl>
  );
}

// ---------------------------------------------------------------------------------------------------
// Conversion
// ---------------------------------------------------------------------------------------------------

/** A 0-100% bar with tick marks at each tier's threshold (decorative: the ladder says it in words). */
export function PercentMeter({
  valueBps,
  marks = [],
  tone,
  small,
}: {
  valueBps: number | null;
  marks?: number[];
  tone?: "success" | "warning";
  small?: boolean;
}) {
  const width = Math.max(0, Math.min(100, (valueBps ?? 0) / 100));
  return (
    <span className={small ? "aip-meter aip-meter--small" : "aip-meter"} aria-hidden="true">
      <span className="aip-meter__fill" data-tone={tone} style={{ inlineSize: `${width}%` }} />
      {marks
        .filter((mark) => mark > 0 && mark < 10_000)
        .map((mark) => (
          <span
            key={mark}
            className="aip-meter__mark"
            style={{ insetInlineStart: `${mark / 100}%` }}
          />
        ))}
    </span>
  );
}

/** The conversion tiers, the one in force marked: "25%+ · 4%". */
export function TierLadder({
  tiers,
  currentFromBps,
  label,
}: {
  tiers: readonly ProgrammeTier[];
  currentFromBps: number | null;
  label: string;
}) {
  const { t } = useTranslation();
  const pct = usePercent();
  return (
    <ol className="aip-tiers" aria-label={label}>
      {[...tiers]
        .sort((a, b) => a.fromBps - b.fromBps)
        .map((tier) => {
          const current = tier.fromBps === currentFromBps;
          return (
            <li key={tier.fromBps} aria-current={current ? "true" : undefined}>
              <span>{t(`${P}.tierFrom`, { from: pct(tier.fromBps) })}</span>
              <span className="aip-tiers__share">
                {t(`${P}.tierShare`, { share: pct(tier.shareBps) })}
              </span>
            </li>
          );
        })}
    </ol>
  );
}

/**
 * "Add 75 more seats -> unlock 12%", and the large-school floor when it pays more, saying which is
 * closer. Opt-ins are what conversion counts, and each opt-in holds a seat.
 */
export function NextTierCallout({ dashboard }: { dashboard: ProgrammeDashboard }) {
  const { t } = useTranslation();
  const { formatNumber } = useFormatters();
  const pct = usePercent();
  const next = dashboard.nextTier;
  const floor = dashboard.largeSchoolFloor;
  if (!next && !floor) {
    return dashboard.license ? (
      <div className="aip-callout" data-testid="next-tier">
        <p className="aip-callout__title">{t(`${P}.next.top`)}</p>
      </div>
    ) : null;
  }
  const floorCloser = Boolean(floor && (!next || floor.seatsNeeded < next.optInsNeeded));
  return (
    <div className="aip-callout" data-testid="next-tier">
      {next ? (
        <p className="aip-callout__title">
          {next.optInsNeeded === 0
            ? t(`${P}.next.reached`, { share: pct(next.shareBps) })
            : t(`${P}.next.add`, {
                count: next.optInsNeeded,
                seats: formatNumber(next.optInsNeeded),
                share: pct(next.shareBps),
              })}
        </p>
      ) : null}
      {next && next.optInsNeeded > 0 ? (
        <p className="aip-muted">
          {t(`${P}.next.explain`, {
            from: pct(next.fromBps),
            enrolled: formatNumber(dashboard.students.enrolled),
          })}
        </p>
      ) : null}
      {floor ? (
        <p className={next ? "aip-muted" : "aip-callout__title"} data-testid="floor-hint">
          {t(floorCloser ? `${P}.next.floorCloser` : `${P}.next.floor`, {
            count: floor.seatsNeeded,
            seats: formatNumber(floor.seatsNeeded),
            minSeats: formatNumber(floor.minSeats),
            share: pct(floor.shareBps),
          })}
        </p>
      ) : null}
    </div>
  );
}

/** Where the conversion figure comes from: locked on the measurement day, or not yet. */
export function useConversionSource() {
  const { t } = useTranslation();
  const day = useDay();
  return (conversion: NonNullable<ProgrammeDashboard["conversion"]>) =>
    conversion.source === "locked"
      ? t(`${P}.conversion.locked`, { date: day(conversion.measureOn) })
      : conversion.source === "provisional"
        ? t(`${P}.conversion.provisional`, { date: day(conversion.measureOn) })
        : t(`${P}.conversion.live`, { date: day(conversion.measureOn) });
}

/** The conversion card: the bar, the tier ladder, where it stands and what the next step takes. */
export function ConversionSection({
  dashboard,
  headingId,
}: {
  dashboard: ProgrammeDashboard;
  headingId: string;
}) {
  const { t } = useTranslation();
  const { formatNumber } = useFormatters();
  const pct = usePercent();
  const source = useConversionSource();
  const conversion = dashboard.conversion;
  return (
    <section className="aip-section" aria-labelledby={headingId}>
      <h2 id={headingId}>{t(`${P}.conversion.title`)}</h2>
      {!conversion ? (
        <p className="aip-muted">{t(`${P}.conversion.noLicence`)}</p>
      ) : (
        <>
          <p data-testid="conversion-sentence">
            {t(`${P}.conversion.sentence`, {
              optedIn: formatNumber(conversion.optedIn),
              enrolled: formatNumber(conversion.enrolled),
              conversion: pct(conversion.conversionBps),
              share: pct(conversion.shareBps),
            })}
          </p>
          <PercentMeter
            valueBps={conversion.conversionBps}
            marks={dashboard.values.conversionTiers.map((tier) => tier.fromBps)}
          />
          <TierLadder
            tiers={dashboard.values.conversionTiers}
            currentFromBps={conversion.tierFromBps}
            label={t(`${P}.conversion.tiers`)}
          />
          <p className="aip-muted">
            {source(conversion)}
            {conversion.floorApplied
              ? ` ${t(`${P}.conversion.floorApplied`, {
                  minSeats: formatNumber(dashboard.values.largeSchoolMinSeats),
                  share: pct(dashboard.values.largeSchoolShareBps),
                })}`
              : ""}
          </p>
          <NextTierCallout dashboard={dashboard} />
        </>
      )}
    </section>
  );
}

// ---------------------------------------------------------------------------------------------------
// The share
// ---------------------------------------------------------------------------------------------------

/** collected -> conversion % + bonus % = total % -> amount, read as one sentence by screen readers. */
export function ShareFormula({
  collected,
  conversionBps,
  bonusBps,
  totalBps,
  amount,
  capped,
  multiplierBps,
}: {
  collected: string;
  conversionBps: number;
  bonusBps: number;
  totalBps: number;
  amount: string;
  capped?: boolean;
  multiplierBps?: number;
}) {
  const { t } = useTranslation();
  const pct = usePercent();
  const sentence = t(`${P}.formula.sentence`, {
    collected,
    conversion: pct(conversionBps),
    bonus: pct(bonusBps),
    total: pct(totalBps),
    amount,
  });
  const arrow = t(`${P}.formula.arrow`);
  return (
    <span className="aip-formula" role="img" aria-label={sentence}>
      <span className="aip-formula__part" aria-hidden="true">
        <span className="aip-formula__label">{t(`${P}.formula.collected`)}</span>
        <span>{collected}</span>
      </span>
      <span className="aip-formula__op" aria-hidden="true">
        {arrow}
      </span>
      <span className="aip-formula__part" aria-hidden="true">
        <span className="aip-formula__label">{t(`${P}.formula.conversion`)}</span>
        <span>{pct(conversionBps)}</span>
      </span>
      <span className="aip-formula__op" aria-hidden="true">
        +
      </span>
      <span className="aip-formula__part" aria-hidden="true">
        <span className="aip-formula__label">{t(`${P}.formula.bonus`)}</span>
        <span>{pct(bonusBps)}</span>
      </span>
      <span className="aip-formula__op" aria-hidden="true">
        =
      </span>
      <span className="aip-formula__part" aria-hidden="true">
        <span className="aip-formula__label">
          {capped
            ? t(`${P}.formula.totalCapped`)
            : multiplierBps !== undefined && multiplierBps !== 10_000
              ? t(`${P}.formula.totalScaled`, { multiplier: pct(multiplierBps) })
              : t(`${P}.formula.total`)}
        </span>
        <span>{pct(totalBps)}</span>
      </span>
      <span className="aip-formula__op" aria-hidden="true">
        {arrow}
      </span>
      <span className="aip-formula__part aip-formula__amount" aria-hidden="true">
        <span className="aip-formula__label">{t(`${P}.formula.amount`)}</span>
        <span>{amount}</span>
      </span>
    </span>
  );
}

const STATUS_TONE: Record<RevenueShareStatus, "success" | "warning" | "danger" | undefined> = {
  pending: "warning",
  awaiting_approval: "warning",
  owed: "warning",
  zero: undefined,
  credited: "success",
  payout_due: "warning",
  paid_out: "success",
  forfeited: "danger",
  void: undefined,
  rejected: "danger",
};

export function ShareStatusPill({ status }: { status: RevenueShareStatus }) {
  const { t } = useTranslation();
  return (
    <span className="aip-pill" data-tone={STATUS_TONE[status]} data-testid="share-status">
      {t(`${P}.status.${status}`)}
    </span>
  );
}

/** Where an entry's money went: credited on an invoice, paid out, forfeited, or still to come. */
export function EntryDestination({ entry }: { entry: RevenueShareEntry }) {
  const { t } = useTranslation();
  if (entry.status === "credited" && entry.creditInvoiceNumber) {
    return <>{t(`${P}.destination.credited`, { number: entry.creditInvoiceNumber })}</>;
  }
  if (entry.status === "paid_out") return <>{t(`${P}.destination.paidOut`)}</>;
  if (entry.status === "payout_due") return <>{t(`${P}.destination.payoutDue`)}</>;
  if (entry.status === "owed") return <>{t(`${P}.destination.owed`)}</>;
  if (entry.status === "forfeited") {
    return (
      <>
        {entry.forfeitReason === "late_payment"
          ? t(`${P}.destination.forfeitedLate`)
          : t(`${P}.destination.forfeitedUnpaid`)}
      </>
    );
  }
  if (entry.status === "pending") {
    return (
      <>
        {entry.conversionPending
          ? t(`${P}.destination.pendingConversion`)
          : t(`${P}.destination.pendingBonus`)}
      </>
    );
  }
  return <>—</>;
}

// ---------------------------------------------------------------------------------------------------
// Earnings
// ---------------------------------------------------------------------------------------------------

/**
 * The school's earnings for the year as a sum, each line saying what it counts: the revenue share
 * earned (final), the margin on Student AI lines Studafy billed and parents paid, the margin on lines
 * the school bills itself (an estimate), and the total. Pending shares are shown apart.
 */
export function EarningsSum({
  earnings,
  currencyCode,
  minorUnit,
  yearName,
}: {
  earnings: ProgrammeEarnings;
  currencyCode: string;
  minorUnit: number;
  yearName: string | null;
}) {
  const { t } = useTranslation();
  const m = useCurrencyMoney(currencyCode, minorUnit);
  const { share, margin } = earnings;
  return (
    <div className="aip-section" data-testid="earnings">
      <dl className="aip-sum">
        <dt>
          <span>{t(`${P}.earnings.share`)}</span>
          <span className="aip-sum__note">{t(`${P}.earnings.shareNote`)}</span>
        </dt>
        <dd data-testid="earnings-share">{m(share.earnedMinor)}</dd>
        {margin.basis === "collected" || margin.basis === "mixed" ? (
          <>
            <dt>
              <span>{t(`${P}.earnings.marginCollected`)}</span>
              <span className="aip-sum__note">
                {t(`${P}.earnings.marginCollectedNote`, { billed: m(margin.billedMinor) })}
              </span>
            </dt>
            <dd data-testid="earnings-margin">{m(margin.collectedMinor)}</dd>
          </>
        ) : null}
        {margin.basis === "estimated" || margin.basis === "mixed" ? (
          <>
            <dt>
              <span>
                {t(`${P}.earnings.marginEstimated`)}{" "}
                <span className="aip-pill" data-tone="warning">
                  {t(`${P}.earnings.estimated`)}
                </span>
              </span>
              <span className="aip-sum__note">{t(`${P}.earnings.marginEstimatedNote`)}</span>
            </dt>
            <dd data-testid="earnings-estimated">{m(margin.estimatedMinor)}</dd>
          </>
        ) : null}
        {margin.basis === "none" ? (
          <>
            <dt>
              <span>{t(`${P}.earnings.margin`)}</span>
              <span className="aip-sum__note">{t(`${P}.earnings.marginNone`)}</span>
            </dt>
            <dd>{m(0)}</dd>
          </>
        ) : null}
        <dt className="aip-sum__total">
          {yearName ? t(`${P}.earnings.totalFor`, { year: yearName }) : t(`${P}.earnings.total`)}
          {earnings.estimated ? (
            <span className="aip-sum__note">{t(`${P}.earnings.totalEstimated`)}</span>
          ) : null}
        </dt>
        <dd className="aip-sum__total" data-testid="earnings-total">
          {m(earnings.totalMinor)}
        </dd>
      </dl>
      <p className="aip-muted">
        {margin.perStudentMonthMinor !== null
          ? t(`${P}.earnings.marginRule`, { margin: m(margin.perStudentMonthMinor) })
          : null}{" "}
        {share.pendingMinor > 0
          ? t(`${P}.earnings.pending`, { amount: m(share.pendingMinor) })
          : null}{" "}
        {margin.expectedMinor !== margin.collectedMinor + margin.estimatedMinor
          ? t(`${P}.earnings.expected`, { amount: m(margin.expectedMinor) })
          : null}
      </p>
    </div>
  );
}

// ---------------------------------------------------------------------------------------------------
// Upload consistency
// ---------------------------------------------------------------------------------------------------

/** What teachers should aim for on this report's tiers (the next paying tier, or the top one). */
export function uploadAimOf(report: UploadConsistency): number | null {
  return contentBonusAimBps(report.bonus.tiers, report.consistencyBps);
}

function isBelow(bps: number | null, aim: number | null): boolean {
  return aim !== null && bps !== null && bps < aim;
}

/**
 * Upload consistency per class (and per teacher, when asked), each with its bar; the rows below the
 * school's target are marked in words as well as colour.
 */
export function UploadTables({
  report,
  showTeachers,
  headingLevel = 3,
}: {
  report: UploadConsistency;
  showTeachers: boolean;
  headingLevel?: 2 | 3;
}) {
  const { t } = useTranslation();
  const { formatNumber } = useFormatters();
  const pct = usePercent();
  const aim = uploadAimOf(report);
  const Heading = headingLevel === 2 ? "h2" : "h3";
  const teachers = [...report.teachers].sort(
    (a, b) => (a.consistencyBps ?? -1) - (b.consistencyBps ?? -1),
  );
  const classes = [...report.classes].sort(
    (a, b) => (a.consistencyBps ?? -1) - (b.consistencyBps ?? -1),
  );
  const below = (bps: number | null) =>
    isBelow(bps, aim) ? (
      <span className="aip-pill" data-tone="warning" data-testid="below-target">
        {t(`${P}.uploads.belowTarget`)}
      </span>
    ) : null;
  const value = (bps: number | null) => (bps === null ? "—" : pct(bps));

  return (
    <>
      {aim !== null ? (
        <p className="aip-muted" data-testid="upload-aim">
          {t(`${P}.uploads.aim`, { aim: pct(aim) })}
        </p>
      ) : null}
      {showTeachers ? (
        <>
          <Heading>{t(`${P}.uploads.teachers`)}</Heading>
          <div className="aip-table-scroll">
            <table className="aip-table" data-testid="upload-teachers">
              <caption className="sf-visually-hidden">{t(`${P}.uploads.teachers`)}</caption>
              <thead>
                <tr>
                  <th scope="col">{t(`${P}.uploads.teacher`)}</th>
                  <th scope="col">{t(`${P}.uploads.classes`)}</th>
                  <th scope="col" className="aip-num">
                    {t(`${P}.uploads.consistency`)}
                  </th>
                  <th scope="col">
                    <span className="sf-visually-hidden">{t(`${P}.uploads.standing`)}</span>
                  </th>
                </tr>
              </thead>
              <tbody>
                {teachers.length === 0 ? (
                  <tr>
                    <td colSpan={4} className="aip-muted">
                      {t(`${P}.uploads.none`)}
                    </td>
                  </tr>
                ) : (
                  teachers.map((teacher) => (
                    <tr
                      key={teacher.teacherId}
                      data-below={isBelow(teacher.consistencyBps, aim) ? "true" : undefined}
                    >
                      <th scope="row">{teacher.name}</th>
                      <td className="aip-num">{formatNumber(teacher.classIds.length)}</td>
                      <td className="aip-num">
                        <PercentMeter
                          small
                          valueBps={teacher.consistencyBps}
                          marks={aim !== null ? [aim] : []}
                          tone={isBelow(teacher.consistencyBps, aim) ? "warning" : "success"}
                        />{" "}
                        {value(teacher.consistencyBps)}
                      </td>
                      <td>{below(teacher.consistencyBps)}</td>
                    </tr>
                  ))
                )}
              </tbody>
            </table>
          </div>
        </>
      ) : null}
      <Heading>{t(`${P}.uploads.classesTitle`)}</Heading>
      <div className="aip-table-scroll">
        <table className="aip-table" data-testid="upload-classes">
          <caption className="sf-visually-hidden">{t(`${P}.uploads.classesTitle`)}</caption>
          <thead>
            <tr>
              <th scope="col">{t(`${P}.uploads.class`)}</th>
              <th scope="col" className="aip-num">
                {t(`${P}.uploads.days`)}
              </th>
              <th scope="col" className="aip-num">
                {t(`${P}.uploads.consistency`)}
              </th>
              <th scope="col">
                <span className="sf-visually-hidden">{t(`${P}.uploads.standing`)}</span>
              </th>
            </tr>
          </thead>
          <tbody>
            {classes.length === 0 ? (
              <tr>
                <td colSpan={4} className="aip-muted">
                  {t(`${P}.uploads.none`)}
                </td>
              </tr>
            ) : (
              classes.map((row) => (
                <tr
                  key={row.classId}
                  data-below={isBelow(row.consistencyBps, aim) ? "true" : undefined}
                >
                  <th scope="row">
                    {row.courseName} <span className="aip-muted">{row.code}</span>
                  </th>
                  <td className="aip-num">
                    {t(`${P}.uploads.daysValue`, {
                      uploaded: formatNumber(row.uploadDays),
                      days: formatNumber(row.schoolDays),
                    })}
                  </td>
                  <td className="aip-num">
                    <PercentMeter
                      small
                      valueBps={row.consistencyBps}
                      marks={aim !== null ? [aim] : []}
                      tone={isBelow(row.consistencyBps, aim) ? "warning" : "success"}
                    />{" "}
                    {value(row.consistencyBps)}
                  </td>
                  <td>{below(row.consistencyBps)}</td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>
    </>
  );
}
