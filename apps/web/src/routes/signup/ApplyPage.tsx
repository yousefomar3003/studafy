import { ApiError } from "@studafy/api-client";
import { Button, Input, Select } from "@studafy/ui";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useId, useState } from "react";
import { Navigate, useNavigate } from "react-router-dom";

import { LinkButton } from "../../components/LinkButton";
import { Loading } from "../../components/Loading";
import { api } from "../../lib/api";
import { useFormatters, useLocale, useTranslation } from "../../lib/i18n";
import { uploadFileToPresignedUrl } from "../../lib/upload";
import { fieldErrors } from "../onboarding/schema";
import { displayName } from "../onboarding/SchoolDetailsStep";

import { APPLICANT_KEY, applicantApi, useApplicantQuery } from "./applicant-api";
import {
  EMPTY_APPLICATION_FORM,
  PROOF_CONTENT_TYPES,
  applicationFormSchema,
  proofFileError,
} from "./schema";

import "./signup.css";

import type { ApplicantApplication, ApplicantMe } from "./applicant-api";
import type { ApplicationForm } from "./schema";
import type { components } from "@studafy/api-client";
import type { FormEvent } from "react";

type CountryOption = components["schemas"]["CountriesResponse"]["countries"][number];
type CurrencyOption = components["schemas"]["CurrenciesResponse"]["currencies"][number];
type FieldErrors = Partial<Record<keyof ApplicationForm | "proof", string>>;

/** API refusals the form explains in place; anything else gets the generic message. */
const KNOWN_SUBMIT_ERRORS = new Set([
  "SCHOOL_APPLICATION_ALREADY_PENDING",
  "SCHOOL_APPLICATION_ACCOUNT_EXISTS",
  "SCHOOL_APPLICATION_PROOF_INVALID",
  "SCHOOL_APPLICATION_SESSION_REQUIRED",
]);

/**
 * The school application (`/signup/apply`), reached after signing in with Google or Microsoft on
 * `/signup`. Shows the form until the applicant submits, then the status of their application:
 * awaiting review, approved (sign in), or rejected (the reason, and the form again).
 */
export default function ApplyPage() {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const { data: me, isPending, isError } = useApplicantQuery();
  const [reapplying, setReapplying] = useState(false);

  if (isPending) return <Loading />;
  if (isError) {
    return (
      <div className="apply">
        <p role="alert">{t("onboarding.common.genericError")}</p>
      </div>
    );
  }
  if (!me) return <Navigate to="/signup" replace />;

  async function signOut() {
    await applicantApi.POST("/api/school-applications/me/sign-out").catch(() => undefined);
    queryClient.setQueryData(APPLICANT_KEY, null);
    navigate("/signup", { replace: true });
  }

  const application = me.application;
  const showForm = application?.status === "rejected" && reapplying;

  return (
    <div className="apply">
      <header className="apply__header">
        <h1>{t("onboarding.signup.apply.title")}</h1>
        <p className="apply__identity">
          {t("onboarding.signup.apply.signedInAs", {
            email: me.applicant.email,
            provider: me.applicant.provider === "microsoft" ? "Microsoft" : "Google",
          })}{" "}
          <Button variant="tertiary" onClick={() => void signOut()}>
            {t("onboarding.signup.apply.signOut")}
          </Button>
        </p>
      </header>

      {showForm || !application ? (
        <ApplicationFormView me={me} />
      ) : (
        <StatusPanel
          application={application}
          email={me.applicant.email}
          onReapply={() => setReapplying(true)}
        />
      )}
    </div>
  );
}

function StatusPanel({
  application,
  email,
  onReapply,
}: {
  application: ApplicantApplication;
  email: string;
  onReapply: () => void;
}) {
  const { t } = useTranslation();
  const { formatDate } = useFormatters();
  const submitted = formatDate(new Date(application.created_at), { dateStyle: "medium" });

  return (
    <section className="apply__status" aria-labelledby="apply-status-title" role="status">
      <h2 id="apply-status-title">
        {t(`onboarding.signup.status.${application.status}.title`, {
          school: application.school_name,
        })}
      </h2>
      <p>
        {t(`onboarding.signup.status.${application.status}.body`, {
          school: application.school_name,
          email,
          date: submitted,
        })}
      </p>
      {application.status === "rejected" && application.review_note ? (
        <>
          <p className="apply__identity">{t("onboarding.signup.status.rejected.reason")}</p>
          <p className="apply__reason">{application.review_note}</p>
        </>
      ) : null}
      <div className="apply__actions">
        {application.status === "approved" ? (
          <LinkButton href="/auth/login">
            {t("onboarding.signup.status.approved.action")}
          </LinkButton>
        ) : null}
        {application.status === "rejected" ? (
          <Button onClick={onReapply}>{t("onboarding.signup.status.rejected.action")}</Button>
        ) : null}
      </div>
    </section>
  );
}

