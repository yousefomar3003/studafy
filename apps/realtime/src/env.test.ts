// eslint-disable-next-line import-x/no-unresolved -- "bun:test" is a virtual Bun built-in with no resolvable file path
import { describe, expect, test } from "bun:test";

import { DEV_WS_JWT_SECRET, EnvValidationError, loadEnv } from "./env";

const PRODUCTION_SECRET = "a".repeat(32);

describe("loadEnv", () => {
  test("applies defaults for an empty environment", () => {
    expect(loadEnv({})).toEqual({
      NODE_ENV: "development",
      PORT: 3001,
      HOST: "0.0.0.0",
      SERVICE_NAME: "realtime",
      RELEASE_VERSION: "unknown",
      METRICS_PORT: 9464,
      REDIS_URL: "redis://localhost:6379",
      WS_JWT_SECRET: "dev-insecure-secret-change-me",
      WS_ALLOWED_ORIGINS: [],
    });
  });

  test("parses and coerces provided values", () => {
    expect(
      loadEnv({
        NODE_ENV: "production",
        PORT: "8080",
        HOST: "127.0.0.1",
        REDIS_URL: "redis://cache:6379/0",
        AUTH_REDIS_URL: "redis://cache:6379/1",
        WS_JWT_SECRET: PRODUCTION_SECRET,
        WS_ALLOWED_ORIGINS: "https://app.studafy.com, https://staging.studafy.com",
      }),
    ).toEqual({
      NODE_ENV: "production",
      PORT: 8080,
      HOST: "127.0.0.1",
      SERVICE_NAME: "realtime",
      RELEASE_VERSION: "unknown",
      METRICS_PORT: 9464,
      REDIS_URL: "redis://cache:6379/0",
      AUTH_REDIS_URL: "redis://cache:6379/1",
      WS_JWT_SECRET: PRODUCTION_SECRET,
      WS_ALLOWED_ORIGINS: ["https://app.studafy.com", "https://staging.studafy.com"],
    });
  });

  test("throws a named EnvValidationError for an out-of-range port", () => {
    expect(() => loadEnv({ PORT: "0" })).toThrow(EnvValidationError);
  });

  test("throws for an unknown NODE_ENV", () => {
    expect(() => loadEnv({ NODE_ENV: "staging" })).toThrow(EnvValidationError);
  });

  test("throws for an empty WS_JWT_SECRET", () => {
    expect(() => loadEnv({ WS_JWT_SECRET: "" })).toThrow(EnvValidationError);
  });

  // QA-14 / F-05: the gateway must not boot in production on the well-known development key, which
  // anyone could use to mint tickets.
  test("refuses to boot in production with the default WS_JWT_SECRET", () => {
    const production = {
      NODE_ENV: "production",
      AUTH_REDIS_URL: "redis://cache:6379/1",
      WS_ALLOWED_ORIGINS: "https://app.studafy.com",
    };
    expect(() => loadEnv(production)).toThrow(/WS_JWT_SECRET must not be the development default/);
    expect(() => loadEnv({ ...production, WS_JWT_SECRET: DEV_WS_JWT_SECRET })).toThrow(
      /WS_JWT_SECRET must not be the development default/,
    );
    expect(() => loadEnv({ ...production, WS_JWT_SECRET: "short-secret" })).toThrow(
      /WS_JWT_SECRET must be at least 32 characters/,
    );
    expect(loadEnv({ ...production, WS_JWT_SECRET: PRODUCTION_SECRET }).WS_JWT_SECRET).toBe(
      PRODUCTION_SECRET,
    );
  });

  test("requires AUTH_REDIS_URL in production, where it is a different database", () => {
    expect(() =>
      loadEnv({
        NODE_ENV: "production",
        WS_JWT_SECRET: PRODUCTION_SECRET,
        WS_ALLOWED_ORIGINS: "https://app.studafy.com",
      }),
    ).toThrow(/AUTH_REDIS_URL is required/);
  });

  test("requires WS_ALLOWED_ORIGINS in production", () => {
    expect(() => loadEnv({ NODE_ENV: "production" })).toThrow(/WS_ALLOWED_ORIGINS/);
    expect(() => loadEnv({ NODE_ENV: "production", WS_ALLOWED_ORIGINS: " , " })).toThrow(
      /WS_ALLOWED_ORIGINS/,
    );
  });

  test("rejects an origin with a path or wildcard", () => {
    expect(() => loadEnv({ WS_ALLOWED_ORIGINS: "https://app.studafy.com/" })).toThrow(
      EnvValidationError,
    );
    expect(() => loadEnv({ WS_ALLOWED_ORIGINS: "https://*.studafy.com" })).toThrow(
      EnvValidationError,
    );
  });
});
