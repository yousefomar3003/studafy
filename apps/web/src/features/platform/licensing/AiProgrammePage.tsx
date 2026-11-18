import { ApiError } from "@studafy/api-client";
import {
  AI_PROGRAMME_FIELDS,
  AI_PROGRAMME_PAYOUT_MODES,
  previewRevenueShare,
  resolveAiProgramme,
  schoolMarginOf,
  validateAiProgrammeOverride,
  validateAiProgrammeSettings,
} from "@studafy/license-pricing";
import { Button, Card, Checkbox, Input, Select, useToast } from "@studafy/ui";
import { useEffect, useMemo, useState } from "react";
import { useSearchParams } from "react-router-dom";

import { useFormatters, useTranslation } from "../../../lib/i18n";
import { PlatformPageHeader } from "../PlatformNav";
import { useSchoolsListQuery } from "../queries";

import { globalFormOf, hasNaN, overrideFormOf, overrideOf, settingsOf } from "./ai-programme-form";
import { useFormatProgrammeValue } from "./ai-programme-format";
import { bpsToPercent, currencyMinorUnit, useMoney } from "./format";
import {
  useClearSchoolAiProgrammeOverride,
  useSaveAiProgrammeVersion,
  useSaveSchoolAiProgrammeOverride,
} from "./mutations";
import {
  useAiProgrammeVersionsQuery,
  useSchoolAiProgrammeOverridesQuery,
  useSchoolAiProgrammeQuery,
} from "./queries";

import "../platform.css";
import "./licensing.css";

import type { GlobalForm, OverrideForm, ScalarForm, TierRow } from "./ai-programme-form";
import type { ChangeLine } from "./ai-programme-format";
import type { AiProgrammeOverrideVersion, AiProgrammeVersion, SchoolAiProgramme } from "./queries";
import type {
  AiProgrammeField,
  AiProgrammeIssue,
  AiProgrammeOverrideField,
  AiProgrammePayoutMode,
  AiProgrammeSettings,
  AiProgrammeTier,
  ResolvedAiProgramme,
} from "@studafy/license-pricing";

const P = "platformLicensing.aiProgramme";

/**
 * The Student AI programme (`/portal/platform/ai-programme`, migration 000234): every price, tier
 * and rule of Student AI bundled with tuition, globally and per school. Each save is a new version
 * with a reason; new quotes, new licences and renewals use the values in force, existing licences
 * keep theirs (the school's licence page re-applies the current ones on request).
 */
export default function AiProgrammePage() {
  const { t } = useTranslation();
  const versions = useAiProgrammeVersionsQuery();
  const [params, setParams] = useSearchParams();
  const schoolId = params.get("schoolId");
  const current = versions.data?.[0] ?? null;

  return (
    <>
      <PlatformPageHeader title={t(`${P}.title`)} description={t(`${P}.description`)} />
      {versions.isPending ? <p role="status">{t("site.common.loading")}</p> : null}
      {versions.isError ? <p role="alert">{t("platformLicensing.common.loadError")}</p> : null}
      {current ? (
        <div className="platform-stack">
          <GlobalEditor key={current.id} current={current} />
          <ShareExample values={resolveAiProgramme(current.settings, null, "USD")} />
          <SchoolOverrides
            schoolId={schoolId}
            onSchool={(id) => setParams(id ? { schoolId: id } : {}, { replace: true })}
          />
          <VersionHistory versions={versions.data ?? []} />
        </div>
      ) : null}
    </>
  );
}

// ---------------------------------------------------------------------------------------------------
// Shared pieces
// ---------------------------------------------------------------------------------------------------

/** The first issue about a field (and row), as a message. */
function useIssueText(issues: readonly AiProgrammeIssue[]) {
  const { t } = useTranslation();
  return (field: AiProgrammeIssue["field"], index?: number) => {
    const issue = issues.find(
      (i) =>
        i.field === field && (index === undefined || i.index === undefined || i.index === index),
    );
    return issue ? t(`${P}.issue.${issue.code}`) : undefined;
  };
}

