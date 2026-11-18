/**
 * QA-077: every external service the deployed code is wired to is disclosed in the privacy policy.
 *
 * The provider table in docs/legal/en/privacy.md section 8 is the single sub-processor list. Each
 * entry below ties a provider to the setting that turns it on in production (an env var a service
 * reads, or a value in infra/fly/*.toml), so adding an integration without disclosing it, or
 * renaming the setting, fails here. Entries marked `test.failing` are open findings for counsel:
 * the integration is live but undisclosed. They turn red (as "passing unexpectedly") once the
 * policy names them, and should then move to the plain list.
 *
 * Legal wording is counsel's; this test only checks that a row exists.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";

// eslint-disable-next-line import-x/no-unresolved -- "bun:test" is a virtual Bun built-in
import { describe, expect, test } from "bun:test";

const root = join(import.meta.dir, "../../../..");
const read = (path: string) => readFileSync(join(root, path), "utf8");

const privacy = read("docs/legal/en/privacy.md");
const section8 = privacy.slice(
  privacy.indexOf("## 8. Service providers"),
  privacy.indexOf("## 9. International transfers"),
);
const disclosedProviders = [...section8.matchAll(/^\| ([^|]+?) +\|/gm)]
  .map((m) => m[1]!)
  .filter((name) => !/^(Provider|-+)$/.test(name));

const wiring =
  read("apps/api/src/env.ts") +
  read("apps/workers/src/env.ts") +
  read("infra/fly/api.toml") +
  read("infra/fly/workers.toml") +
  read("infra/fly/log-shipper.toml") +
  read(".github/workflows/fly-production-deploy.yml");

interface Integration {
  provider: string;
  /** Proof in config that production uses it. */
  wiredBy: RegExp;
}

const disclosed: Integration[] = [
  { provider: "Fly.io", wiredBy: /flyctl deploy/ },
  { provider: "Supabase", wiredBy: /pooler\.supabase\.com/ },
  { provider: "Redis Cloud", wiredBy: /REDIS_URL/ },
  { provider: "Cloudflare R2", wiredBy: /S3_ENDPOINT/ },
  { provider: "Cloudflare Turnstile", wiredBy: /TURNSTILE_SECRET_KEY/ },
  { provider: "Resend", wiredBy: /RESEND_API_KEY/ },
  { provider: "Google Firebase Cloud Messaging", wiredBy: /FIREBASE_SERVICE_ACCOUNT/ },
  { provider: "Sentry", wiredBy: /SENTRY_DSN/ },
  { provider: "Axiom", wiredBy: /axiom\.co/ },
  { provider: "Together AI", wiredBy: /api\.together\.xyz/ },
];

/** Live, undisclosed: NEEDS HUMAN (counsel). See QA_PROGRESS QA-077. */
const undisclosed: Integration[] = [
  // Finance system: invoices, fee amounts, students' admission numbers (apps/workers billing).
  // Whether it needs its own row depends on where it is hosted (self-hosted on Fly is covered by the
  // Fly.io row; a hosted Frappe/ERPNext provider is a sub-processor).
  { provider: "ERPNext", wiredBy: /ERPNEXT_API_URL/ },
  // School subscription billing (school admins' names, emails, card handling by Stripe).
  { provider: "Stripe", wiredBy: /STRIPE_SECRET_KEY/ },
];

const isDisclosed = (provider: string) =>
  disclosedProviders.some((name) => name.toLowerCase().includes(provider.toLowerCase()));

describe("sub-processors are disclosed (QA-077)", () => {
  test("the policy's provider table parses", () => {
    expect(disclosedProviders.length).toBeGreaterThanOrEqual(10);
  });

  for (const { provider, wiredBy } of disclosed) {
    test(`${provider} is wired up and named in privacy.md section 8`, () => {
      expect(wiring).toMatch(wiredBy);
      expect(isDisclosed(provider)).toBe(true);
    });
  }

  for (const { provider, wiredBy } of undisclosed) {
    test(`${provider} is wired up`, () => {
      expect(wiring).toMatch(wiredBy);
    });
    test.failing(`${provider} is named in privacy.md section 8 (open: counsel)`, () => {
      expect(isDisclosed(provider)).toBe(true);
    });
  }
});
