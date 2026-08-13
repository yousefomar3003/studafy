import { Button, Input } from "@studafy/ui";
import { useEffect, useRef, useState } from "react";

import { TurnstileWidget } from "../../components/TurnstileWidget";
import { TURNSTILE_SITE_KEY } from "../../lib/config";

import { adminContactSchema, fieldErrors } from "./schema";

import type { AdminContact } from "./schema";
import type { TurnstileWidgetHandle } from "../../components/TurnstileWidget";
import type { FormEvent } from "react";

export interface AdminContactStepProps {
  defaultValues: AdminContact;
  submitting: boolean;
  /** Bumped by the parent after a failed submit — Turnstile tokens are single-use, so a retry needs a fresh one. */
  resetCaptchaSignal: number;
  onBack: (values: AdminContact) => void;
  onSubmit: (values: AdminContact, captchaToken: string) => void;
}

/** Step 2: the first administrator's contact details, plus the bot-protection challenge. */
export function AdminContactStep({
  defaultValues,
  submitting,
  resetCaptchaSignal,
  onBack,
  onSubmit,
}: AdminContactStepProps) {
  const [values, setValues] = useState(defaultValues);
  const [errors, setErrors] = useState<Partial<Record<keyof AdminContact, string>>>({});
  const [captchaToken, setCaptchaToken] = useState("");
  const [captchaError, setCaptchaError] = useState<string | undefined>(undefined);
  const turnstileRef = useRef<TurnstileWidgetHandle>(null);
  const isFirstRender = useRef(true);

  useEffect(() => {
    if (isFirstRender.current) {
      isFirstRender.current = false;
      return;
    }
    setCaptchaToken("");
    turnstileRef.current?.reset();
  }, [resetCaptchaSignal]);

  function setField<K extends keyof AdminContact>(key: K, value: AdminContact[K]) {
    setValues((prev) => ({ ...prev, [key]: value }));
    setErrors((prev) => {
      if (!(key in prev)) return prev;
      const next = { ...prev };
      // eslint-disable-next-line security/detect-object-injection -- `key` is `keyof AdminContact`, a fixed set of literal field names, not user-controlled
      delete next[key];
      return next;
    });
  }

  function handleSubmit(event: FormEvent) {
    event.preventDefault();
    const result = adminContactSchema.safeParse(values);
    if (!result.success) {
      setErrors(fieldErrors(result.error));
      return;
    }
    if (!captchaToken) {
      setCaptchaError("Complete the challenge before submitting.");
      return;
    }
    setCaptchaError(undefined);
    onSubmit(result.data, captchaToken);
  }

  return (
    <form onSubmit={handleSubmit} noValidate aria-label="Administrator contact">
      <h2>Administrator contact</h2>

      <Input
        label="Administrator email"
        type="email"
        value={values.admin_email}
        onChange={(e) => setField("admin_email", e.target.value)}
        helperText={
          !errors.admin_email ? "We'll send an account-activation invitation here." : undefined
        }
        error={errors.admin_email}
        required
      />

      <Input
        label="Administrator name"
        value={values.admin_name ?? ""}
        onChange={(e) => setField("admin_name", e.target.value)}
        error={errors.admin_name}
      />

      <TurnstileWidget
        ref={turnstileRef}
        siteKey={TURNSTILE_SITE_KEY}
        onToken={(token) => {
          setCaptchaToken(token);
          setCaptchaError(undefined);
        }}
        onInvalidate={() => setCaptchaToken("")}
      />
      {captchaError ? <p role="alert">{captchaError}</p> : null}

      <Button
        type="button"
        variant="secondary"
        onClick={() => onBack(values)}
        disabled={submitting}
      >
        Back
      </Button>
      <Button type="submit" loading={submitting}>
        Create school account
      </Button>
    </form>
  );
}