function TierTable({
  id,
  title,
  help,
  fromLabel,
  shareLabel,
  rows,
  onChange,
  error,
  disabled,
}: {
  id: string;
  title: string;
  help: string;
  fromLabel: string;
  shareLabel: string;
  rows: TierRow[];
  onChange: (rows: TierRow[]) => void;
  error?: string;
  disabled?: boolean;
}) {
  const { t } = useTranslation();
  const set = (index: number, patch: Partial<TierRow>) =>
    onChange(rows.map((row, i) => (i === index ? { ...row, ...patch } : row)));
  return (
    <fieldset className="licensing-tiers" aria-labelledby={`${id}-title`} disabled={disabled}>
      <legend id={`${id}-title`}>{title}</legend>
      <p className="platform-muted">{help}</p>
      <div className="licensing-row-list">
        {rows.map((row, index) => (
          <div className="licensing-row" key={index} data-testid={`${id}-row`}>
            <Input
              label={fromLabel}
              value={row.from}
              inputMode="decimal"
              suffix="%"
              onChange={(event) => set(index, { from: event.target.value })}
              disabled={disabled}
            />
            <Input
              label={shareLabel}
              value={row.share}
              inputMode="decimal"
              suffix="%"
              onChange={(event) => set(index, { share: event.target.value })}
              disabled={disabled}
            />
            <Button
              variant="tertiary"
              disabled={disabled || rows.length <= 1}
              onClick={() => onChange(rows.filter((_, i) => i !== index))}
            >
              {t("platformLicensing.common.remove")}
            </Button>
          </div>
        ))}
        {error ? (
          <p role="alert" className="licensing-errors">
            {error}
          </p>
        ) : null}
        <div>
          <Button
            variant="secondary"
            disabled={disabled}
            onClick={() => onChange([...rows, { from: "", share: "" }])}
          >
            {t(`${P}.addTier`)}
          </Button>
        </div>
      </div>
    </fieldset>
  );
}

/** The non-blocking warning when parents pay the licence price or less. */
export function MarginWarning({
  licensePriceMinor,
  parentPriceMinor,
}: {
  licensePriceMinor: number | null;
  parentPriceMinor: number | null;
}) {
  const { t } = useTranslation();
  const valid = (n: number | null) => n !== null && Number.isFinite(n);
  if (!valid(licensePriceMinor) || !valid(parentPriceMinor)) return null;
  const margin = schoolMarginOf({ licensePriceMinor, parentPriceMinor });
  if (margin === "positive" || margin === null) return null;
  return (
    <p className="licensing-warning" role="status" data-testid="margin-warning">
      {t(`${P}.margin.${margin}`)}
    </p>
  );
}

