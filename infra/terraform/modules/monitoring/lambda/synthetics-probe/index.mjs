// eslint-disable-next-line import-x/no-unresolved -- AWS SDK v3 is bundled with the Lambda runtime, not a repo dependency
import { CloudWatchClient, PutMetricDataCommand } from "@aws-sdk/client-cloudwatch";

/*
 * Black-box synthetic availability probe (ST-263). Runs every minute, in two regions
 * (../../synthetics.tf deploys this same code once under the default provider and once under
 * aws.dr — see that file's header for why two regions and why these two) via EventBridge Scheduler.
 *
 * Five unauthenticated, side-effect-free HTTP checks against the five entry points named in the
 * ticket:
 *
 *   login-page         GET  {WEB_ORIGIN}/auth/login
 *   healthz             GET  {API_ORIGIN}/healthz
 *   oauth-start         GET  {API_ORIGIN}/api/auth/oauth/google/start
 *   checkout-page       GET  {WEB_ORIGIN}/pricing
 *   invitation-verify   GET  {API_ORIGIN}/api/auth/invitations/{SYNTHETIC_INVITATION_TOKEN}/verify
 *
 * "checkout-page" -> /pricing: apps/web has no route literally named "checkout" — every checkout
 * endpoint (POST /api/subscriptions/checkout et al., school-checkout-routes.ts, ai-checkout-routes.ts)
 * is an authenticated, side-effecting Stripe-session creation, not something a once-a-minute
 * black-box probe should call. /pricing (PricingPage.tsx) is the public page the checkout flow
 * actually starts from, so it is the honest stand-in: it proves the funnel's entry point is up,
 * not that a purchase can complete.
 *
 * Each check publishes one CloudWatch metric point regardless of outcome (unlike the realtime
 * probe next door, which emits nothing on failure): five independent checks per run need to tell
 * "healthz is up but checkout-page is down" apart from "the whole run failed", which a
 * publish-on-success-only metric cannot do. `SyntheticCheckSuccess` is 1/0 per check;
 * alerts.tf's alarms alarm on its rolling average falling below 1, with `treat_missing_data =
 * "breaching"` covering the case where the Lambda itself never ran at all.
 *
 * Runtime: nodejs22.x. Zero npm dependencies beyond the bundled AWS SDK — Node 22's global `fetch`
 * (undici) is enough for five plain GETs. ESM (index.mjs) so no bundler is needed, same as
 * lambda/realtime-probe.
 */

const WEB_ORIGIN = process.env.WEB_ORIGIN;
const API_ORIGIN = process.env.API_ORIGIN;
const METRIC_NAMESPACE = process.env.METRIC_NAMESPACE;
const TIMEOUT_MS = Number(process.env.TIMEOUT_MS || 8000);

const cloudwatch = new CloudWatchClient({});

// A well-formed (64 lowercase hex chars — INVITATION_TOKEN_PATTERN in
// apps/api/src/modules/auth/invitation/verification.ts) invitation token that is never issued to a
// real invitation. Real tokens are crypto.randomBytes(32).toString("hex"), so the collision odds
// are (1/16)^64 — a reserved synthetic identity, the same idea as the realtime probe's
// PROBE_SCHOOL_ID/PROBE_USER_ID. Per docs/security/invitation_verification_matrix.md, a
// well-formed-but-unknown token deterministically resolves 400 INVITATION_INVALID with no database
// write, so this exercises the real endpoint (including its forced-RLS lookup function) without
// depending on a live, expiring fixture.
const SYNTHETIC_INVITATION_TOKEN = "0".repeat(64);

/** GETs `url`, never following redirects (the oauth-start check would otherwise walk onto
 * Google's real authorization endpoint every minute) and bounding the wait with TIMEOUT_MS. */
async function fetchWithTimeout(url) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    return await fetch(url, { redirect: "manual", signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

const CHECKS = [
  {
    name: "login-page",
    run: async () => (await fetchWithTimeout(`${WEB_ORIGIN}/auth/login`)).status === 200,
  },
  {
    name: "healthz",
    run: async () => {
      const res = await fetchWithTimeout(`${API_ORIGIN}/healthz`);
      if (res.status !== 200) return false;
      const body = await res.json().catch(() => null);
      return body?.status === "ok";
    },
  },
  {
    name: "oauth-start",
    run: async () => {
      // google-route.ts's GET /api/auth/oauth/google/start redirects (302) to Google's
      // authorization endpoint when GOOGLE_CLIENT_ID/SECRET are configured, or answers its own
      // coded 404 ("Google OAuth is not configured") when they are not — whether this deployment
      // has Google OAuth configured is a config concern outside this probe's scope. Either response
      // proves the route is mounted and the service is answering; only a 5xx or a network
      // failure/timeout counts as this check failing.
      const res = await fetchWithTimeout(`${API_ORIGIN}/api/auth/oauth/google/start`);
      return res.status < 500;
    },
  },
  {
    name: "checkout-page",
    run: async () => (await fetchWithTimeout(`${WEB_ORIGIN}/pricing`)).status === 200,
  },
  {
    name: "invitation-verify",
    run: async () => {
      const res = await fetchWithTimeout(
        `${API_ORIGIN}/api/auth/invitations/${SYNTHETIC_INVITATION_TOKEN}/verify`,
      );
      if (res.status !== 400) return false;
      const body = await res.json().catch(() => null);
      return body?.code === "INVITATION_INVALID";
    },
  },
];

export const handler = async () => {
  const results = await Promise.all(
    CHECKS.map(async (check) => {
      const startedAt = Date.now();
      let success = false;
      try {
        success = await check.run();
      } catch (error) {
        console.error(
          JSON.stringify({
            msg: "synthetic check failed",
            check: check.name,
            error: error instanceof Error ? error.message : String(error),
          }),
        );
      }
      return { name: check.name, success, latencyMs: Date.now() - startedAt };
    }),
  );

  await cloudwatch.send(
    new PutMetricDataCommand({
      Namespace: METRIC_NAMESPACE,
      MetricData: results.flatMap((result) => [
        {
          MetricName: "SyntheticCheckSuccess",
          Dimensions: [{ Name: "Check", Value: result.name }],
          Value: result.success ? 1 : 0,
          Unit: "Count",
          Timestamp: new Date(),
        },
        {
          MetricName: "SyntheticCheckLatency",
          Dimensions: [{ Name: "Check", Value: result.name }],
          Value: result.latencyMs,
          Unit: "Milliseconds",
          Timestamp: new Date(),
        },
      ]),
    }),
  );

  const failed = results.filter((result) => !result.success);
  console.log(JSON.stringify({ msg: "synthetic probe run", results }));

  // The Lambda's own return value has no consumer (EventBridge Scheduler ignores it) — it is only
  // ever read from a manual `aws lambda invoke`, where a non-200 makes a failed run visible without
  // opening CloudWatch Logs.
  return { statusCode: failed.length === 0 ? 200 : 500, body: JSON.stringify({ results }) };
};
