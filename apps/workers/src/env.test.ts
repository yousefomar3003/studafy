// eslint-disable-next-line import-x/no-unresolved -- "bun:test" is a virtual Bun built-in with no resolvable file path
import { describe, expect, test } from "bun:test";

import { EnvValidationError, loadEnv } from "./env";

describe("loadEnv", () => {
  test("applies defaults for an empty environment", () => {
    expect(loadEnv({})).toEqual({
      NODE_ENV: "development",
      SERVICE_NAME: "workers",
      METRICS_PORT: 9464,
      REDIS_URL: "redis://localhost:6379",
      SHUTDOWN_TIMEOUT_MS: 10_000,
      DATABASE_URL: "postgres://localhost:5432/studafy",
      SCHOOL_IDS: "",
      SES_FROM_ADDRESS: "no-reply@send.studafy.com",
      SES_FROM_NAME: "Studafy",
      EMAIL_DRY_RUN: false,
      CLAMAV_PORT: 3310,
      CLAMAV_TIMEOUT_MS: 30_000,
      CLAMAV_MAX_FILE_BYTES: 25 * 1024 * 1024,
      FRONTEND_URL: "http://localhost:5173",
      EMAIL_MAX_RATE_PER_SECOND: 5,
      EMAIL_POLL_INTERVAL_MS: 1_000,
      EMAIL_BATCH_SIZE: 25,
      ENTITLEMENT_POLL_INTERVAL_MS: 500,
      ENTITLEMENT_BATCH_SIZE: 100,
      OCR_LOW_CONFIDENCE_THRESHOLD: 60,
      INGESTION_MAX_CONCURRENCY_PER_SCHOOL: 2,
      AI_LLM_PROVIDER: "anthropic",
    });
  });

  test("parses and coerces provided values", () => {
    expect(
      loadEnv({
        NODE_ENV: "test",
        REDIS_URL: "redis://redis.internal:6380",
        SHUTDOWN_TIMEOUT_MS: "30000",
      }),
    ).toEqual({
      NODE_ENV: "test",
      SERVICE_NAME: "workers",
      METRICS_PORT: 9464,
      REDIS_URL: "redis://redis.internal:6380",
      SHUTDOWN_TIMEOUT_MS: 30_000,
      DATABASE_URL: "postgres://localhost:5432/studafy",
      SCHOOL_IDS: "",
      SES_FROM_ADDRESS: "no-reply@send.studafy.com",
      SES_FROM_NAME: "Studafy",
      EMAIL_DRY_RUN: false,
      CLAMAV_PORT: 3310,
      CLAMAV_TIMEOUT_MS: 30_000,
      CLAMAV_MAX_FILE_BYTES: 25 * 1024 * 1024,
      FRONTEND_URL: "http://localhost:5173",
      EMAIL_MAX_RATE_PER_SECOND: 5,
      EMAIL_POLL_INTERVAL_MS: 1_000,
      EMAIL_BATCH_SIZE: 25,
      ENTITLEMENT_POLL_INTERVAL_MS: 500,
      ENTITLEMENT_BATCH_SIZE: 100,
      OCR_LOW_CONFIDENCE_THRESHOLD: 60,
      INGESTION_MAX_CONCURRENCY_PER_SCHOOL: 2,
      AI_LLM_PROVIDER: "anthropic",
    });
  });

  test("throws a named EnvValidationError for an empty REDIS_URL", () => {
    expect(() => loadEnv({ REDIS_URL: "" })).toThrow(EnvValidationError);
    try {
      loadEnv({ REDIS_URL: "" });
      throw new Error("expected loadEnv to throw");
    } catch (error) {
      expect((error as Error).name).toBe("EnvValidationError");
    }
  });

  test("throws for an unknown NODE_ENV", () => {
    expect(() => loadEnv({ NODE_ENV: "staging" })).toThrow(EnvValidationError);
  });

  test("coerces the OCR low-confidence threshold override", () => {
    expect(loadEnv({ OCR_LOW_CONFIDENCE_THRESHOLD: "75" })).toMatchObject({
      OCR_LOW_CONFIDENCE_THRESHOLD: 75,
    });
  });

  test("requires a distinct read pool in production", () => {
    expect(() => loadEnv({ NODE_ENV: "production" })).toThrow(EnvValidationError);
    expect(
      loadEnv({
        NODE_ENV: "production",
        READ_DATABASE_HOST: "pgbouncer.internal",
        READ_DATABASE_NAME: "workers_read",
        STRIPE_SECRET_KEY: "sk_test_prod",
        CLAMAV_HOST: "clamd.internal",
        SES_REGION: "eu-central-1",
      }),
    ).toMatchObject({
      READ_DATABASE_HOST: "pgbouncer.internal",
      READ_DATABASE_NAME: "workers_read",
      STRIPE_SECRET_KEY: "sk_test_prod",
      CLAMAV_HOST: "clamd.internal",
    });
  });

  test("boots in production without Stripe, as a Tap-only deployment does", () => {
    const env = loadEnv({
      NODE_ENV: "production",
      READ_DATABASE_HOST: "pgbouncer.internal",
      READ_DATABASE_NAME: "workers_read",
      CLAMAV_HOST: "clamd.internal",
      SES_REGION: "eu-central-1",
      // Injected empty by the task definition when the secret holds no Stripe key.
      STRIPE_SECRET_KEY: "",
    });
    expect(env.STRIPE_SECRET_KEY).toBeUndefined();
  });

  describe("email in production", () => {
    const deployed = {
      NODE_ENV: "production",
      READ_DATABASE_HOST: "pgbouncer.internal",
      READ_DATABASE_NAME: "workers_read",
      CLAMAV_HOST: "clamd.internal",
    };

    test("refuses to boot without SES, so email can never silently stop", () => {
      expect(() => loadEnv(deployed)).toThrow(EnvValidationError);
      // The task definition always injects the key; empty must not count as set.
      expect(() => loadEnv({ ...deployed, SES_REGION: "" })).toThrow(EnvValidationError);
    });

    test("boots without SES only when dry-run is chosen on purpose", () => {
      expect(loadEnv({ ...deployed, EMAIL_DRY_RUN: "true" }).EMAIL_DRY_RUN).toBe(true);
    });

    test("sends from the verified domain by default", () => {
      const env = loadEnv({ ...deployed, SES_REGION: "eu-central-1" });
      expect(env.SES_FROM_ADDRESS).toBe("no-reply@send.studafy.com");
      expect(env.SES_FROM_NAME).toBe("Studafy");
    });
  });
});
