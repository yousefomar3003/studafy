// eslint-disable-next-line import-x/no-unresolved -- "bun:test" is a virtual Bun built-in with no resolvable file path
import { describe, expect, test } from "bun:test";

import { EnvValidationError, loadEnv } from "./env";

describe("loadEnv", () => {
  test("applies defaults for an empty environment", () => {
    expect(loadEnv({})).toEqual({
      NODE_ENV: "development",
      REDIS_URL: "redis://localhost:6379",
      SHUTDOWN_TIMEOUT_MS: 10_000,
      DATABASE_URL: "postgres://localhost:5432/studafy",
      SCHOOL_IDS: "",
      SES_FROM_ADDRESS: "invitations@mail.studafy.com",
      FRONTEND_URL: "http://localhost:5173",
      EMAIL_MAX_RATE_PER_SECOND: 5,
      EMAIL_POLL_INTERVAL_MS: 1_000,
      EMAIL_BATCH_SIZE: 25,
      ENTITLEMENT_POLL_INTERVAL_MS: 500,
      ENTITLEMENT_BATCH_SIZE: 100,
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
      REDIS_URL: "redis://redis.internal:6380",
      SHUTDOWN_TIMEOUT_MS: 30_000,
      DATABASE_URL: "postgres://localhost:5432/studafy",
      SCHOOL_IDS: "",
      SES_FROM_ADDRESS: "invitations@mail.studafy.com",
      FRONTEND_URL: "http://localhost:5173",
      EMAIL_MAX_RATE_PER_SECOND: 5,
      EMAIL_POLL_INTERVAL_MS: 1_000,
      EMAIL_BATCH_SIZE: 25,
      ENTITLEMENT_POLL_INTERVAL_MS: 500,
      ENTITLEMENT_BATCH_SIZE: 100,
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

  test("requires a distinct read pool in production", () => {
    expect(() => loadEnv({ NODE_ENV: "production" })).toThrow(EnvValidationError);
    expect(
      loadEnv({
        NODE_ENV: "production",
        READ_DATABASE_HOST: "pgbouncer.internal",
        READ_DATABASE_NAME: "workers_read",
      }),
    ).toMatchObject({
      READ_DATABASE_HOST: "pgbouncer.internal",
      READ_DATABASE_NAME: "workers_read",
    });
  });
});
