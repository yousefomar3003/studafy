import { ApiError } from "@studafy/api-client";
import { Button, Card, Input, Select, useToast } from "@studafy/ui";
import { useState } from "react";
import { Link, useParams } from "react-router-dom";

import { useFormatters, useTranslation } from "../../../lib/i18n";
import {
  ConversionSection,
  EarningsSum,
  EntryDestination,
  ShareFormula,
  ShareStatusPill,
  StatRow,
  UploadTables,
  useConversionSource,
  useCurrencyMoney,
  useDay,
  usePercent,
} from "../../ai-programme/components";
import {
  REVENUE_SHARE_STATUSES,
  useRecomputeRevenueShare,
  useRecordRevenueSharePayout,
  useRemeasureConversion,
  usePlatformLedgerQuery,
  usePlatformLicenceShareQuery,
  usePlatformProgrammeQuery,
  usePlatformUploadsQuery,
} from "../../ai-programme/queries";
import { PlatformPageHeader } from "../PlatformNav";

import { fromMinor, todayIso, useMoney } from "./format";

import type { StatItem } from "../../ai-programme/components";
import type {
  LicenceRevenueShare,
  PlatformProgrammeDashboard,
  RevenueShareLedger,
  RevenueShareStatus,
} from "../../ai-programme/queries";

import "../platform.css";
import "./licensing.css";

const P = "platformLicensing.programmeSchool";

function errorText(error: unknown): string | undefined {
  return error instanceof ApiError ? (error.detail ?? error.title) : undefined;
}

/**
 * One school in the Student AI programme (`/portal/platform/ai-programme/schools/:schoolId`,
 * platform:read; changes platform:manage): its standing and what Studafy keeps per seat; the
 * licence's conversion measurements, with a re-measure (and its reason) before the lock; the ledger,
 * filtered by status, with each share's working; recomputing pending shares; payouts, and recording
 * one when shares are due to be paid out; and upload consistency per teacher and class. Links to
 * the school's licence and to its programme settings.
 */
export default function AiProgrammeSchoolPage() {
  const { t } = useTranslation();
  const { schoolId = "" } = useParams<{ schoolId: string }>();
  const summary = usePlatformProgrammeQuery(schoolId);
  const data = summary.data;

  return (
    <>
      <PlatformPageHeader
        title={data ? t(`${P}.title`, { school: data.schoolName }) : t(`${P}.titleLoading`)}
        description={t(`${P}.description`)}
      />
      <ul className="aip-links" aria-label={t(`${P}.linksLabel`)}>
        <li>
          <Link to="/portal/platform/ai-programme/schools">{t(`${P}.backToSchools`)}</Link>
        </li>
        <li>
          <Link to={`/portal/platform/schools/${schoolId}`}>{t(`${P}.licenceLink`)}</Link>
        </li>
        <li>
          <Link to={`/portal/platform/ai-programme?schoolId=${schoolId}`}>
            {t(`${P}.settingsLink`)}
          </Link>
        </li>
      </ul>
      {summary.isPending ? <p role="status">{t("site.common.loading")}</p> : null}
      {summary.isError ? <p role="alert">{t("platformLicensing.common.loadError")}</p> : null}
      {data ? (
        <div className="aip-stack">
          <Headline dashboard={data} />
          <ConversionSection dashboard={data} headingId="console-conversion" />
          {data.license ? <Measurements schoolId={schoolId} licenseId={data.license.id} /> : null}
          <section className="aip-section" aria-labelledby="console-earnings">
            <h2 id="console-earnings">{t(`${P}.earningsTitle`)}</h2>
            <EarningsSum
              earnings={data.earnings}
              currencyCode={data.currencyCode}
              minorUnit={data.minorUnit}
              yearName={data.academicYear?.name ?? null}
            />
          </section>
          <Ledger schoolId={schoolId} />
          <Uploads schoolId={schoolId} />
        </div>
      ) : null}
    </>
  );
}

