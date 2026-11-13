import { ApiError } from "@studafy/api-client";
import { Button, Card, Checkbox, Input, Select, useToast } from "@studafy/ui";
import { useMemo, useState } from "react";
import { Link, useSearchParams } from "react-router-dom";

import { useFormatters, useTranslation } from "../../../lib/i18n";
import { PlatformPageHeader } from "../PlatformNav";
import { useSchoolDetailQuery, useSchoolsListQuery } from "../queries";

import { AUDIENCES } from "./constants";
import { bpsToPercent, currencyMinorUnit, toMinor, useMoney } from "./format";
import { useCreateQuote, useQuoteAction } from "./mutations";
import {
  useCalculationQuery,
  useSchoolLicensesQuery,
  useSchoolQuotesQuery,
  useTiersQuery,
} from "./queries";
import { useDebounced } from "./useDebounced";

import "../platform.css";
import "./licensing.css";

import type { QuoteAction } from "./mutations";
import type {
  ConsoleTier,
  LicenseAudience,
  PlatformLicense,
  PriceLine,
  QuoteCalculateBody,
  QuoteCalculation,
  Quote,
} from "./queries";

type QuoteKind = QuoteCalculateBody["kind"];
type SeatLine = Extract<PriceLine, { kind: "seats" }>;

const KINDS: readonly QuoteKind[] = ["new", "seat_increase", "extension"];
const DEBOUNCE_MS = 300;

interface AudienceState {
  planId: string;
  seats: string;
}

/**
 * The calculator and a school's quotes (`/portal/platform/quotes`). Pick a school and terms; the
 * breakdown is priced live by the API (nothing is saved) -- list price, volume and duration
 * discounts, overlap credits, the adjustment, the price per seat before and after, what the school
 * saves, and how far the next volume bracket is. "Save as quote" stores it as a draft to send.
 *
 * `?schoolId=&licenseId=&kind=` prefill it: the school page's "change seats or tiers" opens a seat
 * increase for a license in force, or a new term re-pricing a draft or awaiting-payment one.
 */
