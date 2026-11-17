import {
  MAX_CUSTOM_INSTALMENTS,
  MAX_REQUEST_MONTHS,
  MIN_REQUEST_MONTHS,
  SHARE_SCALE,
  addMonthsUtc,
  evenProposal,
  licenceYears,
  proposalErrors,
  scheduleMonths,
  splitByLicenceYears,
  splitEvenly,
  yearTotals,
} from "@studafy/license-pricing";
import { Button, Input, Radio, RadioGroup, Select } from "@studafy/ui";

import { useFormatters, useTranslation } from "../../lib/i18n";

import { YearTotals } from "./YearTotals";

import type { SchoolLicense } from "./queries";
import type {
  ProposalError,
  ProposedInstalment,
  SchoolPaymentPlan,
} from "@studafy/license-pricing";

/**
 * The school's half of "how long, and how do we pay" (ADR-021 as amended by 000233): the licence
 * length in months (presets or any number from 1 to 36), when a new licence should start, and the
 * payment plan -- monthly, yearly, or custom dates with a share of the total each. The school has no
 * price yet, so the preview lists every payment's date and share and what each licence year carries;
 * Studafy's quote then turns the shares into amounts, and the school accepts it before anything is
 * invoiced.
 */

export const LENGTH_PRESETS = [3, 6, 12, 24] as const;
const SCHOOL_PLANS: readonly SchoolPaymentPlan[] = ["monthly", "yearly", "custom"];
const DAY_MS = 86_400_000;

export interface ProposalRow {
  key: number;
  dueDate: string;
  /** Percent of the total, up to two decimals, as typed. */
  percent: string;
}

export interface TermsChoice {
  /** "" (not chosen / keep the licence's end), a preset ("12"), or "other". */
  length: string;
  otherMonths: string;
  /** YYYY-MM-DD or "" for as soon as possible (a new licence only). */
  startsOn: string;
  plan: SchoolPaymentPlan;
  rows: ProposalRow[];
}

export const EMPTY_TERMS: TermsChoice = {
  length: "12",
  otherMonths: "",
  startsOn: "",
  plan: "monthly",
  rows: [],
};

export function utcToday(now: Date = new Date()): string {
  return now.toISOString().slice(0, 10);
}

/** A licence in force: the request adds seats to it, or months after it. */
export function inForce(license: SchoolLicense | null): license is SchoolLicense {
  return license !== null && (license.status === "active" || license.status === "suspended");
}

/** The months chosen, or null (none chosen, or not a whole number from 1 to 36). */
export function chosenMonths(choice: TermsChoice): number | null {
  const raw = choice.length === "other" ? choice.otherMonths.trim() : choice.length;
  if (!/^\d{1,2}$/.test(raw)) return null;
  const months = Number(raw);
  return months >= MIN_REQUEST_MONTHS && months <= MAX_REQUEST_MONTHS ? months : null;
}

/**
 * The term the school's payments fall in, as the API reckons it: months more after a licence in
 * force, or the rest of its term; a new licence from its start (or today) for the months chosen.
 */
export function termOf(
  choice: TermsChoice,
  license: SchoolLicense | null,
  today: string,
): { startDate: string; termEnd: string; months: number } | null {
  const months = chosenMonths(choice);
  if (inForce(license)) {
    const end = license.endsAt.slice(0, 10);
    if (months) return { startDate: end, termEnd: addMonthsUtc(end, months), months };
    const days = Math.max(
      1,
      Math.ceil((Date.parse(`${end}T00:00:00Z`) - Date.parse(`${today}T00:00:00Z`)) / DAY_MS),
    );
    return { startDate: today, termEnd: end, months: scheduleMonths(0, days) };
  }
  if (!months) return null;
  const start = choice.startsOn || today;
  return { startDate: start, termEnd: addMonthsUtc(start, months), months };
}

/** "12.5" -> 1250 basis points; null when not a percentage with at most two decimals. */
export function percentToBps(value: string): number | null {
  const trimmed = value.trim().replace(",", ".");
  if (!/^\d{1,3}(\.\d{1,2})?$/.test(trimmed)) return null;
  return Math.round(Number(trimmed) * 100);
}

export function bpsToPercent(bps: number): string {
  return String(Number((bps / 100).toFixed(2)));
}

/** Rows for `count` payments spread evenly over the term in equal shares. */
export function evenRows(startDate: string, months: number, count: number): ProposalRow[] {
  return evenProposal(startDate, months, count).map((instalment, index) => ({
    key: index + 1,
    dueDate: instalment.dueDate,
    percent: bpsToPercent(instalment.shareBps),
  }));
}

export function proposalOf(rows: readonly ProposalRow[]): ProposedInstalment[] {
  return rows.map((row) => ({ dueDate: row.dueDate, shareBps: percentToBps(row.percent) ?? 0 }));
}

