import { Button, Card, Checkbox } from "@studafy/ui";
import { useState } from "react";
import { Link } from "react-router-dom";

import { api } from "../../../lib/api";
import { useSessionStore } from "../../../lib/auth";
import { Trans, useTranslation } from "../../../lib/i18n";

export interface LegalVersions {
  terms_version: string;
  privacy_version: string;
}

/**
 * Shown in place of the app until the signed-in user accepts the current Terms of Service and
 * confirms they have read the Privacy Policy (000188). The API refuses every other request from
 * such a session (403 LEGAL_ACCEPTANCE_REQUIRED), so the screen offers only what it allows:
 * accept, delete the account, or sign out. A first sign-in and a later change to either document
 * both land here; `isUpdate` picks the wording.
 *
 * Accepting reloads the page: that restores the session from the refresh cookie, which mints an
 * access token without the `legal_acceptance_pending` claim. Mirrors the mobile app's
 * LegalAcceptanceScreen.
 */
export function LegalAcceptanceScreen({
  versions,
  isUpdate,
}: {
  versions: LegalVersions;
  isUpdate: boolean;
}) {
  const { t } = useTranslation();
  const store = useSessionStore();
  const [accepted, setAccepted] = useState(false);
  const [showRequired, setShowRequired] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [failed, setFailed] = useState<"generic" | "outdated" | null>(null);

  async function accept() {
    if (!accepted) {
      setShowRequired(true);
      return;
    }
    setSubmitting(true);
    setFailed(null);
    const { error } = await api.POST("/api/account/legal-acceptance", {
      body: { terms_version: versions.terms_version, privacy_version: versions.privacy_version },
    });
    if (error) {
      setSubmitting(false);
      const code = (error as { code?: string }).code;
      setFailed(code === "LEGAL_VERSION_OUTDATED" ? "outdated" : "generic");
      return;
    }
    window.location.reload();
  }

  const newTab = { target: "_blank", rel: "noopener" } as const;

  return (
    <Card as="section" aria-labelledby="legal-acceptance-heading">
      <Card.Header>
        <h1 id="legal-acceptance-heading">
          {t(isUpdate ? "legalAcceptance.updatedTitle" : "legalAcceptance.title")}
        </h1>
      </Card.Header>
      <Card.Body>
        <p>{t(isUpdate ? "legalAcceptance.updatedBody" : "legalAcceptance.body")}</p>
        <ul>
          <li>
            <a href="/terms" {...newTab}>
              {t("legalAcceptance.termsLink")}
            </a>
          </li>
          <li>
            <a href="/privacy" {...newTab}>
              {t("legalAcceptance.privacyLink")}
            </a>
          </li>
        </ul>
        <Checkbox
          label={t("legalAcceptance.checkbox")}
          checked={accepted}
          onChange={(event) => {
            setAccepted(event.target.checked);
            setShowRequired(false);
          }}
          error={showRequired ? t("legalAcceptance.required") : undefined}
        />
        {failed ? (
          <p role="alert">
            {t(failed === "outdated" ? "legalAcceptance.outdated" : "legalAcceptance.failed")}
          </p>
        ) : null}
        <Button type="button" onClick={() => void accept()} loading={submitting}>
          {t("legalAcceptance.accept")}
        </Button>{" "}
        <Button
          type="button"
          variant="secondary"
          onClick={() => void store.logout()}
          disabled={submitting}
        >
          {t("legalAcceptance.signOut")}
        </Button>
        <p>
          <Trans
            i18nKey="legalAcceptance.decline"
            // The public deletion page: /account/delete sits behind this same gate.
            components={{ deleteLink: <Link to="/legal/delete-account" /> }}
          />
        </p>
      </Card.Body>
    </Card>
  );
}
