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
      AI_RERANK_ENABLED: false,
      AI_LLM_ENABLED: false,
      AI_LLM_ZERO_RETENTION: false,
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
      AI_RERANK_ENABLED: false,
      AI_LLM_ENABLED: false,
      AI_LLM_ZERO_RETENTION: false,
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

  test("parses the AI_RERANK_ENABLED kill switch as an explicit two-value string", () => {
    expect(loadEnv({ AI_RERANK_ENABLED: "true" }).AI_RERANK_ENABLED).toBe(true);
    expect(loadEnv({ AI_RERANK_ENABLED: "false" }).AI_RERANK_ENABLED).toBe(false);
    // Off by default: the kill switch must never flip a feature on by omission.
    expect(loadEnv({}).AI_RERANK_ENABLED).toBe(false);
  });

  test("rejects a non-boolean AI_RERANK_ENABLED value", () => {
    expect(() => loadEnv({ AI_RERANK_ENABLED: "yes" })).toThrow(EnvValidationError);
  });

  test("parses the LLM gateway kill switch and zero-retention posture as explicit two-value strings", () => {
    expect(loadEnv({ AI_LLM_ENABLED: "true", ANTHROPIC_API_KEY: "sk-test" }).AI_LLM_ENABLED).toBe(
      true,
    );
    expect(loadEnv({ AI_LLM_ENABLED: "false" }).AI_LLM_ENABLED).toBe(false);
    // Off by default: the LLM plane must never arm by omission.
    expect(loadEnv({}).AI_LLM_ENABLED).toBe(false);
    expect(loadEnv({ AI_LLM_ZERO_RETENTION: "true" }).AI_LLM_ZERO_RETENTION).toBe(true);
    expect(loadEnv({}).AI_LLM_ZERO_RETENTION).toBe(false);
  });

  test("rejects a non-boolean AI_LLM_ENABLED value", () => {
    expect(() => loadEnv({ AI_LLM_ENABLED: "on" })).toThrow(EnvValidationError);
  });

  test("requires ANTHROPIC_API_KEY when the LLM gateway is enabled", () => {
    expect(() => loadEnv({ AI_LLM_ENABLED: "true" })).toThrow(EnvValidationError);
    expect(
      loadEnv({ AI_LLM_ENABLED: "true", ANTHROPIC_API_KEY: "sk-test" }).ANTHROPIC_API_KEY,
    ).toBe("sk-test");
  });

  test("rejects an ANTHROPIC_API_KEY that is set while the gateway is disabled", () => {
    expect(() => loadEnv({ ANTHROPIC_API_KEY: "sk-test" })).toThrow(EnvValidationError);
  });

  test("parses LLM gateway tuning variables", () => {
    const env = loadEnv({
      AI_LLM_ENABLED: "true",
      ANTHROPIC_API_KEY: "sk-test",
      ANTHROPIC_BASE_URL: "https://proxy.example.com/v1",
      AI_LLM_SMALL_MODEL: "claude-haiku-custom",
      AI_LLM_LARGE_MODEL: "claude-sonnet-custom",
      AI_LLM_MAX_TOKENS: "8192",
      AI_LLM_TIMEOUT_MS: "45000",
    });

    expect(env.ANTHROPIC_BASE_URL).toBe("https://proxy.example.com/v1");
    expect(env.AI_LLM_SMALL_MODEL).toBe("claude-haiku-custom");
    expect(env.AI_LLM_LARGE_MODEL).toBe("claude-sonnet-custom");
    expect(env.AI_LLM_MAX_TOKENS).toBe(8192);
    expect(env.AI_LLM_TIMEOUT_MS).toBe(45_000);
  });

  test("rejects an out-of-range AI_LLM_MAX_TOKENS or AI_LLM_TIMEOUT_MS", () => {
    expect(() =>
      loadEnv({ AI_LLM_ENABLED: "true", ANTHROPIC_API_KEY: "sk-test", AI_LLM_MAX_TOKENS: "0" }),
    ).toThrow(EnvValidationError);
    expect(() =>
      loadEnv({
        AI_LLM_ENABLED: "true",
        ANTHROPIC_API_KEY: "sk-test",
        AI_LLM_MAX_TOKENS: "16385",
      }),
    ).toThrow(EnvValidationError);
    expect(() =>
      loadEnv({ AI_LLM_ENABLED: "true", ANTHROPIC_API_KEY: "sk-test", AI_LLM_TIMEOUT_MS: "500" }),
    ).toThrow(EnvValidationError);
  });
});
