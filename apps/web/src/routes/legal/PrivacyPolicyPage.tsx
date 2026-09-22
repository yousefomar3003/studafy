import { Link } from "react-router-dom";

import { useSeo } from "../../components/Seo";
import { MARKETING_CONTACT_EMAIL } from "../../lib/config";

const LAST_UPDATED = "2026-09-22";

/**
 * Public privacy policy (`/privacy`) — required by both app stores' listing forms
 * (`apps/mobile/store/listing-metadata.md`) and by `apps/mobile/store/privacy-labels.md`'s data
 * mapping, which this page's content mirrors rather than restates independently. No `RequireAuth`:
 * both stores' review flows, and any visitor deciding whether to sign up, need to reach this
 * without an account.
 *
 * This is a working draft grounded in what the codebase actually does (see privacy-labels.md's
 * per-data-type sourcing), not boilerplate — but it is still legal copy, and should get a
 * compliance/legal review before a store submission relies on it as final.
 */
export default function PrivacyPolicyPage() {
  useSeo({
    title: "Privacy policy",
    description: "What Studafy collects, why, and how to request your data or its deletion.",
    path: "/privacy",
  });

  return (
    <section className="marketing-section">
      <div className="marketing-container marketing-about-body">
        <h1>Privacy policy</h1>
        <p>Last updated {LAST_UPDATED}.</p>

        <p>
          Studafy is provided to schools, who set up accounts for their students, families, and
          staff. This page explains what the Studafy web and mobile apps collect from those
          accounts, why, and how to request a copy of your data or its deletion.
        </p>

        <h2>Accounts</h2>
        <p>
          Studafy accounts are created by your school, not by signing up directly. Signing in uses
          your school-configured identity provider (Microsoft or Google) — Studafy does not see or
          store your password.
        </p>

        <h2>What we collect</h2>
        <p>
          Everything below is collected either by Studafy&rsquo;s own servers, or by our crash and
          performance diagnostics vendors (Firebase and Sentry) acting on our behalf. We do not use
          any advertising or analytics network, and we do not sell or share your data with anyone
          for their own purposes.
        </p>
        <ul>
          <li>
            <strong>Education records.</strong> Timetable, grades, attendance, assignments, course
            materials, and — for a teacher&rsquo;s own classes — discipline incident reports.
          </li>
          <li>
            <strong>Account identifiers.</strong> An internal account id and, if you enable push
            notifications, a device push token, so notifications and crash reports can be tied to
            your account.
          </li>
          <li>
            <strong>Crash and performance diagnostics.</strong> If the app crashes or performs
            poorly, technical details (device type, OS version, a stack trace) are sent to our
            crash-reporting vendors, identified only by your internal account id — never your name
            or email.
          </li>
          <li>
            <strong>Content you or your school upload.</strong> Photos taken for teaching materials,
            uploaded documents, and assignment submissions.
          </li>
          <li>
            <strong>Billing history</strong> (parents/guardians only), if your school bills you
            through Studafy: invoice amounts and payment status. Card details are entered on our
            payment processor&rsquo;s own page, never stored by Studafy.
          </li>
        </ul>
        <p>
          We do not collect your name, email address, or phone number directly — those are held by
          your school and your identity provider, not typed into a Studafy form.
        </p>

        <h2>Your rights</h2>
        <p>You can request a copy of your data, or request that it be deleted, at any time:</p>
        <ul>
          <li>
            Signed in, from <Link to="/account/delete">Account settings</Link>.
          </li>
          <li>
            Otherwise, by contacting your school, or by emailing us directly — see Contact below.
          </li>
        </ul>
        <p>
          Deletion is a request, not an instant action: it is queued and processed within 30 days.
          Some records (for example, financial records your school is legally required to retain)
          may be kept past that point where the law requires it; anything retained this way is
          disclosed in the request&rsquo;s own result, not silently kept back.
        </p>

        <h2>Contact</h2>
        {MARKETING_CONTACT_EMAIL ? (
          <p>
            Questions about this policy or your data:{" "}
            <a href={`mailto:${MARKETING_CONTACT_EMAIL}`}>{MARKETING_CONTACT_EMAIL}</a>.
          </p>
        ) : (
          <p>Contact address not yet configured (set VITE_MARKETING_CONTACT_EMAIL).</p>
        )}
      </div>
    </section>
  );
}