/** The scalar settings: seats, share cap, floor, bonus rule, days, month-to-month, payout. */
function ScalarFields({
  form,
  set,
  issueText,
  isOn,
  toggle,
}: {
  form: ScalarForm;
  set: (patch: Partial<ScalarForm>) => void;
  issueText: (field: AiProgrammeIssue["field"]) => string | undefined;
  /** For a school: whether a field is overridden (else it shows the inherited value, greyed). */
  isOn?: (field: AiProgrammeOverrideField) => boolean;
  toggle?: (field: AiProgrammeOverrideField) => void;
}) {
  const { t } = useTranslation();
  const off = (field: AiProgrammeOverrideField) => (isOn ? !isOn(field) : false);
  const overrideToggle = (field: AiProgrammeOverrideField) =>
    toggle ? (
      <Checkbox
        label={t(`${P}.overrideThis`)}
        checked={!off(field)}
        onChange={() => toggle(field)}
      />
    ) : null;
  const payoutOptions = AI_PROGRAMME_PAYOUT_MODES.map((mode) => ({
    value: mode,
    label: t(`${P}.payoutMode.${mode}`),
  }));
  return (
    <>
      <h3>{t(`${P}.seatsHeading`)}</h3>
      <div className="licensing-form-grid">
        <div className="licensing-field">
          <Input
            label={t(`${P}.field.minSeats`)}
            helperText={t(`${P}.help.minSeats`)}
            value={form.minSeats}
            inputMode="numeric"
            disabled={off("minSeats")}
            error={off("minSeats") ? undefined : issueText("minSeats")}
            onChange={(event) => set({ minSeats: event.target.value })}
          />
          {overrideToggle("minSeats")}
        </div>
      </div>

      <h3>{t(`${P}.shareHeading`)}</h3>
      <div className="licensing-form-grid">
        <div className="licensing-field">
          <Input
            label={t(`${P}.field.maxShareBps`)}
            value={form.maxShare}
            suffix="%"
            inputMode="decimal"
            disabled={off("maxShareBps")}
            error={off("maxShareBps") ? undefined : issueText("maxShareBps")}
            onChange={(event) => set({ maxShare: event.target.value })}
          />
          {overrideToggle("maxShareBps")}
        </div>
        <div className="licensing-field">
          <Input
            label={t(`${P}.field.largeSchoolMinSeats`)}
            helperText={t(`${P}.help.largeSchool`)}
            value={form.floorSeats}
            inputMode="numeric"
            disabled={off("largeSchoolMinSeats")}
            error={off("largeSchoolMinSeats") ? undefined : issueText("largeSchoolMinSeats")}
            onChange={(event) => set({ floorSeats: event.target.value })}
          />
          {overrideToggle("largeSchoolMinSeats")}
        </div>
        <div className="licensing-field">
          <Input
            label={t(`${P}.field.largeSchoolShareBps`)}
            value={form.floorShare}
            suffix="%"
            inputMode="decimal"
            disabled={off("largeSchoolShareBps")}
            error={off("largeSchoolShareBps") ? undefined : issueText("largeSchoolShareBps")}
            onChange={(event) => set({ floorShare: event.target.value })}
          />
          {overrideToggle("largeSchoolShareBps")}
        </div>
      </div>
      <div className="licensing-field">
        <TierTable
          id="conversion-tiers"
          title={t(`${P}.field.conversionTiers`)}
          help={t(`${P}.help.conversionTiers`)}
          fromLabel={t(`${P}.tier.conversionFrom`)}
          shareLabel={t(`${P}.tier.share`)}
          rows={form.conversion}
          onChange={(conversion) => set({ conversion })}
          error={off("conversionTiers") ? undefined : issueText("conversionTiers")}
          disabled={off("conversionTiers")}
        />
        {overrideToggle("conversionTiers")}
      </div>
      <div className="licensing-field">
        <TierTable
          id="bonus-tiers"
          title={t(`${P}.field.contentBonusTiers`)}
          help={t(`${P}.help.contentBonusTiers`)}
          fromLabel={t(`${P}.tier.uploadsFrom`)}
          shareLabel={t(`${P}.tier.bonus`)}
          rows={form.bonus}
          onChange={(bonus) => set({ bonus })}
          error={off("contentBonusTiers") ? undefined : issueText("contentBonusTiers")}
          disabled={off("contentBonusTiers")}
        />
        {overrideToggle("contentBonusTiers")}
      </div>
      <div className="licensing-field">
        <Checkbox
          label={t(`${P}.field.bonusRequiresConversionShare`)}
          checked={form.bonusRequiresConversionShare}
          disabled={off("bonusRequiresConversionShare")}
          onChange={(event) => set({ bonusRequiresConversionShare: event.target.checked })}
        />
        {overrideToggle("bonusRequiresConversionShare")}
      </div>

      <h3>{t(`${P}.rulesHeading`)}</h3>
      <div className="licensing-form-grid">
        <div className="licensing-field">
          <Input
            label={t(`${P}.field.measurementOffsetDays`)}
            helperText={t(`${P}.help.measurement`)}
            value={form.measurementDays}
            inputMode="numeric"
            disabled={off("measurementOffsetDays")}
            error={off("measurementOffsetDays") ? undefined : issueText("measurementOffsetDays")}
            onChange={(event) => set({ measurementDays: event.target.value })}
          />
          {overrideToggle("measurementOffsetDays")}
        </div>
        <div className="licensing-field">
          <Input
            label={t(`${P}.field.nonpaymentGraceDays`)}
            helperText={t(`${P}.help.grace`)}
            value={form.graceDays}
            inputMode="numeric"
            disabled={off("nonpaymentGraceDays")}
            error={off("nonpaymentGraceDays") ? undefined : issueText("nonpaymentGraceDays")}
            onChange={(event) => set({ graceDays: event.target.value })}
          />
          {overrideToggle("nonpaymentGraceDays")}
        </div>
        <div className="licensing-field">
          <Input
            label={t(`${P}.field.monthToMonthShareBps`)}
            helperText={t(`${P}.help.monthToMonth`)}
            value={form.monthToMonth}
            suffix="%"
            inputMode="decimal"
            disabled={off("monthToMonthShareBps")}
            error={off("monthToMonthShareBps") ? undefined : issueText("monthToMonthShareBps")}
            onChange={(event) => set({ monthToMonth: event.target.value })}
          />
          {overrideToggle("monthToMonthShareBps")}
        </div>
        <div className="licensing-field">
          <Select<AiProgrammePayoutMode>
            label={t(`${P}.field.payoutMode`)}
            value={form.payoutMode}
            options={payoutOptions}
            disabled={off("payoutMode")}
            onChange={(payoutMode) => set({ payoutMode })}
          />
          {overrideToggle("payoutMode")}
        </div>
      </div>
    </>
  );
}

