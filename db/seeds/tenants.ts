// The two tenants this directory seeds. Both run the same data modules; the profile is the only
// difference (see TenantProfile in support.ts).
import { DEMO_SCHOOL_NAME, DEMO_SCHOOL_SLUG } from "./data/school";
import { MOCK_OAUTH_PROVIDER, MOCK_PERSONAS, mockSubject } from "./mock-credentials";
import {
  REVIEW_PERSONAS,
  REVIEW_TENANT_NAME,
  REVIEW_TENANT_SLUG,
  reviewLoginIdentity,
} from "./review-credentials";

import type { TenantProfile } from "./support";

// Local dev / CI demo tenant: every persona logs in through the mock OAuth provider.
export const DEMO_TENANT: TenantProfile = {
  slug: DEMO_SCHOOL_SLUG,
  name: DEMO_SCHOOL_NAME,
  isReviewTenant: false,
  plan: {
    code: "campus_pro",
    displayName: "Campus Pro",
    description: "Full-featured plan used by the demo tenant.",
    isActive: true,
    monthlyAmountMinor: 49900,
  },
  personas: MOCK_PERSONAS,
  loginIdentity: (persona) => ({ provider: MOCK_OAUTH_PROVIDER, subject: mockSubject(persona) }),
  localFixtures: true,
};

// App Store / Play reviewer tenant, provisioned in production. Its plan is inactive and unpriced, so
// it is never offered at checkout or synced as a sellable price, and the school is flagged
// is_review_tenant, which the API and migration 000115 treat as non-billable.
export const REVIEW_TENANT: TenantProfile = {
  slug: REVIEW_TENANT_SLUG,
  name: REVIEW_TENANT_NAME,
  isReviewTenant: true,
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
