// eslint-disable-next-line import-x/no-unresolved -- "bun:test" is a virtual Bun built-in with no resolvable file path
import { describe, expect, test } from "bun:test";

import { EnvValidationError, loadEnv } from "./env";

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
        REDIS_URL: "redis://cache:6379",
        WS_JWT_SECRET: "super-secret",
        WS_ALLOWED_ORIGINS: "https://app.studafy.com, https://staging.studafy.com",
      }),
    ).toEqual({
      NODE_ENV: "production",
      PORT: 8080,
      HOST: "127.0.0.1",
      SERVICE_NAME: "realtime",
      RELEASE_VERSION: "unknown",
      METRICS_PORT: 9464,
      REDIS_URL: "redis://cache:6379",
      WS_JWT_SECRET: "super-secret",
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