function ReasonField({ value, onChange }: { value: string; onChange: (value: string) => void }) {
  const { t } = useTranslation();
  return (
    <Input
      label={t(`${P}.reasonLabel`)}
      helperText={t(`${P}.reasonHelp`)}
      value={value}
      maxLength={1000}
      onChange={(event) => onChange(event.target.value)}
    />
  );
}

function errorText(error: unknown): string | undefined {
  return error instanceof ApiError ? (error.detail ?? error.title) : undefined;
}

// ---------------------------------------------------------------------------------------------------
// Global settings
// ---------------------------------------------------------------------------------------------------

function GlobalEditor({ current }: { current: AiProgrammeVersion }) {
  const { t } = useTranslation();
  const { show } = useToast();
  const { formatDate } = useFormatters();
  const save = useSaveAiProgrammeVersion();
  const [form, setForm] = useState<GlobalForm>(() => globalFormOf(current.settings));
  const [reason, setReason] = useState("");
  const [newCurrency, setNewCurrency] = useState("");

  const settings = settingsOf(form);
  const issues = validateAiProgrammeSettings(settings);
  const issueText = useIssueText(issues);
  const iapChanged = settings.prices.some((price) => {
    const before = current.settings.prices.find((p) => p.currencyCode === price.currencyCode);
    return before ? before.iapPriceMinor !== price.iapPriceMinor : true;
  });
  const changed = JSON.stringify(settings) !== JSON.stringify(current.settings);
  const canSave = changed && issues.length === 0 && reason.trim() !== "" && !hasNaN(settings);
  const set = (patch: Partial<GlobalForm>) => setForm((prev) => ({ ...prev, ...patch }));
  const setPrice = (index: number, patch: Partial<GlobalForm["prices"][number]>) =>
    set({ prices: form.prices.map((p, i) => (i === index ? { ...p, ...patch } : p)) });

  function submit() {
    if (!canSave) return;
    save.mutate(
      { ...settings, reason: reason.trim(), basedOnVersionId: current.id },
      {
        onSuccess: () => {
          setReason("");
          show({
            variant: "success",
            title: t(`${P}.saved`),
            description: iapChanged ? t(`${P}.storeReminder`) : undefined,
          });
        },
        onError: (error) =>
          show({
            variant: "error",
            title: t("platformLicensing.common.saveError"),
            description: errorText(error),
          }),
      },
    );
  }

  return (
    <Card as="section" aria-labelledby="ai-programme-global">
      <Card.Header>
        <h2 id="ai-programme-global">{t(`${P}.globalTitle`)}</h2>
        <p className="platform-muted">
          {t(`${P}.versionLine`, {
            version: current.versionNumber,
            who: current.createdBy.name ?? t(`${P}.systemAuthor`),
            when: formatDate(new Date(current.createdAt), { dateStyle: "medium" }),
          })}
        </p>
        <p className="platform-muted">{t(`${P}.globalHelp`)}</p>
      </Card.Header>
      <Card.Body>
        <h3>{t(`${P}.pricesHeading`)}</h3>
        <p className="platform-muted">{t(`${P}.pricesHelp`)}</p>
        <div className="licensing-row-list">
          {form.prices.map((price, index) => (
            <div key={price.currencyCode} className="licensing-price-row">
              <div className="licensing-row" data-testid="price-row">
                <span className="licensing-audience__name">{price.currencyCode}</span>
                <Input
                  label={t(`${P}.field.iapPriceMinor`)}
                  helperText={t(`${P}.help.iap`)}
                  value={price.iap}
                  inputMode="decimal"
                  onChange={(event) => setPrice(index, { iap: event.target.value })}
                />
                <Input
                  label={t(`${P}.field.licensePriceMinor`)}
                  value={price.license}
                  inputMode="decimal"
                  onChange={(event) => setPrice(index, { license: event.target.value })}
                />
                <Input
                  label={t(`${P}.field.parentPriceMinor`)}
                  value={price.parent}
                  inputMode="decimal"
                  onChange={(event) => setPrice(index, { parent: event.target.value })}
                />
                <Button
                  variant="tertiary"
                  disabled={form.prices.length <= 1}
                  onClick={() => set({ prices: form.prices.filter((_, i) => i !== index) })}
                >
                  {t("platformLicensing.common.remove")}
                </Button>
              </div>
              <MarginWarning
                licensePriceMinor={settings.prices[index]!.licensePriceMinor}
                parentPriceMinor={settings.prices[index]!.parentPriceMinor}
              />
            </div>
          ))}
          {issueText("prices") ? (
            <p role="alert" className="licensing-errors">
              {issueText("prices")}
            </p>
          ) : null}
          <div className="licensing-row">
            <Input
              label={t(`${P}.addCurrencyLabel`)}
              value={newCurrency}
              maxLength={3}
              onChange={(event) => setNewCurrency(event.target.value.toUpperCase())}
            />
            <Button
              variant="secondary"
              disabled={
                !/^[A-Z]{3}$/.test(newCurrency) ||
                form.prices.some((p) => p.currencyCode === newCurrency)
              }
              onClick={() => {
                set({
                  prices: [
                    ...form.prices,
                    { currencyCode: newCurrency, iap: "", license: "", parent: "" },
                  ],
                });
                setNewCurrency("");
              }}
            >
              {t(`${P}.addCurrency`)}
            </Button>
          </div>
        </div>
        {iapChanged ? (
          <p className="licensing-warning" role="status" data-testid="store-reminder">
            {t(`${P}.storeReminder`)}
          </p>
        ) : null}

        <ScalarFields form={form} set={set} issueText={issueText} />
        <ReasonField value={reason} onChange={setReason} />
      </Card.Body>
      <Card.Footer>
        <p className="platform-muted">{t(`${P}.appliesTo`)}</p>
        <div className="platform-actions">
          <Button
            variant="tertiary"
            disabled={!changed}
            onClick={() => setForm(globalFormOf(current.settings))}
          >
            {t(`${P}.discard`)}
          </Button>
          <Button variant="primary" disabled={!canSave} loading={save.isPending} onClick={submit}>
            {t(`${P}.saveVersion`)}
          </Button>
        </div>
      </Card.Footer>
    </Card>
  );
}