export default function CalculatorPage() {
  const { t } = useTranslation();
  const { show } = useToast();
  const [params, setParams] = useSearchParams();
  const schoolId = params.get("schoolId");
  const tiers = useTiersQuery();
  const school = useSchoolDetailQuery(schoolId ?? "", schoolId !== null);
  const licenses = useSchoolLicensesQuery(schoolId);
  const createQuote = useCreateQuote();

  const [kind, setKind] = useState<QuoteKind>(
    (KINDS as readonly string[]).includes(params.get("kind") ?? "")
      ? (params.get("kind") as QuoteKind)
      : "new",
  );
  const [licenseId, setLicenseId] = useState(params.get("licenseId") ?? "");
  const [currency, setCurrency] = useState("");
  const [months, setMonths] = useState("12");
  const [startsAt, setStartsAt] = useState("");
  const [familyPlus, setFamilyPlus] = useState(false);
  const [withCredits, setWithCredits] = useState(true);
  const [audiences, setAudiences] = useState<Record<LicenseAudience, AudienceState>>({
    student: { planId: "", seats: "" },
    teacher: { planId: "", seats: "" },
    parent: { planId: "", seats: "" },
  });
  const [adjustment, setAdjustment] = useState("");
  const [adjustmentReason, setAdjustmentReason] = useState("");
  const [notes, setNotes] = useState("");

  const changesLicense = kind !== "new";
  // A change prices a license in force; a new term may instead re-price a draft or awaiting-payment
  // license (accepting the quote then rewrites its terms rather than creating another license).
  const pickable = (licenses.data ?? []).filter((l) =>
    changesLicense
      ? l.status === "active" || l.status === "suspended"
      : l.status === "draft" || l.status === "awaiting_payment",
  );
  const license = pickable.find((l) => l.id === licenseId) ?? null;

  // A picked license seeds the terms: its currency, tiers, seats and Family+ (and, for a new term,
  // its start).
  const [seededLicense, setSeededLicense] = useState<string | null>(null);
  if (license && seededLicense !== license.id) {
    setSeededLicense(license.id);
    setCurrency(license.currencyCode);
    setFamilyPlus(license.includeFamilyPlus);
    if (!changesLicense) setStartsAt(license.startsAt.slice(0, 10));
    setAudiences(
      Object.fromEntries(
        AUDIENCES.map((audience) => {
          const row = license.audiences.find((a) => a.audience === audience);
          return [audience, { planId: row?.tier?.id ?? "", seats: String(row?.purchased ?? 0) }];
        }),
      ) as Record<LicenseAudience, AudienceState>,
    );
  }

  const activeTiers = (tiers.data ?? []).filter((tier) => tier.isActive);
  const currencies = [
    ...new Set(
      activeTiers.flatMap((tier) =>
        tier.prices.filter((p) => p.isActive).map((p) => p.currencyCode),
      ),
    ),
  ].sort();
  const effectiveCurrency =
    currency || (license?.currencyCode ?? school.data?.currencyCode ?? currencies[0] ?? "");

  const adjustmentMinor =
    adjustment.trim() === "" ? 0 : signedMinor(adjustment, currencyMinorUnit(effectiveCurrency));
  const body = useMemo<QuoteCalculateBody | null>(() => {
    if (changesLicense && !license) return null;
    if (!effectiveCurrency) return null;
    if (adjustmentMinor === null) return null;
    const monthsNumber = Number(months);
    if (kind !== "seat_increase" && (!Number.isInteger(monthsNumber) || monthsNumber < 1))
      return null;
    const audienceInput = (audience: LicenseAudience) => {
      const row = audiences[audience];
      if (audience === "parent" && !familyPlus) return undefined;
      const seats = Number(row.seats || "0");
      if (!Number.isInteger(seats) || seats < 0) return undefined;
      return seats > 0 || row.planId ? { planId: row.planId || null, seats } : undefined;
    };
    return {
      schoolId: schoolId ?? undefined,
      kind,
      licenseId: license?.id,
      currencyCode: effectiveCurrency,
      months: kind === "seat_increase" ? undefined : monthsNumber,
      startsAt:
        kind === "new" && startsAt ? new Date(`${startsAt}T00:00:00Z`).toISOString() : undefined,
      includeFamilyPlus: familyPlus,
      student: audienceInput("student"),
      teacher: audienceInput("teacher"),
      parent: audienceInput("parent"),
      includeOverlapCredits: withCredits,
      adjustment:
        adjustmentMinor !== 0
          ? { amountMinor: adjustmentMinor, reason: adjustmentReason.trim() }
          : null,
    };
  }, [
    adjustmentMinor,
    adjustmentReason,
    audiences,
    changesLicense,
    effectiveCurrency,
    familyPlus,
    kind,
    license,
    months,
    schoolId,
    startsAt,
    withCredits,
  ]);
  const settledBody = useDebounced(body, DEBOUNCE_MS);
  const calculation = useCalculationQuery(settledBody);
  const reasonMissing =
    adjustmentMinor !== 0 && adjustmentMinor !== null && adjustmentReason.trim() === "";

  function save() {
    if (!schoolId || !body || reasonMissing) return;
    createQuote.mutate(
      { schoolId, body: { ...body, notes: notes.trim() || null } },
      {
        onSuccess: () =>
          show({ variant: "success", title: t("platformLicensing.calculator.saved") }),
        onError: (error) =>
          show({
            variant: "error",
            title: t("platformLicensing.calculator.saveError"),
            description: error instanceof ApiError ? (error.detail ?? error.title) : undefined,
          }),
      },
    );
  }

  const setAudience = (audience: LicenseAudience, patch: Partial<AudienceState>) =>
    setAudiences((prev) => ({ ...prev, [audience]: { ...prev[audience], ...patch } }));

  return (
    <>
      <PlatformPageHeader
        title={t("platformLicensing.calculator.title")}
        description={t("platformLicensing.calculator.description")}
      />

      <SchoolPicker
        schoolId={schoolId}
        schoolName={school.data?.name ?? null}
        onPick={(id) => setParams(id ? { schoolId: id } : {})}
      />

      <div className="licensing-calculator">
        <Card as="section" aria-labelledby="calculator-terms">
          <Card.Header>
            <h2 id="calculator-terms">{t("platformLicensing.calculator.termsTitle")}</h2>
          </Card.Header>
          <Card.Body>
            <div className="licensing-form-grid">
              <Select
                label={t("platformLicensing.calculator.kindLabel")}
                value={kind}
                onChange={setKind}
                options={KINDS.map((value) => ({
                  value,
                  label: t(`platformLicensing.quoteKind.${value}`),
                }))}
              />
              {changesLicense ? (
                <Select
                  label={t("platformLicensing.calculator.licenseLabel")}
                  value={license?.id ?? ""}
                  onChange={setLicenseId}
                  placeholder={t("platformLicensing.calculator.licensePlaceholder")}
                  options={pickable.map((l) => ({ value: l.id, label: licenseLabel(l, t) }))}
                />
              ) : pickable.length > 0 ? (
                <Select
                  label={t("platformLicensing.calculator.licenseLabel")}
                  value={license?.id ?? ""}
                  onChange={setLicenseId}
                  options={[
                    { value: "", label: t("platformLicensing.calculator.newLicenseOption") },
                    ...pickable.map((l) => ({ value: l.id, label: licenseLabel(l, t) })),
                  ]}
                />
              ) : null}
              <Select
                label={t("platformLicensing.calculator.currencyLabel")}
                value={effectiveCurrency}
                onChange={setCurrency}
                disabled={license !== null}
                options={currencies.map((code) => ({ value: code, label: code }))}
              />
              {kind === "seat_increase" ? null : (
                <Input
                  label={
                    kind === "extension"
                      ? t("platformLicensing.calculator.extendMonthsLabel")
                      : t("platformLicensing.calculator.monthsLabel")
                  }
                  type="number"
                  min={1}
                  max={120}
                  value={months}
                  onChange={(event) => setMonths(event.target.value)}
                />
              )}
              {kind === "new" ? (
                <Input
                  label={t("platformLicensing.calculator.startsLabel")}
                  type="date"
                  value={startsAt}
                  onChange={(event) => setStartsAt(event.target.value)}
                />
              ) : null}
            </div>

            <Checkbox
              label={t("platformLicensing.calculator.familyPlusLabel")}
              checked={familyPlus}
              onChange={(event) => setFamilyPlus(event.target.checked)}
            />

            <h3>{t("platformLicensing.calculator.seatsHeading")}</h3>
            {AUDIENCES.filter((a) => a !== "parent" || familyPlus).map((audience) => (
              <AudienceRow
                key={audience}
                audience={audience}
                tiers={activeTiers.filter((tier) => tier.audience === audience)}
                value={audiences[audience]}
                tierLocked={
                  kind !== "new" &&
                  Boolean(license?.audiences.find((a) => a.audience === audience)?.tier)
                }
                seatsLocked={kind === "extension"}
                onChange={(patch) => setAudience(audience, patch)}
              />
            ))}
            {kind === "seat_increase" ? (
              <p className="platform-muted">{t("platformLicensing.calculator.seatIncreaseHelp")}</p>
            ) : null}

            <h3>{t("platformLicensing.calculator.adjustmentHeading")}</h3>
            <div className="licensing-form-grid">
              <Input
                label={t("platformLicensing.calculator.adjustmentLabel", {
                  currency: effectiveCurrency,
                })}
                helperText={t("platformLicensing.calculator.adjustmentHelp")}
                value={adjustment}
                inputMode="decimal"
                error={
                  adjustmentMinor === null
                    ? t("platformLicensing.calculator.amountError")
                    : undefined
                }
                onChange={(event) => setAdjustment(event.target.value)}
              />
              <Input
                label={t("platformLicensing.calculator.reasonLabel")}
                value={adjustmentReason}
                error={reasonMissing ? t("platformLicensing.calculator.reasonRequired") : undefined}
                onChange={(event) => setAdjustmentReason(event.target.value)}
              />
            </div>
            <Checkbox
              label={t("platformLicensing.calculator.creditsLabel")}
              checked={withCredits}
              onChange={(event) => setWithCredits(event.target.checked)}
            />
          </Card.Body>
        </Card>

        <div className="platform-stack">
          <Breakdown
            calculation={calculation.data ?? null}
            pending={calculation.isFetching}
            error={
              calculation.error instanceof ApiError
                ? (calculation.error.detail ?? calculation.error.title)
                : calculation.isError
                  ? t("platformLicensing.calculator.priceError")
                  : null
            }
          />
          {calculation.data ? <NextBrackets calculation={calculation.data} /> : null}
          <Card as="section" aria-labelledby="calculator-save">
            <Card.Header>
              <h2 id="calculator-save">{t("platformLicensing.calculator.saveTitle")}</h2>
            </Card.Header>
            <Card.Body>
              <Input
                label={t("platformLicensing.calculator.notesLabel")}
                value={notes}
                onChange={(event) => setNotes(event.target.value)}
              />
            </Card.Body>
            <Card.Footer>
              <Button
                variant="primary"
                disabled={!schoolId || !body || reasonMissing || !calculation.data}
                loading={createQuote.isPending}
                onClick={save}
              >
                {t("platformLicensing.calculator.save")}
              </Button>
              {!schoolId ? (
                <span className="platform-muted">
                  {t("platformLicensing.calculator.pickSchoolFirst")}
                </span>
              ) : null}
            </Card.Footer>
          </Card>
        </div>
      </div>

      {schoolId ? <SchoolQuotes schoolId={schoolId} /> : null}
    </>
  );
}