function Headline({ dashboard }: { dashboard: PlatformProgrammeDashboard }) {
  const { t } = useTranslation();
  const { formatNumber } = useFormatters();
  const pct = usePercent();
  const source = useConversionSource();
  const m = useCurrencyMoney(dashboard.currencyCode, dashboard.minorUnit);
  const share = dashboard.earnings.share;
  const items: StatItem[] = [
    {
      key: "students",
      label: t(`${P}.stats.students`),
      value: t(`${P}.stats.studentsValue`, {
        optedIn: formatNumber(dashboard.students.optedIn),
        enrolled: formatNumber(dashboard.students.enrolled),
      }),
      hint: dashboard.license
        ? t(`${P}.stats.seats`, { seats: formatNumber(dashboard.license.studentSeats) })
        : t(`${P}.stats.noLicence`),
    },
    {
      key: "conversion",
      label: t(`${P}.stats.conversion`),
      value: dashboard.conversion ? pct(dashboard.conversion.conversionBps) : "—",
      hint: dashboard.conversion ? source(dashboard.conversion) : undefined,
    },
    {
      key: "uploads",
      label: t(`${P}.stats.uploads`),
      value:
        dashboard.uploads?.consistencyBps != null ? pct(dashboard.uploads.consistencyBps) : "—",
    },
    {
      key: "rate",
      label: t(`${P}.stats.rate`),
      value: dashboard.rate ? pct(dashboard.rate.totalBps) : "—",
      hint: dashboard.rate
        ? t("schoolLicense.programme.stats.rateHint", {
            conversion: pct(dashboard.rate.conversionShareBps),
            bonus: pct(dashboard.rate.bonusBps),
          })
        : undefined,
    },
    {
      key: "owed",
      label: t(`${P}.stats.owed`),
      value: m(share.owedMinor + share.payoutDueMinor),
      hint: t(`${P}.stats.owedHint`, {
        pending: m(share.pendingMinor),
        payoutDue: m(share.payoutDueMinor),
      }),
      tone: share.payoutDueMinor > 0 ? "warning" : undefined,
    },
    {
      key: "given",
      label: t(`${P}.stats.given`),
      value: m(share.creditedMinor + share.paidOutMinor),
      hint: t(`${P}.stats.givenHint`, {
        credited: m(share.creditedMinor),
        paid: m(share.paidOutMinor),
        forfeited: m(share.forfeitedMinor),
      }),
    },
    {
      key: "net",
      label: t(`${P}.stats.net`),
      value:
        dashboard.studafyNet.perSeatMinor === null ? "—" : m(dashboard.studafyNet.perSeatMinor),
      hint: t(`${P}.stats.netHint`, {
        collected: m(share.collectedMinor),
        net: m(dashboard.studafyNet.netMinor),
        seats: formatNumber(dashboard.studafyNet.seats),
      }),
      tone: "success",
    },
  ];
  return <StatRow items={items} label={t(`${P}.stats.label`)} />;
}

// ---------------------------------------------------------------------------------------------------
// Conversion measurements
// ---------------------------------------------------------------------------------------------------

