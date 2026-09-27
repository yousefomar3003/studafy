import { ApiError } from "@studafy/api-client";
import { Button } from "@studafy/ui";
import { useEffect, useState } from "react";
import { Link, useLocation, useNavigate } from "react-router-dom";

import { useSeo } from "../../components/Seo";
import { api } from "../../lib/api";

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
  useSeo({
    title: "Confirm account deletion",
    description: "Confirm deletion of your Studafy account.",
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
          ? "This link is invalid, has expired, or has already been used."
          : (apiError?.detail ?? "Something went wrong. Please try again."),
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
            <h1>Delete your account</h1>
            {token ? (
              <>
                <p>
                  This deletes the Studafy account registered to your email address, in every school
                  it belongs to. Straight away, you are signed out on every device, the account is
                  removed from the school, and any AI subscription is cancelled. Your name, contact
                  details and profile are erased within 30 days.
                </p>
                <p>
                  <strong>This cannot be undone.</strong>
                </p>
                {error ? <p role="alert">{error}</p> : null}
                <Button
                  type="button"
                  variant="tertiary"
                  loading={submitting}
                  onClick={handleConfirm}
                >
                  Delete my account
                </Button>
              </>
            ) : (
              <p role="alert">This link is incomplete.</p>
            )}
            {error || !token ? (
              <p>
                <Link to="/legal/delete-account">Request a new link</Link>
              </p>
            ) : null}
          </>
        )}
      </div>
    </section>
  );
}

function DeletionResult({ result }: { result: ConfirmedDeletion }) {
  if (result.accounts.length === 0) {
    return (
      <>
        <h1>Nothing to delete</h1>
        <p role="status">
          There is no active Studafy account for this email address any more. It may already have
          been deleted.
        </p>
      </>
    );
  }

  return (
    <>
      <h1>Your account has been deleted</h1>
      <ul role="status">
        {result.accounts.map((account) => (
          <li key={account.request_id}>
            {account.school_name}: personal data erased by{" "}
            {new Date(account.completes_by).toLocaleDateString()}.
          </li>
        ))}
      </ul>
      <p>We have emailed you a confirmation. Your school keeps only these records:</p>
      <ul>
        {result.retained_records.map((record) => (
          <li key={record.category}>{record.description}</li>
        ))}
      </ul>
      <p>
        See the <Link to="/privacy">privacy policy</Link> for why.
      </p>
    </>
  );
}