/** What is wrong with the choice; empty when it can be sent. */
export function termsErrors(
  choice: TermsChoice,
  license: SchoolLicense | null,
  today: string,
): (ProposalError | "months" | "start")[] {
  const errors: (ProposalError | "months" | "start")[] = [];
  const months = chosenMonths(choice);
  const lengthGiven =
    choice.length !== "" && !(choice.length === "other" && choice.otherMonths === "");
  if ((lengthGiven && months === null) || (!inForce(license) && months === null)) {
    errors.push("months");
  }
  if (!inForce(license) && choice.startsOn !== "" && choice.startsOn < today) errors.push("start");
  if (choice.plan === "custom") {
    const term = termOf(choice, license, today);
    if (term)
      errors.push(...proposalErrors(proposalOf(choice.rows), { today, termEnd: term.termEnd }));
  }
  return errors;
}

/** The request body's terms. */
export function termsPayload(choice: TermsChoice, license: SchoolLicense | null) {
  return {
    months: chosenMonths(choice),
    startsOn: inForce(license) ? null : choice.startsOn || null,
    paymentPlan: choice.plan,
    paymentProposal: choice.plan === "custom" ? proposalOf(choice.rows) : null,
  };
}

/** Each payment's date and share of the total, for the plan chosen, over the term. */
export function previewPayments(
  choice: TermsChoice,
  term: { startDate: string; months: number },
): ProposedInstalment[] {
  if (choice.plan === "custom") return proposalOf(choice.rows);
  if (choice.plan === "yearly") {
    const shares = splitByLicenceYears(SHARE_SCALE, term.months);
    return licenceYears(term.startDate, term.months).map((year, index) => ({
      dueDate: year.startDate,
      shareBps: shares[index]!,
    }));
  }
  return splitEvenly(SHARE_SCALE, term.months).map((shareBps, index) => ({
    dueDate: addMonthsUtc(term.startDate, index),
    shareBps,
  }));
}

