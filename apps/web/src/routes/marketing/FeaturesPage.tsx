import { Card, Chip } from "@studafy/ui";
import { Link } from "react-router-dom";

import { LinkButton } from "../../components/LinkButton";
import { useSeo } from "../../components/Seo";

interface FeatureGroup {
  title: string;
  body: string;
  items: string[];
}

const FEATURE_GROUPS: FeatureGroup[] = [
  {
    title: "Academics",
    body: "The structure everything else hangs off of.",
    items: [
      "Academic years and terms",
      "Subjects, courses, and classes",
      "Enrollment",
      "Timetabling",
    ],
  },
  {
    title: "Attendance",
    body: "Daily records with a real audit trail.",
    items: [
      "Attendance sessions per class",
      "Corrections logged, not overwritten",
      "Attendance reporting for admins",
    ],
  },
  {
    title: "Grades & assessments",
    body: "From assignment to published result.",
    items: [
      "Assignments and student submissions",
      "Exams and gradebook configuration",
      "Grade entry with a publish step",
      "Grade reporting",
    ],
  },
  {
    title: "Discipline",
    body: "Incidents and evaluations on the student record.",
    items: ["Discipline case records", "Student evaluations"],
  },
  {
    title: "Finance & billing",
    body: "Fees through to reconciliation.",
    items: [
      "Fee structures and installments",
      "Scholarships and discounts",
      "Payments and refunds",
      "Reconciliation and finance reporting",
    ],
  },
  {
    title: "Family portal & notifications",
    body: "What guardians see, and how they hear about it.",
    items: [
      "Per-child attendance, grades, and balances",
      "Multi-child comparison for guardians with siblings enrolled",
      "Notification preferences per channel",
    ],
  },
  {
    title: "Approvals & audit",
    body: "A record of who changed what, and who signed off.",
    items: ["A shared approval queue for review-gated actions", "An audit trail across modules"],
  },
];

/** Marketing features page (`/features`), code-split like the rest of the non-marketing-home routes. */
export default function FeaturesPage() {
  useSeo({
    title: "Features",
    description:
      "Academics, attendance, grades, discipline, finance, family portal, and an optional AI add-on — see what's included in Studafy.",
    path: "/features",
  });

  return (
    <>
      <section className="marketing-hero">
        <div className="marketing-container">
          <h1 className="marketing-hero__title">One system for the whole school day</h1>
          <p className="marketing-hero__subtitle">
            Every group below shares the same student, class, and school records — nothing here is a
            separate tool bolted on afterward.
          </p>
        </div>
      </section>

      <section className="marketing-section">
        <div className="marketing-container">
          <div className="marketing-grid">
            {FEATURE_GROUPS.map((group) => (
              <Card key={group.title}>
                <Card.Body>
                  <h2 className="marketing-feature-card__title">{group.title}</h2>
                  <p className="marketing-feature-card__body">{group.body}</p>
                  <ul className="marketing-feature-card__list">
                    {group.items.map((item) => (
                      <li key={item}>{item}</li>
                    ))}
                  </ul>
                </Card.Body>
              </Card>
            ))}
          </div>
        </div>
      </section>

      <section className="marketing-section marketing-section--muted">
        <div className="marketing-container">
          <div className="marketing-ai-callout">
            <Card>
              <Card.Body>
                <Chip>Add-on</Chip>
                <h2 className="marketing-feature-card__title">Ask AI & summaries</h2>
                <p className="marketing-feature-card__body">
                  A grounded question-and-answer assistant that cites the school records it draws
                  from, plus a study-material summarizer. It&rsquo;s opt-in on top of a school
                  subscription, purchased per student, and metered against a monthly usage budget
                  rather than sold as unlimited — see <Link to="/pricing">pricing</Link> for how
                  it&rsquo;s billed.
                </p>
              </Card.Body>
            </Card>
          </div>
        </div>
      </section>

      <section className="marketing-section">
        <div className="marketing-container marketing-cta-band">
          <h2 className="marketing-cta-band__title">Want to see it against your data?</h2>
          <div className="marketing-cta-band__actions">
            <LinkButton href="/about#contact" variant="primary">
              Talk to us
            </LinkButton>
            <LinkButton href="/pricing" variant="tertiary">
              See pricing
            </LinkButton>
          </div>
        </div>
      </section>
    </>
  );
}
