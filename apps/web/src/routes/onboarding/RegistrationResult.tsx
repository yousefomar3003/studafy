import { Button, Card, CardBody } from "@studafy/ui";

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
  return (
    <Card>
      <CardBody>
        <h2>{schoolName} is registered</h2>

        <p>
          We sent a verification link to <strong>{schoolEmail}</strong>. Click it to activate your
          school — this also triggers your school&rsquo;s workspace setup.
        </p>

        <p>
          We also sent an account-activation invitation to <strong>{adminEmail}</strong>. It becomes
          usable once the school email above is verified.
        </p>

        <Button
          type="button"
          variant="secondary"
          loading={resending}
          disabled={resendDisabled}
          onClick={onResend}
        >
          Resend verification email
        </Button>
      </CardBody>
    </Card>
  );
}