// ---------------------------------------------------------------------------------------------------
// Worked example
// ---------------------------------------------------------------------------------------------------

function ShareExample({ values }: { values: ResolvedAiProgramme }) {
  const { t } = useTranslation();
  const [conversion, setConversion] = useState("70");
  const [uploads, setUploads] = useState("85");
  const [seats, setSeats] = useState("350");
  const [fullYear, setFullYear] = useState(true);
  const toBps = (v: string) => Math.round(Math.min(100, Math.max(0, Number(v) || 0)) * 100);
  const preview = previewRevenueShare(values, {
    conversionBps: toBps(conversion),
    uploadConsistencyBps: toBps(uploads),
    seats: Math.max(0, Math.floor(Number(seats) || 0)),
    fullYear,
  });
  return (
    <Card as="section" aria-labelledby="ai-programme-example">
      <Card.Header>
        <h2 id="ai-programme-example">{t(`${P}.exampleTitle`)}</h2>
        <p className="platform-muted">{t(`${P}.exampleHelp`)}</p>
      </Card.Header>
      <Card.Body>
        <div className="licensing-form-grid">
          <Input
            label={t(`${P}.example.conversion`)}
            value={conversion}
            suffix="%"
            inputMode="decimal"
            onChange={(e) => setConversion(e.target.value)}
          />
          <Input
            label={t(`${P}.example.uploads`)}
            value={uploads}
            suffix="%"
            inputMode="decimal"
            onChange={(e) => setUploads(e.target.value)}
          />
          <Input
            label={t(`${P}.example.seats`)}
            value={seats}
            inputMode="numeric"
            onChange={(e) => setSeats(e.target.value)}
          />
          <Checkbox
            label={t(`${P}.example.fullYear`)}
            checked={fullYear}
            onChange={(e) => setFullYear(e.target.checked)}
          />
        </div>
        <ul className="platform-breakdown" data-testid="share-example">
          <li>
            <span>{t(`${P}.example.conversionShare`)}</span>
            <strong>{bpsToPercent(preview.conversionShareBps)}</strong>
          </li>
          <li>
            <span>{t(`${P}.example.bonus`)}</span>
            <strong>+{bpsToPercent(preview.bonusBps)}</strong>
          </li>
          <li>
            <span>{t(`${P}.example.total`)}</span>
            <strong>{bpsToPercent(preview.totalBps)}</strong>
          </li>
        </ul>
        {preview.floorApplied ? <p className="platform-muted">{t(`${P}.example.floor`)}</p> : null}
        {preview.capped ? <p className="platform-muted">{t(`${P}.example.capped`)}</p> : null}
        <p className="platform-muted">{t(`${P}.example.base`)}</p>
      </Card.Body>
    </Card>
  );
}

