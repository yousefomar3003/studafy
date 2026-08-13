import { Card } from "@studafy/ui";

import { LinkButton } from "../../components/LinkButton";
import { useSeo } from "../../components/Seo";

const VALUE_PROPS = [
  {
    title: "Academics & attendance",
    body: "Terms, subjects, classes, timetables, enrollment, and daily attendance — with corrections that keep an audit trail instead of silently overwriting a record.",
  },
  {
    title: "Grades & discipline",
    body: "Gradebooks, assignments, submissions, and exam results staff can enter and publish, plus discipline records and evaluations in the same system.",
  },
  {
    title: "Finance & billing",
    body: "Fee structures, installments, scholarships and discounts, payments, refunds, and reconciliation — with reporting that adds up for finance staff, not just for parents.",
  },
  {
    title: "Family portal & notifications",
    body: "Guardians see attendance, grades, and balances for each child, and get notified through the channels your school already uses.",
  },
];

const STEPS = [
  {
    title: "Your school onboards",
    body: "We set up your school as its own tenant with its own data, roles, and permissions.",
  },
  {
    title: "Staff run the school day-to-day",
    body: "Teachers, admins, and finance staff work in one system instead of switching between spreadsheets and separate tools.",
  },
  {
    title: "Families stay in the loop",
    body: "Guardians get a live portal and notifications — no more chasing down a printed report card.",
  },
];

/** Marketing landing page (`/`). Eagerly loaded so the initial route paints without a chunk fetch. */
export default function HomePage() {
  useSeo({
    title: "School operations, in one system",
    description:
      "Studafy brings academics, attendance, grades, discipline, finance, and family communication into one school management platform.",
    path: "/",
  });

  return (
    <>
      <section className="marketing-hero">
        <div className="marketing-container">
          <h1 className="marketing-hero__title">Studafy: school operations, in one system</h1>
          <p className="marketing-hero__subtitle">
            Academics, attendance, grades, discipline, finance, and family communication — one
            platform your staff and families both actually use.
          </p>
          <div className="marketing-hero__actions">
            <LinkButton href="/about#contact" variant="primary">
              Talk to us
            </LinkButton>
            <LinkButton href="/pricing" variant="secondary">
              See pricing
            </LinkButton>
          </div>
        </div>
      </section>

      <section className="marketing-section">
        <div className="marketing-container">
          <div className="marketing-section__heading">
            <span className="marketing-section__eyebrow">What&rsquo;s included</span>
            <h2 className="marketing-section__title">Everything a school runs on</h2>
            <p className="marketing-section__lede">
              Not a bolt-on gradebook or a standalone fee tracker — the modules below share the same
              student, class, and school records.
            </p>
          </div>

          <div className="marketing-grid">
            {VALUE_PROPS.map((item) => (
              <Card key={item.title}>
                <Card.Body>
                  <h3 className="marketing-feature-card__title">{item.title}</h3>
                  <p className="marketing-feature-card__body">{item.body}</p>
                </Card.Body>
              </Card>
            ))}
          </div>
        </div>
      </section>

      <section className="marketing-section marketing-section--muted">
        <div className="marketing-container">
          <div className="marketing-section__heading">
            <span className="marketing-section__eyebrow">How it works</span>
            <h2 className="marketing-section__title">Set up once, run every term</h2>
          </div>

          <div className="marketing-steps">
            {STEPS.map((step) => (
              <div className="marketing-step" key={step.title}>
                <h3 className="marketing-step__title">{step.title}</h3>
                <p className="marketing-step__body">{step.body}</p>
              </div>
            ))}
          </div>
        </div>
      </section>

      <section className="marketing-section">
        <div className="marketing-container marketing-cta-band">
          <h2 className="marketing-cta-band__title">
            See it against your own school&rsquo;s numbers
          </h2>
          <p className="marketing-cta-band__body">
            Tell us about your school and we&rsquo;ll walk you through Studafy — including where it
            won&rsquo;t be a fit, if that&rsquo;s the case.
          </p>
          <div className="marketing-cta-band__actions">
            <LinkButton href="/about#contact" variant="primary">
              Talk to us
            </LinkButton>
            <LinkButton href="/features" variant="tertiary">
              Explore features
            </LinkButton>
          </div>
        </div>
      </section>
    </>
  );
}
