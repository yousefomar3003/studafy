// The tenants this directory seeds. All run the same data modules; the profile is the only difference
// (see TenantProfile in support.ts).
import { DEMO_SCHOOL_NAME, DEMO_SCHOOL_SLUG } from "./data/school";
import { MOCK_OAUTH_PROVIDER, MOCK_PERSONAS, mockSubject } from "./mock-credentials";
import { QA_SCHOOLS, qaLoginIdentity, qaPersonas } from "./qa-credentials";
import {
  REVIEW_PERSONAS,
  REVIEW_TENANT_NAME,
  REVIEW_TENANT_SLUG,
  reviewLoginIdentity,
} from "./review-credentials";

import type { QaSchool, QaSchoolKey } from "./qa-credentials";
import type { TenantProfile } from "./support";

// Local dev / CI demo tenant: every persona logs in through the mock OAuth provider.
export const DEMO_TENANT: TenantProfile = {
  slug: DEMO_SCHOOL_SLUG,
  name: DEMO_SCHOOL_NAME,
  isReviewTenant: false,
  isQaTenant: false,
  plan: {
    code: "campus_pro",
    displayName: "Campus Pro",
    description: "Full-featured plan used by the demo tenant.",
    isActive: true,
    monthlyAmountMinor: 49900,
  },
  // Everyone but Studafy's own staff: the super admin lives in the platform school below, as in
  // production, so the platform console lists the demo school as a school and not as Studafy.
  personas: MOCK_PERSONAS.filter((persona) => persona.role !== "SUPER_ADMIN"),
  loginIdentity: (persona) => ({ provider: MOCK_OAUTH_PROVIDER, subject: mockSubject(persona) }),
  localFixtures: true,
};

// Local dev / CI platform school: holds only the SUPER_ADMIN (seeded is_platform_tenant), like
// production's "Studafy" school. The platform console leaves platform schools out of its school
// list and totals. Its plan is internal: inactive and unpriced, never sold.
export const DEMO_PLATFORM_TENANT: TenantProfile = {
  slug: "studafy",
  name: "Studafy",
  isReviewTenant: false,
  isQaTenant: false,
  plan: {
    code: "studafy_platform",
    displayName: "Studafy platform",
    description: "Internal plan for the local platform school. Never sold.",
    isActive: false,
    monthlyAmountMinor: null,
  },
  personas: MOCK_PERSONAS.filter((persona) => persona.role === "SUPER_ADMIN"),
  loginIdentity: (persona) => ({ provider: MOCK_OAUTH_PROVIDER, subject: mockSubject(persona) }),
  localFixtures: false,
};

// App Store / Play reviewer tenant, provisioned in production. Its plan is inactive and unpriced, so
// it is never offered at checkout or synced as a sellable price, and the school is flagged
// is_review_tenant, which the API and migration 000116 treat as non-billable.
export const REVIEW_TENANT: TenantProfile = {
  slug: REVIEW_TENANT_SLUG,
  name: REVIEW_TENANT_NAME,
  isReviewTenant: true,
  isQaTenant: false,
  plan: {
    code: "review_demo",
    displayName: "Review Demo",
    description: "Internal plan for the App Store / Play reviewer demo tenant. Never sold.",
    isActive: false,
    monthlyAmountMinor: null,
  },
  personas: REVIEW_PERSONAS,
  loginIdentity: reviewLoginIdentity,
  localFixtures: false,
};

// Staging QA tenants (QA-02), provisioned in staging only (guard.ts assertQaSeedAllowed). Each gets its
// own inactive, unpriced plan (plan codes are globally unique), so none is ever offered at checkout.
export interface QaTenantProfile extends TenantProfile {
  readonly qaSchool: QaSchoolKey;
}

function qaTenantProfile(school: QaSchool): QaTenantProfile {
  return {
    slug: school.slug,
    name: school.name,
    isReviewTenant: false,
    isQaTenant: true,
    qaSchool: school.key,
    plan: {
      code: `qa_${school.key}`,
      displayName: school.name,
      description: `Internal plan for the staging QA tenant ${school.slug}. Never sold.`,
      isActive: false,
      monthlyAmountMinor: null,
    },
    personas: qaPersonas(school),
    loginIdentity: qaLoginIdentity,
    localFixtures: false,
  };
}

export const QA_TENANTS: readonly QaTenantProfile[] = QA_SCHOOLS.map(qaTenantProfile);