/** "12.50" or "-12.50" -> signed minor units; null when not an amount. */
function signedMinor(value: string, minorUnit: number): number | null {
  const trimmed = value.trim();
  const negative = trimmed.startsWith("-");
  const amount = toMinor(negative ? trimmed.slice(1) : trimmed, minorUnit);
  if (amount === null) return null;
  return negative ? -amount : amount;
}

function licenseLabel(license: PlatformLicense, t: ReturnType<typeof useTranslation>["t"]): string {
  return t("platformLicensing.calculator.licenseOption", {
    status: t(`platformLicensing.licenseStatus.${license.status}`),
    from: license.startsAt.slice(0, 10),
    to: license.endsAt.slice(0, 10),
  });
}

function SchoolPicker({
  schoolId,
  schoolName,
  onPick,
}: {
  schoolId: string | null;
  schoolName: string | null;
  onPick: (schoolId: string | null) => void;
}) {
  const { t } = useTranslation();
  const [search, setSearch] = useState("");
  const settled = useDebounced(search.trim(), DEBOUNCE_MS);
  const results = useSchoolsListQuery({ search: settled, status: "", page: 0 });

  if (schoolId) {
    return (
      <div className="platform-toolbar licensing-row">
        <p>
          {t("platformLicensing.calculator.schoolSelected")}{" "}
          <Link to={`/portal/platform/schools/${schoolId}`}>{schoolName ?? schoolId}</Link>
        </p>
        <Button variant="tertiary" onClick={() => onPick(null)}>
          {t("platformLicensing.calculator.changeSchool")}
        </Button>
      </div>
    );
  }
  return (
    <div className="platform-toolbar">
      <Input
        label={t("platformLicensing.calculator.schoolSearch")}
        helperText={t("platformLicensing.calculator.schoolSearchHelp")}
        type="search"
        value={search}
        onChange={(event) => setSearch(event.target.value)}
      />
      {settled !== "" ? (
        <ul
          className="platform-breakdown"
          aria-label={t("platformLicensing.calculator.schoolResults")}
        >
          {(results.data?.schools ?? []).map((school) => (
            <li key={school.id}>
              <span>{school.name}</span>
              <Button variant="tertiary" onClick={() => onPick(school.id)}>
                {t("platformLicensing.calculator.pickSchool")}
              </Button>
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}

function AudienceRow({
  audience,
  tiers,
  value,
  tierLocked,
  seatsLocked,
  onChange,
}: {
  audience: LicenseAudience;
  tiers: ConsoleTier[];
  value: AudienceState;
  tierLocked: boolean;
  seatsLocked: boolean;
  onChange: (patch: Partial<AudienceState>) => void;
}) {
  const { t } = useTranslation();
  const audienceName = t(`platformLicensing.audience.${audience}`);
  return (
    <div className="licensing-audience">
      <span className="licensing-audience__name">{audienceName}</span>
      <Select
        label={t("platformLicensing.calculator.tierLabel", { audience: audienceName })}
        value={value.planId}
        onChange={(planId) => onChange({ planId })}
        disabled={tierLocked}
        placeholder={t("platformLicensing.calculator.tierPlaceholder")}
        options={tiers.map((tier) => ({ value: tier.id, label: tier.displayName }))}
      />
      <Input
        label={t("platformLicensing.calculator.seatsLabel", { audience: audienceName })}
        type="number"
        min={0}
        value={value.seats}
        disabled={seatsLocked}
        onChange={(event) => onChange({ seats: event.target.value })}
      />
    </div>
  );
}

function Breakdown({
  calculation,
  pending,
  error,
}: {
  calculation: QuoteCalculation | null;
  pending: boolean;
  error: string | null;
}) {
  const { t } = useTranslation();
  const { formatNumber } = useFormatters();
  const money = useMoney();
  const currency = calculation?.breakdown.currencyCode ?? "";
  const m = (amount: number) => money(amount, currency);

  return (
    <Card as="section" aria-labelledby="calculator-breakdown" aria-busy={pending}>
      <Card.Header>
        <h2 id="calculator-breakdown">{t("platformLicensing.calculator.breakdownTitle")}</h2>
      </Card.Header>
      <Card.Body>
        {error ? <p role="alert">{error}</p> : null}
        {!calculation && !error ? (
          <p className="platform-muted">{t("platformLicensing.calculator.breakdownEmpty")}</p>
        ) : null}
        {calculation ? (
          <>
            <p className="platform-muted">
              {calculation.prorateDays
                ? t("platformLicensing.calculator.period.days", { days: calculation.prorateDays })
                : t("platformLicensing.calculator.period.months", { months: calculation.months })}
            </p>
            <table className="platform-table">
              <caption className="sf-visually-hidden">
                {t("platformLicensing.calculator.breakdownTitle")}
              </caption>
              <tbody>
                {calculation.breakdown.lines.map((line, index) =>
                  line.kind === "seats" ? (
                    <SeatRows key={index} line={line} currency={currency} />
                  ) : line.kind === "overlap_credit" ? (
                    <tr key={index}>
                      <th scope="row">{line.description}</th>
                      <td className="licensing-amount licensing-negative">{m(line.amountMinor)}</td>
                    </tr>
                  ) : (
                    <tr key={index}>
                      <th scope="row">
                        {t("platformLicensing.calculator.adjustmentLine", { reason: line.reason })}
                      </th>
                      <td className="licensing-amount">{m(line.amountMinor)}</td>
                    </tr>
                  ),
                )}
                <tr>
                  <th scope="row">{t("platformLicensing.calculator.listTotal")}</th>
                  <td className="licensing-amount">{m(calculation.breakdown.listTotalMinor)}</td>
                </tr>
                {calculation.breakdown.creditTotalMinor > 0 ? (
                  <tr>
                    <th scope="row">{t("platformLicensing.calculator.creditTotal")}</th>
                    <td className="licensing-amount licensing-negative">
                      {m(-calculation.breakdown.creditTotalMinor)}
                    </td>
                  </tr>
                ) : null}
                <tr>
                  <th scope="row">{t("platformLicensing.calculator.total")}</th>
                  <td className="licensing-amount licensing-total">
                    {m(calculation.breakdown.totalMinor)}
                  </td>
                </tr>
              </tbody>
            </table>
            {calculation.breakdown.savingsMinor > 0 ? (
              <p className="licensing-savings">
                {t("platformLicensing.calculator.youSave", {
                  amount: m(calculation.breakdown.savingsMinor),
                  percent: bpsToPercent(calculation.breakdown.savingsBps),
                })}
              </p>
            ) : null}
            <p className="platform-muted">
              {t("platformLicensing.calculator.seatsTotal", {
                seats: formatNumber(
                  calculation.breakdown.lines
                    .filter((l): l is SeatLine => l.kind === "seats")
                    .reduce((n, l) => n + l.seats, 0),
                ),
              })}
            </p>
          </>
        ) : null}
      </Card.Body>
    </Card>
  );
}

function SeatRows({ line, currency }: { line: SeatLine; currency: string }) {
  const { t } = useTranslation();
  const money = useMoney();
  const m = (amount: number) => money(amount, currency);
  const audience = t(`platformLicensing.audience.${line.audience}`);
  return (
    <>
      <tr>
        <th scope="row">
          {t("platformLicensing.calculator.seatLine", {
            tier: line.tierName,
            seats: line.seats,
            audience,
          })}
          <div className="platform-muted">
            {t("platformLicensing.calculator.perSeat", {
              before: m(line.listPricePerSeatMonthMinor),
              after: m(line.pricePerSeatMonthMinor),
            })}
          </div>
        </th>
        <td className="licensing-amount">{m(line.listAmountMinor)}</td>
      </tr>
      {line.volumeDiscountMinor > 0 ? (
        <tr>
          <th scope="row">
            {t("platformLicensing.calculator.volumeDiscount", {
              percent: bpsToPercent(line.volumeDiscountBps),
            })}
          </th>
          <td className="licensing-amount licensing-negative">{m(-line.volumeDiscountMinor)}</td>
        </tr>
      ) : null}
      {line.durationDiscountMinor > 0 ? (
        <tr>
          <th scope="row">
            {t("platformLicensing.calculator.durationDiscount", {
              percent: bpsToPercent(line.durationDiscountBps),
            })}
          </th>
          <td className="licensing-amount licensing-negative">{m(-line.durationDiscountMinor)}</td>
        </tr>
      ) : null}
    </>
  );
}

/** "Add 20 seats to reach 10% off": how the price per seat drops at each audience's next bracket. */
function NextBrackets({ calculation }: { calculation: QuoteCalculation }) {
  const { t } = useTranslation();
  const money = useMoney();
  const currency = calculation.breakdown.currencyCode;
  const lines = calculation.breakdown.lines.filter(
    (line): line is SeatLine => line.kind === "seats" && line.nextVolumeBracket !== null,
  );
  if (lines.length === 0) return null;
  return (
    <Card as="section" aria-labelledby="calculator-next">
      <Card.Header>
        <h2 id="calculator-next">{t("platformLicensing.calculator.nextTitle")}</h2>
      </Card.Header>
      <Card.Body>
        <table className="platform-table">
          <caption className="sf-visually-hidden">
            {t("platformLicensing.calculator.nextTitle")}
          </caption>
          <thead>
            <tr>
              <th scope="col">{t("platformLicensing.calculator.nextColumns.audience")}</th>
              <th scope="col">{t("platformLicensing.calculator.nextColumns.offer")}</th>
              <th scope="col">{t("platformLicensing.calculator.nextColumns.now")}</th>
              <th scope="col">{t("platformLicensing.calculator.nextColumns.then")}</th>
            </tr>
          </thead>
          <tbody>
            {lines.map((line) => (
              <tr key={line.audience}>
                <td>{t(`platformLicensing.audience.${line.audience}`)}</td>
                <td>
                  {t("platformLicensing.calculator.nextOffer", {
                    count: line.nextVolumeBracket!.seatsToAdd,
                    percent: bpsToPercent(line.nextVolumeBracket!.discountBps),
                  })}
                </td>
                <td className="licensing-amount">{money(line.pricePerSeatMonthMinor, currency)}</td>
                <td className="licensing-amount">
                  {money(line.nextVolumeBracket!.pricePerSeatMonthMinor, currency)}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </Card.Body>
    </Card>
  );
}

const QUOTE_ACTIONS: Record<Quote["status"], readonly QuoteAction[]> = {
  draft: ["send", "accept", "withdraw"],
  sent: ["accept", "withdraw"],
  accepted: [],
  expired: [],
  withdrawn: [],
};

/** The school's quotes with their statuses and the moves each allows. */
export function SchoolQuotes({ schoolId }: { schoolId: string }) {
  const { t } = useTranslation();
  const { show } = useToast();
  const { formatDate } = useFormatters();
  const money = useMoney();
  const quotes = useSchoolQuotesQuery(schoolId);
  const action = useQuoteAction();

  function run(quote: Quote, move: QuoteAction) {
    action.mutate(
      { schoolId, quoteId: quote.id, action: move },
      {
        onSuccess: () =>
          show({ variant: "success", title: t(`platformLicensing.quotes.done.${move}`) }),
        onError: (error) =>
          show({
            variant: "error",
            title: t("platformLicensing.common.saveError"),
            description: error instanceof ApiError ? (error.detail ?? error.title) : undefined,
          }),
      },
    );
  }

  return (
    <Card as="section" aria-labelledby={`quotes-${schoolId}`}>
      <Card.Header>
        <h2 id={`quotes-${schoolId}`}>{t("platformLicensing.quotes.title")}</h2>
      </Card.Header>
      <Card.Body>
        {quotes.isPending ? <p role="status">{t("site.common.loading")}</p> : null}
        {quotes.data && quotes.data.length === 0 ? (
          <p className="platform-muted">{t("platformLicensing.quotes.empty")}</p>
        ) : null}
        {quotes.data && quotes.data.length > 0 ? (
          <table className="platform-table">
            <caption className="sf-visually-hidden">{t("platformLicensing.quotes.title")}</caption>
            <thead>
              <tr>
                <th scope="col">{t("platformLicensing.quotes.columns.created")}</th>
                <th scope="col">{t("platformLicensing.quotes.columns.kind")}</th>
                <th scope="col">{t("platformLicensing.quotes.columns.total")}</th>
                <th scope="col">{t("platformLicensing.quotes.columns.validUntil")}</th>
                <th scope="col">{t("platformLicensing.quotes.columns.status")}</th>
                <th scope="col">
                  <span className="sf-visually-hidden">
                    {t("platformLicensing.common.actions")}
                  </span>
                </th>
              </tr>
            </thead>
            <tbody>
              {quotes.data.map((quote) => (
                <tr key={quote.id}>
                  <td>{formatDate(new Date(quote.createdAt), { dateStyle: "medium" })}</td>
                  <td>{t(`platformLicensing.quoteKind.${quote.kind}`)}</td>
                  <td className="licensing-amount">
                    {money(quote.totalMinor, quote.currencyCode, quote.minorUnit)}
                  </td>
                  <td>{formatDate(new Date(quote.validUntil), { dateStyle: "medium" })}</td>
                  <td>
                    <span className="platform-pill" data-status={quote.status}>
                      {t(`platformLicensing.quoteStatus.${quote.status}`)}
                    </span>
                  </td>
                  <td>
                    <div className="platform-actions">
                      {QUOTE_ACTIONS[quote.status].map((move) => (
                        <Button
                          key={move}
                          variant={move === "send" ? "secondary" : "tertiary"}
                          disabled={action.isPending}
                          onClick={() => run(quote, move)}
                        >
                          {t(`platformLicensing.quotes.actions.${move}`)}
                        </Button>
                      ))}
                      {quote.invoiceId ? (
                        <Link to={`/portal/platform/payments/${schoolId}/${quote.invoiceId}`}>
                          {t("platformLicensing.quotes.openInvoice")}
                        </Link>
                      ) : null}
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        ) : null}
      </Card.Body>
    </Card>
  );
}
