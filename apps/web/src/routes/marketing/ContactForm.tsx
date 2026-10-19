import { ApiError } from "@studafy/api-client";
import { Button, Input } from "@studafy/ui";
import { useId, useRef, useState } from "react";
import { z } from "zod";

import { TurnstileWidget } from "../../components/TurnstileWidget";
import { api } from "../../lib/api";
import { TURNSTILE_SITE_KEY } from "../../lib/config";
import { useTranslation } from "../../lib/i18n";

import type { TurnstileWidgetHandle } from "../../components/TurnstileWidget";
import type { FormEvent } from "react";

/** Same rules `POST /api/inquiries` applies (apps/api/src/modules/inquiries/schemas.ts). */
const inquirySchema = z.object({
  fullName: z.string().trim().min(1).max(200),
  email: z.email().max(320),
  schoolName: z.string().trim().min(1).max(200),
  studentCount: z.union([z.literal(""), z.coerce.number().int().min(0).max(1_000_000)]),
});

const EMPTY = {
  fullName: "",
  email: "",
  phone: "",
  schoolName: "",
  country: "",
  studentCount: "",
  message: "",
};

type Fields = typeof EMPTY;
type FieldErrors = Partial<Record<keyof Fields, string>>;

/** The marketing page that sent the visitor here ("Talk to us" buttons all link to /about#contact). */
function sourcePath(): string {
  try {
    const referrer = document.referrer ? new URL(document.referrer) : null;
    if (referrer && referrer.origin === window.location.origin) return referrer.pathname;
  } catch {
    // Unparseable referrer: fall through to this page.
  }
  return window.location.pathname;
}

/**
 * The "Talk to us" form (`/about#contact`). Sends the prospect's details to `POST /api/inquiries`,
 * which stores them for the platform console's Inquiries page and emails the Studafy sales inbox.
 */
export function ContactForm() {
  const { t } = useTranslation();
  const [fields, setFields] = useState<Fields>(EMPTY);
  const [errors, setErrors] = useState<FieldErrors>({});
  const [captchaToken, setCaptchaToken] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [sent, setSent] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);
  const turnstileRef = useRef<TurnstileWidgetHandle>(null);

  const set = (key: keyof Fields) => (value: string) => {
    setFields((current) => ({ ...current, [key]: value }));
    setErrors((current) => ({ ...current, [key]: undefined }));
  };

  async function handleSubmit(event: FormEvent) {
    event.preventDefault();
    const parsed = inquirySchema.safeParse({
      fullName: fields.fullName,
      email: fields.email.trim(),
      schoolName: fields.schoolName,
      studentCount: fields.studentCount.trim(),
    });
    if (!parsed.success) {
      const next: FieldErrors = {};
      for (const issue of parsed.error.issues) {
        const key = issue.path[0] as keyof Fields;
        next[key] = t(`site.marketing.contactForm.errors.${key}`);
      }
      setErrors(next);
      return;
    }
    if (!captchaToken) {
      setFormError(t("site.marketing.contactForm.errors.captcha"));
      return;
    }

    setSubmitting(true);
    setFormError(null);
    const optional = (value: string) => value.trim() || undefined;
    try {
      await api.POST("/api/inquiries", {
        body: {
          full_name: fields.fullName.trim(),
          email: fields.email.trim(),
          phone: optional(fields.phone),
          school_name: fields.schoolName.trim(),
          country: optional(fields.country),
          student_count: parsed.data.studentCount === "" ? undefined : parsed.data.studentCount,
          message: optional(fields.message),
          source_path: sourcePath(),
          captcha_token: captchaToken,
        },
      });
      setSent(true);
    } catch (caught) {
      const code = caught instanceof ApiError ? caught.code : null;
      setFormError(
        code === "RATE_LIMIT_EXCEEDED"
          ? t("site.marketing.contactForm.errors.rateLimited")
          : code === "CAPTCHA_INVALID"
            ? t("site.marketing.contactForm.errors.captchaExpired")
            : t("site.marketing.contactForm.errors.generic"),
      );
      // Turnstile tokens are single-use.
      setCaptchaToken("");
      turnstileRef.current?.reset();
    } finally {
      setSubmitting(false);
    }
  }

  if (sent) {
    return (
      <div className="marketing-contact-form__sent" role="status">
        <h3>{t("site.marketing.contactForm.sentTitle")}</h3>
        <p>{t("site.marketing.contactForm.sentBody", { email: fields.email.trim() })}</p>
      </div>
    );
  }

  return (
    <form
      className="marketing-contact-form"
      onSubmit={handleSubmit}
      noValidate
      aria-label={t("site.marketing.contactForm.ariaLabel")}
    >
      <div className="marketing-contact-form__grid">
        <Input
          label={t("site.marketing.contactForm.fullName")}
          autoComplete="name"
          value={fields.fullName}
          onChange={(e) => set("fullName")(e.target.value)}
          error={errors.fullName}
          required
        />
        <Input
          label={t("site.marketing.contactForm.email")}
          type="email"
          autoComplete="email"
          value={fields.email}
          onChange={(e) => set("email")(e.target.value)}
          error={errors.email}
          required
        />
        <Input
          label={t("site.marketing.contactForm.phone")}
          type="tel"
          autoComplete="tel"
          value={fields.phone}
          onChange={(e) => set("phone")(e.target.value)}
          maxLength={50}
        />
        <Input
          label={t("site.marketing.contactForm.schoolName")}
          autoComplete="organization"
          value={fields.schoolName}
          onChange={(e) => set("schoolName")(e.target.value)}
          error={errors.schoolName}
          required
        />
        <Input
          label={t("site.marketing.contactForm.country")}
          autoComplete="country-name"
          value={fields.country}
          onChange={(e) => set("country")(e.target.value)}
          maxLength={120}
        />
        <Input
          label={t("site.marketing.contactForm.studentCount")}
          type="number"
          inputMode="numeric"
          min={0}
          value={fields.studentCount}
          onChange={(e) => set("studentCount")(e.target.value)}
          error={errors.studentCount}
        />
      </div>

      <MessageField
        label={t("site.marketing.contactForm.message")}
        value={fields.message}
        onChange={set("message")}
      />

      <div className="marketing-contact-form__footer">
        <TurnstileWidget
          ref={turnstileRef}
          siteKey={TURNSTILE_SITE_KEY}
          onToken={setCaptchaToken}
          onInvalidate={() => setCaptchaToken("")}
        />
        {formError ? (
          <p className="marketing-contact-form__error" role="alert">
            {formError}
          </p>
        ) : null}
        <Button type="submit" variant="primary" disabled={submitting}>
          {submitting
            ? t("site.marketing.contactForm.submitting")
            : t("site.marketing.contactForm.submit")}
        </Button>
      </div>
    </form>
  );
}

/** `sf-field`/`sf-input` chrome around a bare `<textarea>` — `@studafy/ui` has no Textarea. */
function MessageField({
  label,
  value,
  onChange,
}: {
  label: string;
  value: string;
  onChange: (value: string) => void;
}) {
  const fieldId = useId();
  return (
    <div className="sf-field">
      <label className="sf-field__label" htmlFor={fieldId}>
        {label}
      </label>
      <div className="sf-input marketing-contact-form__textarea">
        <textarea
          id={fieldId}
          className="sf-input__control"
          rows={5}
          maxLength={5000}
          value={value}
          onChange={(event) => onChange(event.target.value)}
        />
      </div>
    </div>
  );
}
