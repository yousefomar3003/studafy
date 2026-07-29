// eslint-disable-next-line import-x/no-unresolved -- "bun:test" is a virtual Bun built-in with no resolvable file path
import { describe, expect, test } from "bun:test";

import { EnvValidationError, loadEnv } from "./env";
import { LOG_LEVEL_NAMES } from "./logger";

describe("loadEnv", () => {
  test("applies defaults for an empty environment", () => {
    expect(loadEnv({})).toEqual({
      NODE_ENV: "development",
      APP_ENV: "development",
      PORT: 3000,
      HOST: "0.0.0.0",
      SHUTDOWN_TIMEOUT_MS: 10_000,
      LOG_LEVEL: "info",
      SERVICE_NAME: "api",
      RELEASE_VERSION: "unknown",
      JWT_ISSUER: "studafy",
      JWT_AUDIENCE: "studafy-api",
      JWT_ACCESS_TTL_SECONDS: 900,
      JWT_REFRESH_TTL_SECONDS: 2592000,
      JWT_KEY_ROTATION_INTERVAL_MS: 7 * 24 * 60 * 60 * 1000,
      S3_PRESIGN_TTL_SECONDS: 900,
    });
  });

  test("parses and coerces provided values", () => {
    expect(
      loadEnv({
        NODE_ENV: "test",
        APP_ENV: "staging",
        CORS_ALLOWED_ORIGINS: "https://staging.studafy.com",
        PORT: "8080",
        HOST: "127.0.0.1",
        SHUTDOWN_TIMEOUT_MS: "5000",
        LOG_LEVEL: "debug",
        SERVICE_NAME: "api-canary",
        RELEASE_VERSION: "sha-abc123",
      }),
    ).toEqual({
      NODE_ENV: "test",
      APP_ENV: "staging",
      CORS_ALLOWED_ORIGINS: "https://staging.studafy.com",
      PORT: 8080,
      HOST: "127.0.0.1",
      SHUTDOWN_TIMEOUT_MS: 5000,
      LOG_LEVEL: "debug",
      SERVICE_NAME: "api-canary",
      RELEASE_VERSION: "sha-abc123",
      JWT_ISSUER: "studafy",
      JWT_AUDIENCE: "studafy-api",
      JWT_ACCESS_TTL_SECONDS: 900,
      JWT_REFRESH_TTL_SECONDS: 2592000,
      JWT_KEY_ROTATION_INTERVAL_MS: 7 * 24 * 60 * 60 * 1000,
      S3_PRESIGN_TTL_SECONDS: 900,
    });
  });

  test("throws a named EnvValidationError for an out-of-range port", () => {
    expect(() => loadEnv({ PORT: "0" })).toThrow(EnvValidationError);
    try {
      loadEnv({ PORT: "0" });
      throw new Error("expected loadEnv to throw");
    } catch (error) {
      expect((error as Error).name).toBe("EnvValidationError");
    }
  });

  test("throws for a non-numeric port", () => {
    expect(() => loadEnv({ PORT: "not-a-number" })).toThrow(EnvValidationError);
  });

  test("throws for an unknown NODE_ENV", () => {
    expect(() => loadEnv({ NODE_ENV: "staging" })).toThrow(EnvValidationError);
  });

  test("requires PgBouncer TLS configuration in production", () => {
    expect(() => loadEnv({ NODE_ENV: "production" })).toThrow(EnvValidationError);
  });

  test("requires a non-empty CORS_ALLOWED_ORIGINS in every deployed tier", () => {
    // NODE_ENV stays at its default here on purpose: the constraint keys off the deployment tier,
    // not the build mode, so a staging box must be held to it either way.
    expect(() => loadEnv({ APP_ENV: "staging" })).toThrow(EnvValidationError);
    expect(() => loadEnv({ APP_ENV: "production", CORS_ALLOWED_ORIGINS: "" })).toThrow(
      EnvValidationError,
    );
    expect(() => loadEnv({ APP_ENV: "production", CORS_ALLOWED_ORIGINS: " , ," })).toThrow(
      EnvValidationError,
    );
  });

  test("does not require CORS_ALLOWED_ORIGINS in development", () => {
    expect(loadEnv({ APP_ENV: "development" }).CORS_ALLOWED_ORIGINS).toBeUndefined();
  });

  test("rejects origins that are not bare absolute origins", () => {
    const reject = (origins: string) =>
      expect(() => loadEnv({ APP_ENV: "production", CORS_ALLOWED_ORIGINS: origins })).toThrow(
        EnvValidationError,
      );

    reject("https://*.studafy.com"); // wildcards never match an Origin header
    reject("https://studafy.com/app"); // a path can never equal an origin
    reject("studafy.com"); // scheme-less
    reject("ftp://studafy.com");
    reject("https://good.studafy.com,https://bad.studafy.com/path"); // one bad entry fails the list
  });

  test("accepts a comma-separated origin list with surrounding whitespace", () => {
    expect(
      loadEnv({
        APP_ENV: "production",
        CORS_ALLOWED_ORIGINS: " https://app.studafy.com , https://api.studafy.com ",
        NODE_ENV: "development",
      }).CORS_ALLOWED_ORIGINS,
    ).toBe(" https://app.studafy.com , https://api.studafy.com ");
  });

  test("throws for an unknown LOG_LEVEL", () => {
    expect(() => loadEnv({ LOG_LEVEL: "verbose" })).toThrow(EnvValidationError);
  });

  test("accepts every level the logger defines", () => {
    for (const level of LOG_LEVEL_NAMES) {
      expect(loadEnv({ LOG_LEVEL: level }).LOG_LEVEL).toBe(level);
    }
  });

  test("rejects an empty SERVICE_NAME or RELEASE_VERSION", () => {
    expect(() => loadEnv({ SERVICE_NAME: "" })).toThrow(EnvValidationError);
    expect(() => loadEnv({ RELEASE_VERSION: "" })).toThrow(EnvValidationError);
  });

  test("does not require RELEASE_VERSION in production", () => {
    // A missing release name must degrade to "unknown" in the logs, never block a boot.
    expect(
      loadEnv({
        NODE_ENV: "production",
        DATABASE_HOST: "db",
        DATABASE_PORT: "6432",
        DATABASE_NAME: "studafy",
        DATABASE_USER: "studafy_app",
        DATABASE_PASSWORD: "secret",
        DATABASE_CA_CERT: "-----BEGIN CERTIFICATE-----",
        READ_DATABASE_HOST: "db-read",
        READ_DATABASE_NAME: "api_read",
      }).RELEASE_VERSION,
    ).toBe("unknown");
  });
});
