import { Button, Card, CardBody } from "@studafy/ui";

import { Trans, useTranslation } from "../../lib/i18n";

export interface RegistrationResultProps {
  schoolName: string;
  schoolEmail: string;
  adminEmail: string;
  onResend: () => void;
  resending: boolean;
  resendDisabled: boolean;
}

/**
 * The terminal screen after a successful `POST /api/schools/register`. Covers both the "verify
 * your email" step and the "invitation was sent" success state from the ticket's acceptance
 * criteria — in practice they're the same screen, because the verification link in the email
 * points straight at the API (`GET /api/schools/verify-email/{token}`), not back into this app.
 * There is nothing else for the user to do here but check their inbox or ask for it again.
 */
export function RegistrationResult({
  schoolName,
  schoolEmail,
  adminEmail,
  onResend,
  resending,
  resendDisabled,
}: RegistrationResultProps) {
  const { t } = useTranslation();

  return (
    <Card>
      <CardBody>
        <h2>{t("onboarding.registrationResult.title", { schoolName })}</h2>

        <p>
          <Trans
            i18nKey="onboarding.registrationResult.verificationSent"
            values={{ email: schoolEmail }}
            components={{ strong: <strong /> }}
          />
        </p>

        <p>
          <Trans
            i18nKey="onboarding.registrationResult.invitationSent"
            values={{ email: adminEmail }}
            components={{ strong: <strong /> }}
          />
        </p>

        <Button
          type="button"
          variant="secondary"
          loading={resending}
          disabled={resendDisabled}
          onClick={onResend}
        >
          {t("onboarding.registrationResult.resend")}
        </Button>
      </CardBody>
    </Card>
  );
}