// ---------------------------------------------------------------------------------------------------
// Per-school overrides
// ---------------------------------------------------------------------------------------------------

function SchoolOverrides({
  schoolId,
  onSchool,
}: {
  schoolId: string | null;
  onSchool: (schoolId: string | null) => void;
}) {
  const { t } = useTranslation();
  const [search, setSearch] = useState("");
  const schools = useSchoolsListQuery({ search, status: "", page: 0 });
  const programme = useSchoolAiProgrammeQuery(schoolId);
  const options = (schools.data?.schools ?? []).map((s) => ({ value: s.id, label: s.name }));
  if (schoolId && !options.some((o) => o.value === schoolId)) {
    options.unshift({ value: schoolId, label: programme.data ? t(`${P}.selectedSchool`) : "…" });
  }

  return (
    <Card as="section" aria-labelledby="ai-programme-schools">
      <Card.Header>
        <h2 id="ai-programme-schools">{t(`${P}.schoolsTitle`)}</h2>
        <p className="platform-muted">{t(`${P}.schoolsHelp`)}</p>
      </Card.Header>
      <Card.Body>
        <div className="licensing-form-grid">
          <Input
            label={t(`${P}.searchSchools`)}
            value={search}
            onChange={(event) => setSearch(event.target.value)}
          />
          <Select
            label={t(`${P}.school`)}
            placeholder={t(`${P}.chooseSchool`)}
            value={schoolId ?? undefined}
            options={options}
            onChange={(value) => onSchool(value)}
          />
        </div>
        {programme.isError ? <p role="alert">{t("platformLicensing.common.loadError")}</p> : null}
        {programme.data ? (
          <OverrideEditor key={programme.data.override?.id ?? "none"} data={programme.data} />
        ) : null}
        {schoolId ? <OverrideHistory schoolId={schoolId} /> : null}
      </Card.Body>
    </Card>
  );
}

