import { ApiError } from "@studafy/api-client";
import { Button, Input } from "@studafy/ui";
import { useRef, useState } from "react";
import { Link } from "react-router-dom";
import { z } from "zod";

import { useSeo } from "../../components/Seo";
import { TurnstileWidget } from "../../components/TurnstileWidget";
import { api } from "../../lib/api";
import { MARKETING_CONTACT_EMAIL, TURNSTILE_SITE_KEY } from "../../lib/config";

import type { TurnstileWidgetHandle } from "../../components/TurnstileWidget";
import type { FormEvent } from "react";

/**
 * Public "delete your account" page (`/legal/delete-account`) — the URL declared in Google Play's
 * Data Safety form and linked from the site footer and the privacy policy. Google Play checks that
 * it works for a reviewer who has never installed the app, so there is no `RequireAuth`: a signed-in
 * user is pointed at `/account/delete`, anyone else asks for an emailed link here
 * (`POST /api/account/deletion-requests`), which opens `/legal/delete-account/confirm`.
 */
export default function DeleteAccountInfoPage() {
  useSeo({
    title: "Delete your account",
    description: "How to request deletion of your Studafy account and data.",
    path: "/legal/delete-account",
  });

  return (
    <section className="marketing-section">
      <div className="marketing-container marketing-about-body">
        <h1>Delete your account</h1>

        <p>
          You can delete your Studafy account and its data at any time, with or without the app.
          Personal data is erased within 30 days; see the <Link to="/privacy">privacy policy</Link>{" "}
          for the records the law requires your school to keep.
        </p>

        <h2>If you can sign in</h2>
        <p>
          Go to <Link to="/account/delete">Account settings &rsaquo; Delete account</Link> in the
          Studafy web app (or the equivalent screen in the mobile app) and confirm. It takes effect
          immediately — no one else needs to act on it.
        </p>

        <h2>Without signing in</h2>
        <p>
          Enter the email address your school uses for your account. If it has a Studafy account, we
          will email it a link to confirm the deletion. The link works once, for one hour.
        </p>
        <DeletionRequestForm />
        <p>
          No longer have access to that mailbox? Contact your school
          {MARKETING_CONTACT_EMAIL ? (
            <>
              , or email us at{" "}
              <a href={`mailto:${MARKETING_CONTACT_EMAIL}`}>{MARKETING_CONTACT_EMAIL}</a>
            </>
          ) : null}
          .
        </p>

        <h2>What happens</h2>
        <p>
          Straight away, you are signed out on every device, your account is removed from your
          school, and any AI subscription is cancelled so it does not renew. Within 30 days, your
          name, contact details and profile are erased. We email you a confirmation.
        </p>
        <p>
          Your school keeps only the records it is legally required to: your grades and attendance
          (without your name or contact details), financial records, and its audit log. The
          confirmation screen lists these — see the <Link to="/privacy">privacy policy</Link> for
          detail.
        </p>
      </div>
    </section>
  );
}

/** Same rule the API applies to the request body. */
const accountEmailSchema = z.email().max(320);

function DeletionRequestForm() {
  const [email, setEmail] = useState("");
  const [captchaToken, setCaptchaToken] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [sentTo, setSentTo] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const turnstileRef = useRef<TurnstileWidgetHandle>(null);

  async function handleSubmit(event: FormEvent) {
    event.preventDefault();
    if (!accountEmailSchema.safeParse(email.trim()).success) {
      setError("Enter a valid email address.");
      return;
    }
    if (!captchaToken) {
      setError("Complete the challenge before submitting.");
      return;
    }

    setSubmitting(true);
    setError(null);
    try {
      await api.POST("/api/account/deletion-requests", {
        body: { email: email.trim(), captcha_token: captchaToken },
      });
      setSentTo(email.trim());
    } catch (caught) {
      const code = caught instanceof ApiError ? caught.code : null;
      setError(
        code === "RATE_LIMIT_EXCEEDED"
          ? "Too many attempts. Please wait a few minutes and try again."
          : code === "CAPTCHA_INVALID"
            ? "The challenge expired. Please complete it again."
            : "Something went wrong. Please try again.",
      );
      // Turnstile tokens are single-use.
      setCaptchaToken("");
      turnstileRef.current?.reset();
    } finally {
      setSubmitting(false);
    }
  }

  if (sentTo) {
    return (
      <p role="status">
        If {sentTo} has a Studafy account, we have sent it a link to confirm the deletion. Check
        your inbox and spam folder; the link expires in one hour.
      </p>
    );
  }

  return (
    <form onSubmit={handleSubmit} noValidate aria-label="Request account deletion">
      <Input
        label="Account email"
        type="email"
        autoComplete="email"
        value={email}
        onChange={(e) => setEmail(e.target.value)}
        required
      />
      <TurnstileWidget
        ref={turnstileRef}
        siteKey={TURNSTILE_SITE_KEY}
        onToken={setCaptchaToken}
        onInvalidate={() => setCaptchaToken("")}
      />
      {error ? <p role="alert">{error}</p> : null}
      <Button type="submit" loading={submitting}>
        Email me a deletion link
      </Button>
    </form>
  );
}