export function LicenceTermsFields({
  value,
  onChange,
  license,
  today = utcToday(),
}: {
  value: TermsChoice;
  onChange: (next: TermsChoice) => void;
  license: SchoolLicense | null;
  today?: string;
}) {
  const { t } = useTranslation();
  const { formatDate, formatNumber } = useFormatters();
  const date = (iso: string) => formatDate(new Date(`${iso}T00:00:00Z`), { dateStyle: "medium" });
  const term = termOf(value, license, today);
  const errors = termsErrors(value, license, today);
  const set = (patch: Partial<TermsChoice>) => onChange({ ...value, ...patch });
  const months = chosenMonths(value);

  function choosePlan(plan: SchoolPaymentPlan) {
    if (plan === "custom" && value.rows.length === 0 && term) {
      set({ plan, rows: evenRows(term.startDate, term.months, Math.min(2, term.months)) });
    } else set({ plan });
  }

  const count = value.rows.length;
  const payments = term ? previewPayments(value, term) : [];
  const sharesTotal = value.rows.reduce((sum, row) => sum + (percentToBps(row.percent) ?? 0), 0);

  return (
    <div className="license-terms">
      <fieldset className="license-toolbar">
        <legend className="license-terms__legend">{t("schoolLicense.terms.lengthTitle")}</legend>
        <Select
          label={t("schoolLicense.terms.lengthLabel")}
          value={value.length}
          onChange={(length) => set({ length })}
          options={[
            ...(inForce(license)
              ? [
                  {
                    value: "",
                    label: t("schoolLicense.terms.keepEnd", {
                      date: date(license.endsAt.slice(0, 10)),
                    }),
                  },
                ]
              : []),
            ...LENGTH_PRESETS.map((preset) => ({
              value: String(preset),
              label: inForce(license)
                ? t("schoolLicense.terms.addMonths", { count: preset })
                : t("schoolLicense.terms.months", { count: preset }),
            })),
            { value: "other", label: t("schoolLicense.terms.otherLength") },
          ]}
        />
        {value.length === "other" ? (
          <Input
            label={t("schoolLicense.terms.otherMonthsLabel", {
              min: MIN_REQUEST_MONTHS,
              max: MAX_REQUEST_MONTHS,
            })}
            inputMode="numeric"
            value={value.otherMonths}
            error={
              errors.includes("months")
                ? t("schoolLicense.terms.monthsError", {
                    min: MIN_REQUEST_MONTHS,
                    max: MAX_REQUEST_MONTHS,
                  })
                : undefined
            }
            onChange={(event) => set({ otherMonths: event.target.value.trim() })}
          />
        ) : null}
        {inForce(license) ? null : (
          <Input
            label={t("schoolLicense.terms.startLabel")}
            helperText={t("schoolLicense.terms.startHelp")}
            type="date"
            min={today}
            value={value.startsOn}
            error={errors.includes("start") ? t("schoolLicense.terms.startError") : undefined}
            onChange={(event) => set({ startsOn: event.target.value })}
          />
        )}
      </fieldset>
      {inForce(license) ? (
        <p className="license-muted">
          {months
            ? t("schoolLicense.terms.extendHelp", { date: date(license.endsAt.slice(0, 10)) })
            : t("schoolLicense.terms.keepHelp", { date: date(license.endsAt.slice(0, 10)) })}
        </p>
      ) : null}

      <RadioGroup
        label={t("schoolLicense.terms.planLabel")}
        name="licence-payment-plan"
        value={value.plan}
        onChange={(plan) => choosePlan(plan as SchoolPaymentPlan)}
      >
        {SCHOOL_PLANS.map((plan) => (
          <Radio key={plan} value={plan} label={t(`schoolLicense.terms.plan.${plan}`)} />
        ))}
      </RadioGroup>
      <p className="license-muted">{t(`schoolLicense.terms.planHelp.${value.plan}`)}</p>

      {value.plan === "custom" && term ? (
        <fieldset className="license-terms__custom">
          <legend className="license-terms__legend">{t("schoolLicense.terms.custom.title")}</legend>
          <div className="license-toolbar">
            <Input
              label={t("schoolLicense.terms.custom.countLabel", { max: MAX_CUSTOM_INSTALMENTS })}
              type="number"
              min={1}
              max={MAX_CUSTOM_INSTALMENTS}
              value={String(count)}
              onChange={(event) => {
                const next = Math.max(
                  1,
                  Math.min(MAX_CUSTOM_INSTALMENTS, Number(event.target.value) || 1),
                );
                set({ rows: evenRows(term.startDate, term.months, next) });
              }}
            />
            <Button
              type="button"
              variant="tertiary"
              onClick={() =>
                set({ rows: evenRows(term.startDate, term.months, Math.max(1, count)) })
              }
            >
              {t("schoolLicense.terms.custom.even")}
            </Button>
          </div>
          {value.rows.map((row, index) => (
            <div key={row.key} className="license-toolbar">
              <Input
                label={t("schoolLicense.terms.custom.dateLabel", { position: index + 1 })}
                type="date"
                min={today}
                value={row.dueDate}
                onChange={(event) =>
                  set({
                    rows: value.rows.map((r) =>
                      r.key === row.key ? { ...r, dueDate: event.target.value } : r,
                    ),
                  })
                }
              />
              <Input
                label={t("schoolLicense.terms.custom.shareLabel", { position: index + 1 })}
                inputMode="decimal"
                value={row.percent}
                error={
                  percentToBps(row.percent) === null
                    ? t("schoolLicense.terms.custom.shareError")
                    : undefined
                }
                onChange={(event) =>
                  set({
                    rows: value.rows.map((r) =>
                      r.key === row.key ? { ...r, percent: event.target.value } : r,
                    ),
                  })
                }
              />
            </div>
          ))}
          <p className="license-muted" role="status">
            {t("schoolLicense.terms.custom.total", {
              percent: formatNumber(sharesTotal / 100, { maximumFractionDigits: 2 }),
            })}
          </p>
          {errors.some((e) => e !== "months" && e !== "start") ? (
            <ul role="alert" className="licensing-errors">
              {errors
                .filter((e) => e !== "months" && e !== "start")
                .map((error) => (
                  <li key={error}>{t(`schoolLicense.terms.errors.${error}`)}</li>
                ))}
            </ul>
          ) : null}
        </fieldset>
      ) : null}

      {term && payments.length > 0 ? (
        <section className="license-terms__preview" aria-labelledby="licence-terms-preview">
          <h3 id="licence-terms-preview">{t("schoolLicense.terms.preview.title")}</h3>
          <p className="license-muted">
            {t("schoolLicense.terms.preview.period", {
              from: date(term.startDate),
              to: date(
                new Date(Date.parse(`${term.termEnd}T00:00:00Z`) - DAY_MS)
                  .toISOString()
                  .slice(0, 10),
              ),
            })}
          </p>
          <YearTotals
            rows={yearTotals(
              payments.map((p) => ({ amountMinor: p.shareBps, dueDate: p.dueDate })),
              term.startDate,
              term.months,
            )}
            currencyCode=""
            shares
          />
          <div className="platform-table-scroll">
            <table className="platform-table license-schedule" data-testid="terms-payments">
              <caption className="sf-visually-hidden">
                {t("schoolLicense.terms.preview.title")}
              </caption>
              <thead>
                <tr>
                  <th scope="col">{t("schoolLicense.schedule.columns.number")}</th>
                  <th scope="col">{t("schoolLicense.schedule.columns.dueDate")}</th>
                  <th scope="col">{t("schoolLicense.terms.preview.share")}</th>
                </tr>
              </thead>
              <tbody>
                {payments.map((payment, index) => (
                  <tr key={index}>
                    <td>{index + 1}</td>
                    <td>{payment.dueDate ? date(payment.dueDate) : "—"}</td>
                    <td className="licensing-amount">
                      {formatNumber(payment.shareBps / 100, { maximumFractionDigits: 2 })}%
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <p className="license-muted">{t("schoolLicense.terms.preview.note")}</p>
        </section>
      ) : null}
    </div>
  );
}