function OverrideEditor({ data }: { data: SchoolAiProgramme }) {
  const { t } = useTranslation();
  const { show } = useToast();
  const money = useMoney();
  const save = useSaveSchoolAiProgrammeOverride();
  const clear = useClearSchoolAiProgrammeOverride();
  const currency = data.currencyCode;
  const initial = useMemo(
    () => overrideFormOf(data.effective, data.effective.overridden, currency),
    [data, currency],
  );
  const [form, setForm] = useState<OverrideForm>(initial);
  const [reason, setReason] = useState("");
  useEffect(() => setForm(initial), [initial]);

  const draft = overrideOf(form, currency);
  const hasPrice = draft.licensePriceMinor !== null || draft.parentPriceMinor !== null;
  const override = { ...draft, priceCurrencyCode: hasPrice ? currency : null };
  const issues = validateAiProgrammeOverride(override, data.global.settings);
  const issueText = useIssueText(issues);
  const effective = resolveAiProgramme(data.global.settings, override, currency);
  const set = (patch: Partial<ScalarForm>) => setForm((prev) => ({ ...prev, ...patch }));
  const toggle = (field: AiProgrammeOverrideField) =>
    setForm((prev) => ({ ...prev, on: { ...prev.on, [field]: !prev.on[field] } }));
  const changed = JSON.stringify(draft) !== JSON.stringify(overrideOf(initial, currency));
  const canSave = changed && issues.length === 0 && reason.trim() !== "" && !hasNaN(draft);
  const hasOverride = data.override !== null && !data.override.empty;

  const onError = (error: unknown) =>
    show({
      variant: "error",
      title: t("platformLicensing.common.saveError"),
      description: errorText(error),
    });

  function submit() {
    if (!canSave) return;
    save.mutate(
      {
        schoolId: data.schoolId,
        body: { ...draft, reason: reason.trim(), basedOnOverrideId: data.override?.id ?? null },
      },
      {
        onSuccess: () => {
          setReason("");
          show({ variant: "success", title: t(`${P}.saved`) });
        },
        onError,
      },
    );
  }

  function clearAll() {
    if (reason.trim() === "") return;
    clear.mutate(
      {
        schoolId: data.schoolId,
        reason: reason.trim(),
        basedOnOverrideId: data.override?.id ?? null,
      },
      {
        onSuccess: () => {
          setReason("");
          show({ variant: "success", title: t(`${P}.cleared`) });
        },
        onError,
      },
    );
  }

  const priceOff = (field: "licensePriceMinor" | "parentPriceMinor") => !form.on[field];
  return (
    <div className="platform-stack" data-testid="override-editor">
      <p className="platform-muted">
        {data.override && !data.override.empty
          ? t(`${P}.overrideLine`, { version: data.override.versionNumber })
          : t(`${P}.noOverride`)}{" "}
        {t(`${P}.schoolCurrency`, { currency })}
      </p>
      <h3>{t(`${P}.pricesHeading`)}</h3>
      <div className="licensing-form-grid">
        <div className="licensing-field">
          <Input
            label={t(`${P}.field.licensePriceMinor`)}
            suffix={currency}
            value={form.license}
            inputMode="decimal"
            disabled={priceOff("licensePriceMinor")}
            onChange={(event) => setForm((prev) => ({ ...prev, license: event.target.value }))}
          />
          <Checkbox
            label={t(`${P}.overrideThis`)}
            checked={form.on.licensePriceMinor}
            onChange={() => toggle("licensePriceMinor")}
          />
        </div>
        <div className="licensing-field">
          <Input
            label={t(`${P}.field.parentPriceMinor`)}
            suffix={currency}
            value={form.parent}
            inputMode="decimal"
            disabled={priceOff("parentPriceMinor")}
            onChange={(event) => setForm((prev) => ({ ...prev, parent: event.target.value }))}
          />
          <Checkbox
            label={t(`${P}.overrideThis`)}
            checked={form.on.parentPriceMinor}
            onChange={() => toggle("parentPriceMinor")}
          />
        </div>
        <div className="licensing-field">
          <span className="platform-muted">{t(`${P}.field.iapPriceMinor`)}</span>
          <strong>
            {effective.iapPriceMinor === null
              ? t(`${P}.noPrice`)
              : money(effective.iapPriceMinor, currency, currencyMinorUnit(currency))}
          </strong>
          <span className="platform-muted">{t(`${P}.iapGlobalOnly`)}</span>
        </div>
      </div>
      {issueText("prices") || issueText("priceCurrencyCode") ? (
        <p role="alert" className="licensing-errors">
          {issueText("prices") ?? issueText("priceCurrencyCode")}
        </p>
      ) : null}
      {effective.licensePriceMinor === null || effective.parentPriceMinor === null ? (
        <p className="licensing-warning" role="status">
          {t(`${P}.pricesMissing`, { currency })}
        </p>
      ) : null}
      <MarginWarning
        licensePriceMinor={effective.licensePriceMinor}
        parentPriceMinor={effective.parentPriceMinor}
      />
      <ScalarFields
        form={form}
        set={set}
        issueText={issueText}
        isOn={(field) => form.on[field]}
        toggle={toggle}
      />
      <ShareExample values={effective} />
      <ReasonField value={reason} onChange={setReason} />
      <div className="platform-actions">
        <Button
          variant="secondary"
          disabled={!hasOverride || reason.trim() === ""}
          loading={clear.isPending}
          onClick={clearAll}
        >
          {t(`${P}.clearOverrides`)}
        </Button>
        <Button variant="primary" disabled={!canSave} loading={save.isPending} onClick={submit}>
          {t(`${P}.saveOverride`)}
        </Button>
      </div>
    </div>
  );
}

function OverrideHistory({ schoolId }: { schoolId: string }) {
  const { t } = useTranslation();
  const history = useSchoolAiProgrammeOverridesQuery(schoolId);
  const rows = history.data ?? [];
  if (rows.length === 0) return null;
  return (
    <section aria-labelledby="ai-programme-override-history">
      <h3 id="ai-programme-override-history">{t(`${P}.overrideHistoryTitle`)}</h3>
      <HistoryList
        entries={rows.map((row) => ({
          id: row.id,
          versionNumber: row.versionNumber,
          who: row.createdBy.name,
          when: row.createdAt,
          reason: row.reason,
          changes: row.empty ? [] : overrideFields(row),
          cleared: row.empty,
        }))}
      />
    </section>
  );
}

