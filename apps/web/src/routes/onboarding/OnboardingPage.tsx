import { ApiError } from "@studafy/api-client";
import { useToast } from "@studafy/ui";
import { useMutation } from "@tanstack/react-query";
import { useEffect, useState } from "react";

import { REGISTRATION_EVENTS, track } from "../../lib/analytics";
import { api } from "../../lib/api";
import { useTranslation } from "../../lib/i18n";

import { AdminContactStep } from "./AdminContactStep";
import { RegistrationResult } from "./RegistrationResult";
import { SchoolDetailsStep } from "./SchoolDetailsStep";

import type { AdminContact, SchoolDetails } from "./schema";

type Step = "school" | "admin" | "result";

const EMPTY_SCHOOL_DETAILS: SchoolDetails = {
  school_name: "",
  slug: "",
  email: "",
  country_id: "",
  default_currency_id: "",
};

const EMPTY_ADMIN_CONTACT: AdminContact = { admin_email: "", admin_name: "" };

/** How long the resend button stays disabled after a successful resend — UX-only debounce, not a security control (the endpoint itself is idempotent). */
const RESEND_COOLDOWN_MS = 30_000;

/**
 * Public school self-registration (`/onboarding`). Two input steps (school details, administrator
 * contact) followed by a result screen — see `POST /api/schools/register` in
 * `apps/api/src/modules/tenancy/registration/`. There is no in-app "enter your code" verification
 * step: the email's verification link hits the API directly
 * (`GET /api/schools/verify-email/{token}`), so the result screen both explains that and offers a
 * resend action for `POST /api/schools/resend-verification`.
 */
export default function OnboardingPage() {
  const { t } = useTranslation();
  const toast = useToast();
  const [step, setStep] = useState<Step>("school");
  const [schoolDetails, setSchoolDetails] = useState<SchoolDetails>(EMPTY_SCHOOL_DETAILS);
  const [adminContact, setAdminContact] = useState<AdminContact>(EMPTY_ADMIN_CONTACT);
  const [serverFieldErrors, setServerFieldErrors] = useState<
    Partial<Record<keyof SchoolDetails, string>>
  >({});
  const [banner, setBanner] = useState<string | null>(null);
  const [resetCaptchaSignal, setResetCaptchaSignal] = useState(0);
  const [canResend, setCanResend] = useState(true);

  useEffect(() => {
    track(REGISTRATION_EVENTS.STARTED);
  }, []);

  const registerMutation = useMutation({
    mutationFn: async (payload: {
      school_name: string;
      slug: string;
      email: string;
      country_id: string;
      default_currency_id: string;
      admin_email: string;
      admin_name?: string;
      captcha_token: string;
    }) => {
      const { data } = await api.POST("/api/schools/register", { body: payload });
      return data;
    },
    onSuccess: () => {
      setBanner(null);
      setStep("result");
      track(REGISTRATION_EVENTS.SUCCEEDED);
    },
    onError: (error: unknown) => {
      const apiError = error instanceof ApiError ? error : null;
      track(REGISTRATION_EVENTS.FAILED, { reason: apiError?.code ?? "unknown" });
      setResetCaptchaSignal((n) => n + 1);

      if (apiError?.code === "SCHOOL_SLUG_DUPLICATE") {
        setServerFieldErrors({ slug: "onboarding.register.slugTaken" });
        setStep("school");
        return;
      }
      if (apiError?.code === "SCHOOL_EMAIL_DUPLICATE") {
        setServerFieldErrors({ email: "onboarding.register.emailTaken" });
        setStep("school");
        return;
      }
      if (apiError?.code === "RATE_LIMIT_EXCEEDED") {
        setBanner(t("onboarding.register.rateLimited"));
        return;
      }
      setBanner(apiError?.detail || t("onboarding.common.genericError"));
    },
  });

  const resendMutation = useMutation({
    mutationFn: async (email: string) => {
      await api.POST("/api/schools/resend-verification", { body: { email } });
    },
    onSuccess: () => {
      track(REGISTRATION_EVENTS.VERIFICATION_RESEND_SUCCEEDED);
      toast.show({
        title: t("onboarding.register.resendToastTitle"),
        description: t("onboarding.register.resendToastDescription", {
          email: schoolDetails.email,
        }),
        variant: "success",
      });
      setCanResend(false);
      window.setTimeout(() => setCanResend(true), RESEND_COOLDOWN_MS);
    },
  });

  return (
    <div>
      <p aria-hidden="true">
        {t("onboarding.register.stepIndicator", {
          current: step === "result" ? 3 : step === "admin" ? 2 : 1,
          total: 3,
        })}
      </p>

      {banner ? <p role="alert">{banner}</p> : null}

      {step === "school" ? (
        <SchoolDetailsStep
          defaultValues={schoolDetails}
          serverErrors={serverFieldErrors}
          onNext={(values) => {
            setSchoolDetails(values);
            setServerFieldErrors({});
            setStep("admin");
            track(REGISTRATION_EVENTS.STEP_COMPLETED, { step: "school" });
          }}
        />
      ) : null}

      {step === "admin" ? (
        <AdminContactStep
          defaultValues={adminContact}
          submitting={registerMutation.isPending}
          resetCaptchaSignal={resetCaptchaSignal}
          onBack={(values) => {
            setAdminContact(values);
            setStep("school");
          }}
          onSubmit={(values, captchaToken) => {
            setAdminContact(values);
            track(REGISTRATION_EVENTS.SUBMITTED);
            registerMutation.mutate({
              school_name: schoolDetails.school_name,
              slug: schoolDetails.slug,
              email: schoolDetails.email,
              country_id: schoolDetails.country_id,
              default_currency_id: schoolDetails.default_currency_id,
              admin_email: values.admin_email,
              admin_name: values.admin_name || undefined,
              captcha_token: captchaToken,
            });
          }}
        />
      ) : null}

      {step === "result" ? (
        <RegistrationResult
          schoolName={schoolDetails.school_name}
          schoolEmail={schoolDetails.email}
          adminEmail={adminContact.admin_email}
          resending={resendMutation.isPending}
          resendDisabled={!canResend || resendMutation.isPending}
          onResend={() => {
            track(REGISTRATION_EVENTS.VERIFICATION_RESEND_REQUESTED);
            resendMutation.mutate(schoolDetails.email);
          }}
        />
      ) : null}
    </div>
  );
}
