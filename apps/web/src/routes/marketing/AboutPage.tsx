import { Card } from "@studafy/ui";

import { useSeo } from "../../components/Seo";
import { MARKETING_CONTACT_EMAIL } from "../../lib/config";

/** About & contact page (`/about`). One page for both, matching the ticket's "about/contact" grouping. */
export default function AboutPage() {
  useSeo({
    title: "About & contact",
    description: "What Studafy is, and how to get in touch about bringing it to your school.",
    path: "/about",
  });

  return (
    <>
      <section className="marketing-hero">
        <div className="marketing-container">
          <h1 className="marketing-hero__title">About Studafy</h1>
          <p className="marketing-hero__subtitle">
            A school operations platform, built as one system rather than a bundle of separate
            tools.
          </p>
        </div>
      </section>

      <section className="marketing-section">
        <div className="marketing-container marketing-about-body">
          <p>
            Studafy runs the day-to-day of a school in a single system: academics and timetabling,
            attendance, grades and assessments, discipline, finance and billing, and a family portal
            with notifications — all sharing the same student, class, and school records instead of
            syncing between separate tools.
          </p>
          <p>
            Actions that need a second set of eyes — grade publishing, discipline decisions, and
            other review-gated changes — go through a shared approval queue with an audit trail, so
            there&rsquo;s a record of who signed off and when.
          </p>
          <p>
            Each school is provisioned as its own tenant, with its own data, roles, and permissions.
            An optional AI add-on (grounded question-answering and study-material summaries) is
            available on top of a school subscription.
          </p>
        </div>
      </section>

      <section id="contact" className="marketing-section marketing-section--muted">
        <div className="marketing-container">
          <div className="marketing-section__heading">
            <span className="marketing-section__eyebrow">Contact</span>
            <h2 className="marketing-section__title">Talk to us</h2>
            <p className="marketing-section__lede">
              Tell us about your school and we&rsquo;ll walk you through Studafy.
            </p>
          </div>

          <Card>
            <Card.Body>
              <div className="marketing-contact-card">
                <span className="marketing-contact-card__label">Email</span>
                {MARKETING_CONTACT_EMAIL ? (
                  <a
                    className="marketing-contact-card__email"
                    href={`mailto:${MARKETING_CONTACT_EMAIL}`}
                  >
                    {MARKETING_CONTACT_EMAIL}
                  </a>
                ) : (
                  <span className="marketing-contact-card__email">
                    Contact address not yet configured (set VITE_MARKETING_CONTACT_EMAIL)
                  </span>
                )}
              </div>
            </Card.Body>
          </Card>
        </div>
      </section>
    </>
  );
}