function Measurements({ schoolId, licenseId }: { schoolId: string; licenseId: string }) {
  const { t } = useTranslation();
  const { formatNumber } = useFormatters();
  const pct = usePercent();
  const day = useDay();
  const licence = usePlatformLicenceShareQuery(schoolId, licenseId);
  const data = licence.data;
  return (
    <section className="aip-section" aria-labelledby="console-measurements">
      <h2 id="console-measurements">{t(`${P}.measurements.title`)}</h2>
      <p className="aip-muted">{t(`${P}.measurements.help`)}</p>
      {licence.isPending ? <p role="status">{t("site.common.loading")}</p> : null}
      {licence.isError ? <p role="alert">{t("platformLicensing.common.loadError")}</p> : null}
      {data ? (
        <>
          <div className="platform-table-scroll">
            <table className="platform-table" data-testid="measurements">
              <caption className="sf-visually-hidden">{t(`${P}.measurements.title`)}</caption>
              <thead>
                <tr>
                  <th scope="col">{t(`${P}.measurements.period`)}</th>
                  <th scope="col">{t(`${P}.measurements.measureOn`)}</th>
                  <th scope="col">{t(`${P}.measurements.result`)}</th>
                  <th scope="col">{t(`${P}.measurements.history`)}</th>
                </tr>
              </thead>
              <tbody>
                {data.periods.map((period) => (
                  <tr key={period.periodStart}>
                    <td>{day(period.periodStart)}</td>
                    <td>{day(period.measureOn)}</td>
                    <td>
                      {period.locked ? (
                        <span className="platform-cell-stack">
                          <span>
                            {t(`${P}.measurements.lockedValue`, {
                              optedIn: formatNumber(period.locked.optedInCount),
                              enrolled: formatNumber(period.locked.enrolledCount),
                              conversion: pct(period.locked.conversionBps),
                              share: pct(period.locked.conversionShareBps),
                            })}
                          </span>
                          <span className="aip-pill" data-tone="success">
                            {t(`${P}.measurements.locked`)}
                          </span>
                        </span>
                      ) : (
                        <span className="aip-pill" data-tone="warning">
                          {t(`${P}.measurements.notLocked`)}
                        </span>
                      )}
                    </td>
                    <td>
                      {remeasures(period.measurements).length === 0 ? (
                        "—"
                      ) : (
                        <ul className="platform-breakdown">
                          {remeasures(period.measurements).map((s) => (
                            <li key={s.id}>
                              {t(`${P}.measurements.remeasured`, {
                                date: day(s.asOf),
                                conversion: pct(s.conversionBps),
                                reason: s.reason ?? "",
                              })}
                            </li>
                          ))}
                        </ul>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <RemeasureForm schoolId={schoolId} licence={data} />
        </>
      ) : null}
    </section>
  );
}

type Snapshot = NonNullable<LicenceRevenueShare["periods"][number]["measurements"][number]>;

/** A period's re-measures before its lock, newest first. */
function remeasures(measurements: LicenceRevenueShare["periods"][number]["measurements"]) {
  return measurements.filter((s): s is Snapshot => s !== null && !s.locked);
}

function RemeasureForm({ schoolId, licence }: { schoolId: string; licence: LicenceRevenueShare }) {
  const { t } = useTranslation();
  const { show } = useToast();
  const day = useDay();
  const remeasure = useRemeasureConversion();
  const [reason, setReason] = useState("");
  const current = licence.periods.find((p) => p.periodStart === licence.rate.periodStart);
  if (!current || current.locked) {
    return <p className="aip-muted">{t(`${P}.measurements.lockedNote`)}</p>;
  }
  return (
    <Card as="section" aria-label={t(`${P}.measurements.remeasureTitle`)}>
      <Card.Body>
        <form
          className="aip-form"
          onSubmit={(event) => {
            event.preventDefault();
            if (reason.trim() === "") return;
            remeasure.mutate(
              {
                schoolId,
                licenseId: licence.licenseId,
                reason: reason.trim(),
                periodStart: current.periodStart,
              },
              {
                onSuccess: () => {
                  setReason("");
                  show({ variant: "success", title: t(`${P}.measurements.done`) });
                },
                onError: (error) =>
                  show({
                    variant: "error",
                    title: t("platformLicensing.common.saveError"),
                    description: errorText(error),
                  }),
              },
            );
          }}
        >
          <Input
            label={t(`${P}.measurements.reason`)}
            helperText={t(`${P}.measurements.reasonHelp`, { date: day(current.measureOn) })}
            value={reason}
            maxLength={1000}
            required
            onChange={(event) => setReason(event.target.value)}
          />
          <div>
            <Button
              type="submit"
              variant="secondary"
              disabled={reason.trim() === ""}
              loading={remeasure.isPending}
            >
              {t(`${P}.measurements.remeasure`)}
            </Button>
          </div>
        </form>
      </Card.Body>
    </Card>
  );
}

// ---------------------------------------------------------------------------------------------------
// The ledger and payouts
// ---------------------------------------------------------------------------------------------------

function Ledger({ schoolId }: { schoolId: string }) {
  const { t } = useTranslation();
  const { show } = useToast();
  const { formatNumber } = useFormatters();
  const money = useMoney();
  const day = useDay();
  const [status, setStatus] = useState<RevenueShareStatus | "">("");
  const ledger = usePlatformLedgerQuery(schoolId, status);
  const recompute = useRecomputeRevenueShare();
  const data = ledger.data;

  return (
    <section className="aip-section" aria-labelledby="console-ledger">
      <div className="platform-header__row">
        <h2 id="console-ledger">{t(`${P}.ledger.title`)}</h2>
        <Button
          type="button"
          variant="secondary"
          loading={recompute.isPending}
          onClick={() =>
            recompute.mutate(schoolId, {
              onSuccess: (result) =>
                show({
                  variant: "success",
                  title: t(`${P}.ledger.recomputed`),
                  description: t(`${P}.ledger.recomputedDetail`, {
                    recorded: formatNumber(result.recorded),
                    resolved: formatNumber(result.resolved),
                    settled: formatNumber(result.settled),
                  }),
                }),
              onError: (error) =>
                show({
                  variant: "error",
                  title: t("platformLicensing.common.saveError"),
                  description: errorText(error),
                }),
            })
          }
        >
          {t(`${P}.ledger.recompute`)}
        </Button>
      </div>
      <p className="aip-muted">{t(`${P}.ledger.help`)}</p>
      <div className="aip-toolbar">
        <Select
          label={t(`${P}.ledger.statusFilter`)}
          value={status}
          onChange={(value) => setStatus(value)}
          options={[
            { value: "" as const, label: t(`${P}.ledger.allStatuses`) },
            ...REVENUE_SHARE_STATUSES.map((value) => ({
              value,
              label: t(`schoolLicense.programme.status.${value}`),
            })),
          ]}
        />
      </div>
      {ledger.isPending ? <p role="status">{t("site.common.loading")}</p> : null}
      {ledger.isError ? <p role="alert">{t("platformLicensing.common.loadError")}</p> : null}
      {data && data.entries.length === 0 ? (
        <p className="platform-muted">{t(`${P}.ledger.empty`)}</p>
      ) : null}
      {data && data.entries.length > 0 ? (
        <div className="platform-table-scroll">
          <table className="platform-table" data-testid="ledger">
            <caption className="sf-visually-hidden">{t(`${P}.ledger.title`)}</caption>
            <thead>
              <tr>
                <th scope="col">{t(`${P}.ledger.period`)}</th>
                <th scope="col">{t(`${P}.ledger.payment`)}</th>
                <th scope="col">{t(`${P}.ledger.share`)}</th>
                <th scope="col">{t(`${P}.ledger.status`)}</th>
                <th scope="col">{t(`${P}.ledger.destination`)}</th>
              </tr>
            </thead>
            <tbody>
              {data.entries.map((entry) => {
                const m = (amount: number) => money(amount, entry.currencyCode, entry.minorUnit);
                return (
                  <tr key={entry.id}>
                    <td>
                      {t("schoolLicense.programme.periodValue", {
                        from: day(entry.periodFrom),
                        to: day(entry.periodTo),
                      })}
                    </td>
                    <td>
                      <div className="platform-cell-stack">
                        <Link to={`/portal/platform/payments/${schoolId}/${entry.invoiceId}`}>
                          {t(`${P}.ledger.instalment`, {
                            number: entry.invoiceNumber,
                            position: formatNumber(entry.instalmentPosition),
                          })}
                        </Link>
                        <span className="platform-muted">
                          {t(`${P}.ledger.received`, { date: day(entry.receivedOn) })}
                        </span>
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
                    </td>
                    <td>
                      <ShareStatusPill status={entry.status} />
                    </td>
                    <td>
                      <EntryDestination entry={entry} />
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      ) : null}
      {data ? <Payouts schoolId={schoolId} ledger={data} /> : null}
    </section>
  );
}

function Payouts({ schoolId, ledger }: { schoolId: string; ledger: RevenueShareLedger }) {
  const { t } = useTranslation();
  const money = useMoney();
  const day = useDay();
  const due = ledger.totals.filter((total) => total.payoutDueMinor > 0);
  return (
    <>
      <h3>{t(`${P}.payouts.title`)}</h3>
      {due.map((total) => (
        <PayoutForm
          key={total.currencyCode}
          schoolId={schoolId}
          currencyCode={total.currencyCode}
          minorUnit={total.minorUnit}
          amountMinor={total.payoutDueMinor}
        />
      ))}
      {due.length === 0 ? <p className="platform-muted">{t(`${P}.payouts.nothingDue`)}</p> : null}
      {ledger.payouts.length === 0 ? (
        <p className="platform-muted">{t(`${P}.payouts.none`)}</p>
      ) : (
        <div className="platform-table-scroll">
          <table className="platform-table" data-testid="payout-list">
            <caption className="sf-visually-hidden">{t(`${P}.payouts.title`)}</caption>
            <thead>
              <tr>
                <th scope="col">{t(`${P}.payouts.paidOn`)}</th>
                <th scope="col">{t(`${P}.payouts.reference`)}</th>
                <th scope="col" className="licensing-amount">
                  {t(`${P}.payouts.amount`)}
                </th>
                <th scope="col">{t(`${P}.payouts.note`)}</th>
              </tr>
            </thead>
            <tbody>
              {ledger.payouts.map((payout) => (
                <tr key={payout.id}>
                  <td>{day(payout.paidOn)}</td>
                  <td>{payout.reference}</td>
                  <td className="licensing-amount">
                    {money(payout.amountMinor, payout.currencyCode)}
                  </td>
                  <td>{payout.note ?? "—"}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </>
  );
}

/** Record the transfer of everything due to be paid out in one currency (the amount as shown). */
function PayoutForm({
  schoolId,
  currencyCode,
  minorUnit,
  amountMinor,
}: {
  schoolId: string;
  currencyCode: string;
  minorUnit: number;
  amountMinor: number;
}) {
  const { t } = useTranslation();
  const { show } = useToast();
  const money = useMoney();
  const record = useRecordRevenueSharePayout();
  const [reference, setReference] = useState("");
  const [paidOn, setPaidOn] = useState(todayIso());
  const [note, setNote] = useState("");
  const amount = money(amountMinor, currencyCode, minorUnit);
  return (
    <Card as="section" aria-label={t(`${P}.payouts.recordTitle`, { amount })}>
      <Card.Body>
        <p data-testid="payout-due">{t(`${P}.payouts.due`, { amount })}</p>
        <form
          className="aip-form"
          onSubmit={(event) => {
            event.preventDefault();
            if (reference.trim() === "" || paidOn === "") return;
            record.mutate(
              {
                schoolId,
                currencyCode,
                amountMinor,
                reference: reference.trim(),
                paidOn,
                note: note.trim() || null,
              },
              {
                onSuccess: () => {
                  setReference("");
                  setNote("");
                  show({ variant: "success", title: t(`${P}.payouts.recorded`, { amount }) });
                },
                onError: (error) =>
                  show({
                    variant: "error",
                    title: t("platformLicensing.common.saveError"),
                    description: errorText(error),
                  }),
              },
            );
          }}
        >
          <Input
            label={t(`${P}.payouts.amount`)}
            value={fromMinor(amountMinor, minorUnit)}
            suffix={currencyCode}
            readOnly
          />
          <Input
            label={t(`${P}.payouts.reference`)}
            value={reference}
            maxLength={200}
            required
            onChange={(event) => setReference(event.target.value)}
          />
          <Input
            label={t(`${P}.payouts.paidOn`)}
            type="date"
            value={paidOn}
            required
            onChange={(event) => setPaidOn(event.target.value)}
          />
          <Input
            label={t(`${P}.payouts.note`)}
            value={note}
            maxLength={1000}
            onChange={(event) => setNote(event.target.value)}
          />
          <div>
            <Button
              type="submit"
              variant="primary"
              disabled={reference.trim() === "" || paidOn === ""}
              loading={record.isPending}
            >
              {t(`${P}.payouts.record`)}
            </Button>
          </div>
        </form>
      </Card.Body>
    </Card>
  );
}

function Uploads({ schoolId }: { schoolId: string }) {
  const { t } = useTranslation();
  const uploads = usePlatformUploadsQuery(schoolId);
  return (
    <section className="aip-section" aria-labelledby="console-uploads">
      <h2 id="console-uploads">{t("schoolLicense.programme.uploads.title")}</h2>
      {uploads.isPending ? <p role="status">{t("site.common.loading")}</p> : null}
      {uploads.isError ? <p role="alert">{t("platformLicensing.common.loadError")}</p> : null}
      {uploads.data ? <UploadTables report={uploads.data} showTeachers /> : null}
    </section>
  );
}