function ApplicationFormView({ me }: { me: ApplicantMe }) {
  const { t } = useTranslation();
  const { locale } = useLocale();
  const queryClient = useQueryClient();
  const proofId = useId();
  const messageId = useId();
  const [values, setValues] = useState<ApplicationForm>({
    ...EMPTY_APPLICATION_FORM,
    applicant_name: me.applicant.name ?? "",
  });
  const [proof, setProof] = useState<File | null>(null);
  const [errors, setErrors] = useState<FieldErrors>({});
  const [submitError, setSubmitError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  const countriesQuery = useQuery({
    queryKey: ["lookups", "countries"],
    queryFn: async () => {
      const { data } = await api.GET("/api/lookups/countries");
      return data?.countries ?? [];
    },
  });
  const currenciesQuery = useQuery({
    queryKey: ["lookups", "currencies"],
    queryFn: async () => {
      const { data } = await api.GET("/api/lookups/currencies");
      return data?.currencies ?? [];
    },
  });

  function setField<K extends keyof ApplicationForm>(key: K, value: ApplicationForm[K]) {
    setValues((prev) => ({ ...prev, [key]: value }));
    setErrors((prev) => ({ ...prev, [key]: undefined }));
  }

  async function handleSubmit(event: FormEvent) {
    event.preventDefault();
    setSubmitError(null);
    const parsed = applicationFormSchema.safeParse(values);
    const proofError = proofFileError(proof);
    if (!parsed.success || proofError) {
      setErrors({
        ...(parsed.success ? {} : fieldErrors(parsed.error)),
        ...(proofError ? { proof: proofError } : {}),
      });
      return;
    }
    const form = parsed.data;
    const file = proof!;

    setSubmitting(true);
    try {
      const { data: upload } = await applicantApi.POST(
        "/api/school-applications/me/proof-upload-url",
        {
          body: {
            file_name: file.name,
            content_type: file.type as (typeof PROOF_CONTENT_TYPES)[number],
            size_bytes: file.size,
          },
        },
      );
      if (!upload) throw new Error("Upload URL request returned no data.");
      await uploadFileToPresignedUrl(upload.upload_url, file);

      await applicantApi.POST("/api/school-applications/me", {
        body: {
          applicant_name: form.applicant_name,
          applicant_phone: form.applicant_phone,
          school_name: form.school_name,
          school_email: form.school_email || undefined,
          country_id: form.country_id,
          default_currency_id: form.default_currency_id,
          city: form.city,
          address: form.address,
          website: form.website || undefined,
          student_count: form.student_count === "" ? undefined : Number(form.student_count),
          message: form.message || undefined,
          proof_storage_key: upload.storage_key,
          proof_file_name: file.name,
        },
      });
      await queryClient.invalidateQueries({ queryKey: APPLICANT_KEY });
    } catch (error) {
      const code = error instanceof ApiError ? error.code : null;
      setSubmitError(
        `onboarding.signup.errors.${code && KNOWN_SUBMIT_ERRORS.has(code) ? code : "generic"}`,
      );
      if (code === "SCHOOL_APPLICATION_ALREADY_PENDING") {
        await queryClient.invalidateQueries({ queryKey: APPLICANT_KEY });
      }
    } finally {
      setSubmitting(false);
    }
  }

  const err = (key: keyof FieldErrors) => {
    // eslint-disable-next-line security/detect-object-injection -- `key` is a fixed field name of this form
    const message = errors[key];
    return message ? t(message) : undefined;
  };

  return (
    <form
      className="apply__form"
      onSubmit={(event) => void handleSubmit(event)}
      noValidate
      aria-label={t("onboarding.signup.apply.title")}
    >
      <p>{t("onboarding.signup.apply.intro")}</p>

      <fieldset className="apply__fieldset">
        <legend>{t("onboarding.signup.apply.schoolSection")}</legend>
        <Input
          label={t("onboarding.signup.fields.schoolName")}
          value={values.school_name}
          onChange={(e) => setField("school_name", e.target.value)}
          error={err("school_name")}
          required
        />
        <div className="apply__row">
          <Select
            label={t("onboarding.schoolDetails.country")}
            placeholder={
              countriesQuery.isPending
                ? t("onboarding.schoolDetails.loadingCountries")
                : t("onboarding.schoolDetails.selectCountry")
            }
            options={((countriesQuery.data as readonly CountryOption[] | undefined) ?? []).map(
              (c) => ({
                value: c.id,
                label: displayName(locale, "region", c.alpha2_code, c.name),
              }),
            )}
            value={values.country_id || undefined}
            onChange={(value) => setField("country_id", value)}
            disabled={countriesQuery.isPending}
            error={err("country_id")}
            required
          />
          <Input
            label={t("onboarding.signup.fields.city")}
            value={values.city}
            onChange={(e) => setField("city", e.target.value)}
            error={err("city")}
            required
          />
        </div>
        <Input
          label={t("onboarding.signup.fields.address")}
          value={values.address}
          onChange={(e) => setField("address", e.target.value)}
          error={err("address")}
          required
        />
        <div className="apply__row">
          <Input
            label={t("onboarding.signup.fields.schoolEmail")}
            type="email"
            value={values.school_email}
            onChange={(e) => setField("school_email", e.target.value)}
            helperText={t("onboarding.signup.fields.optional")}
            error={err("school_email")}
          />
          <Input
            label={t("onboarding.signup.fields.website")}
            value={values.website}
            onChange={(e) => setField("website", e.target.value)}
            helperText={t("onboarding.signup.fields.optional")}
            error={err("website")}
          />
        </div>
        <div className="apply__row">
          <Input
            label={t("onboarding.signup.fields.studentCount")}
            inputMode="numeric"
            value={values.student_count}
            onChange={(e) => setField("student_count", e.target.value)}
            helperText={t("onboarding.signup.fields.optional")}
            error={err("student_count")}
          />
          <Select
            label={t("onboarding.schoolDetails.currency")}
            placeholder={
              currenciesQuery.isPending
                ? t("onboarding.schoolDetails.loadingCurrencies")
                : t("onboarding.schoolDetails.selectCurrency")
            }
            options={((currenciesQuery.data as readonly CurrencyOption[] | undefined) ?? []).map(
              (c) => ({
                value: c.id,
                label: t("onboarding.schoolDetails.codedOption", {
                  name: displayName(locale, "currency", c.code, c.name),
                  code: c.code,
                }),
              }),
            )}
            value={values.default_currency_id || undefined}
            onChange={(value) => setField("default_currency_id", value)}
            disabled={currenciesQuery.isPending}
            error={err("default_currency_id")}
            required
          />
        </div>
      </fieldset>

      <fieldset className="apply__fieldset">
        <legend>{t("onboarding.signup.apply.applicantSection")}</legend>
        <div className="apply__row">
          <Input
            label={t("onboarding.signup.fields.applicantName")}
            value={values.applicant_name}
            onChange={(e) => setField("applicant_name", e.target.value)}
            error={err("applicant_name")}
            required
          />
          <Input
            label={t("onboarding.signup.fields.phone")}
            type="tel"
            autoComplete="tel"
            value={values.applicant_phone}
            onChange={(e) => setField("applicant_phone", e.target.value)}
            error={err("applicant_phone")}
            required
          />
        </div>
      </fieldset>

      <fieldset className="apply__fieldset">
        <legend>{t("onboarding.signup.apply.proofSection")}</legend>
        <div className="sf-field">
          <label className="sf-field__label" htmlFor={proofId}>
            {t("onboarding.signup.fields.proof")}
          </label>
          <p className="sf-field__helper">{t("onboarding.signup.fields.proofHelper")}</p>
          <div className="sf-input">
            <input
              id={proofId}
              className="sf-input__control"
              type="file"
              accept={PROOF_CONTENT_TYPES.join(",")}
              aria-invalid={errors.proof ? true : undefined}
              onChange={(event) => {
                setProof(event.target.files?.[0] ?? null);
                setErrors((prev) => ({ ...prev, proof: undefined }));
              }}
            />
          </div>
          {proof ? <p className="apply__file-name">{proof.name}</p> : null}
          {errors.proof ? (
            <p className="sf-field__error" role="alert">
              {t(errors.proof)}
            </p>
          ) : null}
        </div>

        <div className="sf-field">
          <label className="sf-field__label" htmlFor={messageId}>
            {t("onboarding.signup.fields.message")}
          </label>
          <div className="sf-input">
            <textarea
              id={messageId}
              className="sf-input__control"
              rows={4}
              maxLength={5000}
              value={values.message}
              onChange={(e) => setField("message", e.target.value)}
            />
          </div>
        </div>
      </fieldset>

      {submitError ? <p role="alert">{t(submitError)}</p> : null}

      <div className="apply__actions">
        <Button type="submit" loading={submitting}>
          {t("onboarding.signup.apply.submit")}
        </Button>
      </div>
    </form>
  );
}