function overrideFields(row: AiProgrammeOverrideVersion): ChangeLine[] {
  const currency = row.override.priceCurrencyCode ?? "USD";
  return AI_PROGRAMME_FIELDS.flatMap((field) => {
    if (field === "iapPriceMinor") return [];
    const value = row.override[field as AiProgrammeOverrideField];
    return value === null || value === undefined ? [] : [{ field, after: value, currency }];
  });
}

// ---------------------------------------------------------------------------------------------------
// Version history with a diff
// ---------------------------------------------------------------------------------------------------

/** What changed from one global version to the next, field by field. */
export function versionChanges(
  before: AiProgrammeSettings | null,
  after: AiProgrammeSettings,
): ChangeLine[] {
  if (!before) return [];
  const lines: ChangeLine[] = [];
  if (JSON.stringify(before.prices) !== JSON.stringify(after.prices)) {
    lines.push({ field: "prices", before: before.prices, after: after.prices, currency: "" });
  }
  const scalar = AI_PROGRAMME_FIELDS.filter(
    (f) => f !== "iapPriceMinor" && f !== "licensePriceMinor" && f !== "parentPriceMinor",
  ) as (keyof AiProgrammeSettings)[];
  for (const field of scalar) {
    if (JSON.stringify(before[field]) !== JSON.stringify(after[field])) {
      lines.push({
        field: field as AiProgrammeField,
        before: before[field],
        after: after[field],
        currency: "",
      });
    }
  }
  return lines;
}

interface HistoryEntry {
  id: string;
  versionNumber: number;
  who: string | null;
  when: string;
  reason: string;
  changes: ChangeLine[];
  cleared?: boolean;
}

function HistoryList({ entries }: { entries: HistoryEntry[] }) {
  const { t } = useTranslation();
  const { formatDate } = useFormatters();
  const format = useFormatProgrammeValue();
  return (
    <ol className="licensing-history" data-testid="programme-history">
      {entries.map((entry) => (
        <li key={entry.id}>
          <details>
            <summary>
              <strong>{t(`${P}.versionLabel`, { version: entry.versionNumber })}</strong> ·{" "}
              {entry.who ?? t(`${P}.systemAuthor`)} ·{" "}
              {formatDate(new Date(entry.when), { dateStyle: "medium", timeStyle: "short" })}
              <span className="platform-muted"> — {entry.reason}</span>
            </summary>
            {entry.cleared ? <p>{t(`${P}.clearedEntry`)}</p> : null}
            {entry.changes.length > 0 ? (
              <table className="platform-table">
                <thead>
                  <tr>
                    <th scope="col">{t(`${P}.diff.setting`)}</th>
                    {entry.changes.some((c) => c.before !== undefined) ? (
                      <th scope="col">{t(`${P}.diff.before`)}</th>
                    ) : null}
                    <th scope="col">{t(`${P}.diff.after`)}</th>
                  </tr>
                </thead>
                <tbody>
                  {entry.changes.map((change) => (
                    <tr key={change.field}>
                      <td>{t(`${P}.field.${change.field}`)}</td>
                      {entry.changes.some((c) => c.before !== undefined) ? (
                        <td>{format(change.field, change.before, change.currency)}</td>
                      ) : null}
                      <td>{format(change.field, change.after, change.currency)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            ) : entry.cleared ? null : (
              <p className="platform-muted">{t(`${P}.diff.none`)}</p>
            )}
          </details>
        </li>
      ))}
    </ol>
  );
}

function VersionHistory({ versions }: { versions: AiProgrammeVersion[] }) {
  const { t } = useTranslation();
  return (
    <Card as="section" aria-labelledby="ai-programme-history">
      <Card.Header>
        <h2 id="ai-programme-history">{t(`${P}.historyTitle`)}</h2>
      </Card.Header>
      <Card.Body>
        <HistoryList
          entries={versions.map((version, index) => ({
            id: version.id,
            versionNumber: version.versionNumber,
            who: version.createdBy.name,
            when: version.createdAt,
            reason: version.reason,
            changes: versionChanges(versions[index + 1]?.settings ?? null, version.settings),
          }))}
        />
      </Card.Body>
    </Card>
  );
}
