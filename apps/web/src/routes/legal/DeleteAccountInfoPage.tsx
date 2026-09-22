import { Link } from "react-router-dom";

import { useSeo } from "../../components/Seo";
import { MARKETING_CONTACT_EMAIL } from "../../lib/config";

/**
 * Public "how to delete your account" page (`/legal/delete-account`) — the reachable-without-
 * signing-in URL both Apple's account-deletion guidance and Google Play's Data Safety form ask
 * for, separate from the actual in-app action at `/account/delete` (which needs a session to know
 * whose account to delete). Google Play in particular checks that this URL works for a reviewer
 * who has never installed the app — no `RequireAuth`.
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
          You can request deletion of your Studafy account and its data at any time. Deletion is
          processed within 30 days; see the <Link to="/privacy">privacy policy</Link> for what may
          be retained past that point where the law requires it.
        </p>

        <h2>If you can sign in</h2>
        <p>
          Go to <Link to="/account/delete">Account settings &rsaquo; Delete account</Link> in the
          Studafy web app (or the equivalent screen in the mobile app) and confirm. This files the
          request immediately under your own account — no one else needs to act on it.
        </p>

        <h2>If you can&rsquo;t sign in</h2>
        <p>
          Contact your school directly, or email us and we&rsquo;ll route the request to your school
          on your behalf.
          {MARKETING_CONTACT_EMAIL ? (
            <>
              {" "}
              <a href={`mailto:${MARKETING_CONTACT_EMAIL}`}>{MARKETING_CONTACT_EMAIL}</a>.
            </>
          ) : null}
        </p>

        <h2>What gets deleted</h2>
        <p>
          Your profile and account identifiers, education records, uploaded content, and crash
          diagnostics tied to your account. Records your school is legally required to retain (for
          example, financial records) are kept only as long as the law requires, and that is
          disclosed in the request&rsquo;s own result — see the{" "}
          <Link to="/privacy">privacy policy</Link> for detail.
        </p>
      </div>
    </section>
  );
}
