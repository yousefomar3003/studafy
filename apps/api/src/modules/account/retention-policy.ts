/**
 * What survives a self-service account deletion, and on what basis — the disclosure half of the
 * retention rules (App Store 5.1.1(v), Google Play data deletion, GDPR Art. 17(3)(b)).
 *
 * The mechanical half is apps/workers/src/queues/maintenance/retention-registry.ts, which decides
 * per table whether the erasure worker redacts, hard-deletes or leaves it on legal hold. This file
 * does not drive that worker (apps/api does not depend on apps/workers); it states, for the user
 * and the audit log, what that worker leaves behind. The two must describe the same facts, so a
 * change to either is a change to both — see docs/modules/account-deletion.md.
 *
 * What "retained" means for each category:
 *   - academic_grades / attendance: rows are kept so the school's record stays complete, but the
 *     erasure worker redacts every personal-data column on them and on app.students/app.users, so
 *     what remains is pseudonymous (linked to an id, not to a name, email or phone).
 *   - financial_records / audit_log: legal hold — the worker does not touch these at all.
 */

export const RETAINED_RECORD_CATEGORY_NAMES = [
  "academic_grades",
  "attendance",
  "financial_records",
  "audit_log",
] as const;

export interface RetainedRecordCategory {
  category: (typeof RETAINED_RECORD_CATEGORY_NAMES)[number];
  description: string;
  legalBasis: string;
  /** The app.* tables this category covers. Pinned against the migrations by retention-policy.test.ts. */
  tables: readonly string[];
}

const LEGAL_OBLIGATION =
  "GDPR Art. 17(3)(b) and Art. 6(1)(c): retention required by a legal obligation of the school as controller.";

export const RETAINED_RECORD_CATEGORIES: readonly RetainedRecordCategory[] = [
  {
    category: "academic_grades",
    description:
      "Grades and gradebook entries the school issued, without your name or contact details.",
    legalBasis: `${LEGAL_OBLIGATION} Schools must keep student academic records for the period their education authority sets.`,
    tables: ["gradebooks", "grade_submissions", "grades"],
  },
  {
    category: "attendance",
    description: "Attendance marks the school recorded, without your name or contact details.",
    legalBasis: `${LEGAL_OBLIGATION} Schools must keep attendance registers for the period their education authority sets.`,
    tables: ["attendance_records", "attendance_record_versions"],
  },
  {
    category: "financial_records",
    description: "Payment, invoice and subscription records.",
    legalBasis: `${LEGAL_OBLIGATION} Tax and accounting law requires financial records to be kept.`,
    tables: [
      "subscriptions",
      "ai_subscriptions",
      "online_fee_payments",
      "payment_provider_customers",
      "tap_renewal_attempts",
      "refund_requests",
    ],
  },
  {
    category: "audit_log",
    description: "Security and audit log entries, including the record of this deletion.",
    legalBasis:
      "GDPR Art. 17(3)(b) and Art. 5(2): the controller must be able to demonstrate compliance, including that this deletion happened.",
    tables: ["audit_logs"],
  },
];
