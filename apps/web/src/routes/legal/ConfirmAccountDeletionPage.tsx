import { ApiError } from "@studafy/api-client";
import { Button } from "@studafy/ui";
import { useEffect, useState } from "react";
import { Link, useLocation, useNavigate } from "react-router-dom";

import { useSeo } from "../../components/Seo";
import { api } from "../../lib/api";
import { Trans, useFormatters, useTranslation } from "../../lib/i18n";

import type { components } from "@studafy/api-client";

type ConfirmedDeletion = components["schemas"]["AccountDeletionConfirmed"];

/**
 * Where the emailed deletion link lands (`/legal/delete-account/confirm#token=...`). Public, like
 * the page that sends the link.
 *
 * The token is in the fragment so it never reaches a server log, and it is removed from the address
 * bar once read so it does not stay in browser history. Nothing is deleted until the button is
 * pressed: mail scanners open links on their own, and a GET must never delete an account.
 */
export default function ConfirmAccountDeletionPage() {
  const { t } = useTranslation();
  useSeo({
    title: t("onboarding.legal.confirmDeletion.seoTitle"),
    description: t("onboarding.legal.confirmDeletion.seoDescription"),
    path: "/legal/delete-account/confirm",
  });

  const { hash, pathname } = useLocation();
  const navigate = useNavigate();
  const [token] = useState(() => new URLSearchParams(hash.slice(1)).get("token"));
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<ConfirmedDeletion | null>(null);

  useEffect(() => {
    if (hash) navigate(pathname, { replace: true });
  }, [hash, pathname, navigate]);

  async function handleConfirm() {
    if (!token) return;
    setSubmitting(true);
    setError(null);
    try {
      const { data } = await api.POST("/api/account/deletion-requests/confirm", {
        body: { token },
      });
      // Nested arrays lose their array type through the generated client (see
      // features/account/privacy/mutations.ts), so the schema type is asserted.
      setResult((data as ConfirmedDeletion | undefined) ?? null);
    } catch (caught) {
      const apiError = caught instanceof ApiError ? caught : null;
      setError(
        apiError?.code === "VERIFICATION_TOKEN_INVALID"
          ? t("onboarding.legal.confirmDeletion.linkInvalid")
          : (apiError?.detail ?? t("onboarding.common.genericError")),
      );
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <section className="marketing-section">
      <div className="marketing-container marketing-about-body">
        {result ? (
          <DeletionResult result={result} />
        ) : (
          <>
            <h1>{t("onboarding.legal.confirmDeletion.title")}</h1>
            {token ? (
              <>
                <p>{t("onboarding.legal.confirmDeletion.body")}</p>
                <p>
                  <strong>{t("onboarding.legal.confirmDeletion.irreversible")}</strong>
                </p>
                {error ? <p role="alert">{error}</p> : null}
                <Button
                  type="button"
                  variant="tertiary"
                  loading={submitting}
                  onClick={handleConfirm}
                >
                  {t("onboarding.legal.confirmDeletion.submit")}
                </Button>
              </>
            ) : (
              <p role="alert">{t("onboarding.legal.confirmDeletion.linkIncomplete")}</p>
            )}
            {error || !token ? (
              <p>
                <Link to="/legal/delete-account">
                  {t("onboarding.legal.confirmDeletion.requestNewLink")}
                </Link>
              </p>
            ) : null}
          </>
        )}
      </div>
    </section>
  );
}

function DeletionResult({ result }: { result: ConfirmedDeletion }) {
  const { t } = useTranslation();
  const { formatDate } = useFormatters();

  if (result.accounts.length === 0) {
    return (
      <>
        <h1>{t("onboarding.legal.confirmDeletion.nothingTitle")}</h1>
        <p role="status">{t("onboarding.legal.confirmDeletion.nothingBody")}</p>
      </>
    );
  }

  return (
    <>
      <h1>{t("onboarding.legal.confirmDeletion.deletedTitle")}</h1>
      <ul role="status">
        {result.accounts.map((account) => (
          <li key={account.request_id}>
            {t("onboarding.legal.confirmDeletion.erasedBy", {
              school: account.school_name,
              date: formatDate(new Date(account.completes_by)),
            })}
          </li>
        ))}
      </ul>
      <p>{t("onboarding.legal.confirmDeletion.retainedIntro")}</p>
      <ul>
        {result.retained_records.map((record) => (
          <li key={record.category}>{record.description}</li>
        ))}
      </ul>
      <p>
        <Trans
          i18nKey="onboarding.legal.confirmDeletion.seePrivacy"
          components={{ privacyLink: <Link to="/privacy" /> }}
        />
      </p>
    </>
  );
}
