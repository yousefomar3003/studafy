/**
 * QA-057: payment return URLs may only point back at Studafy.
 *
 * successUrl / cancelUrl / returnUrl were `z.string().url()` with no origin check, so a crafted
 * checkout sent the payer, straight from a Stripe-hosted page, to any site (an open redirect at
 * the most trusted moment of the flow). They must now be on one of the deployment's browser
 * origins (CORS_ALLOWED_ORIGINS, FRONTEND_URL).
 */

import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

// eslint-disable-next-line import-x/no-unresolved -- "bun:test" is a virtual Bun built-in
import { afterEach, describe, expect, test } from "bun:test";

import { isAllowedReturnUrl, returnUrlSchema } from "./return-url";

const env = { CORS_ALLOWED_ORIGINS: "https://app.studafy.com,https://studafy.com" };
const saved = { ...process.env };
afterEach(() => {
  process.env = { ...saved };
});

describe("return URLs (QA-057)", () => {
  test("a page on an allowed origin is accepted", () => {
    expect(isAllowedReturnUrl("https://app.studafy.com/billing?status=success", env)).toBe(true);
    expect(isAllowedReturnUrl("https://studafy.com/pay/done", env)).toBe(true);
  });

  test("anything else is refused", () => {
    for (const url of [
      "https://evil.example/phish",
      "//evil.example/x",
      "https://studafy.com.evil.example/",
      "https://app.studafy.com@evil.example/",
      "http://app.studafy.com/billing",
      "javascript:alert(1)",
    ]) {
      expect(`${url} -> ${isAllowedReturnUrl(url, env)}`).toBe(`${url} -> false`);
    }
  });

  test("the schema applies the configured origins", () => {
    process.env.CORS_ALLOWED_ORIGINS = env.CORS_ALLOWED_ORIGINS;
    expect(returnUrlSchema.safeParse("https://evil.example/").success).toBe(false);
    expect(returnUrlSchema.safeParse("https://app.studafy.com/ok").success).toBe(true);
  });

  test("every checkout, portal and online-payment route uses it", () => {
    const dirs = [
      join(import.meta.dir, "../../modules/subscriptions/routes"),
      join(import.meta.dir, "../../modules/finance/online-payments"),
    ];
    const offenders = dirs.flatMap((dir) =>
      readdirSync(dir)
        .filter((name) => name.endsWith(".ts") && !name.endsWith(".test.ts"))
        .filter((name) =>
          /(success|cancel|return)(Url|_url)\s*:\s*z\s*\.\s*string\(\)/.test(
            readFileSync(join(dir, name), "utf8"),
          ),
        ),
    );
    expect(offenders).toEqual([]);
  });
});
