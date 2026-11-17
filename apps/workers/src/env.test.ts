// eslint-disable-next-line import-x/no-unresolved -- "bun:test" is a virtual Bun built-in with no resolvable file path
import { describe, expect, test } from "bun:test";

import { EnvValidationError, databaseUrlFrom, loadEnv, readDatabaseUrlFrom } from "./env";

// Production seals sensitive import columns with a real records keyring (ADR-019).
const RECORD_KEYS = {
  RECORDS_ENCRYPTION_KEYS: JSON.stringify({ "prod-1": Buffer.alloc(32, 3).toString("base64") }),
  RECORDS_ENCRYPTION_CURRENT_KEY_ID: "prod-1",
};

// QA-066: what a deployed worker needs to reach Postgres and Redis encrypted. The CA is the one
// workers.toml mounts and points NODE_EXTRA_CA_CERTS at.
const PRODUCTION_TRANSPORT = {
  DATABASE_HOST: "aws-1-eu-central-1.pooler.supabase.com",
  DATABASE_USER: "postgres.ref",
  DATABASE_SSL_MODE: "verify-full",
  NODE_EXTRA_CA_CERTS: "/etc/studafy/supabase-ca.pem",
  REDIS_URL: "rediss://default:pw@redis.example.com:6380",
};

describe("loadEnv", () => {
  test("applies defaults for an empty environment", () => {
    expect(loadEnv({})).toEqual({
      NODE_ENV: "development",
      SERVICE_NAME: "workers",
      RELEASE_VERSION: "unknown",
      METRICS_PORT: 9464,
      WORKERS_HEALTH_PORT: 8081,
      REDIS_URL: "redis://localhost:6379",
      SHUTDOWN_TIMEOUT_MS: 10_000,
      DATABASE_URL: "postgres://localhost:5432/studafy",
      SCHOOL_IDS: "",
      EMAIL_FROM_ADDRESS: "no-reply@send.studafy.com",
      EMAIL_FROM_NAME: "Studafy",
      EMAIL_DRY_RUN: false,
      PUSH_DRY_RUN: false,
      CLAMAV_PORT: 3310,
      CLAMAV_TIMEOUT_MS: 30_000,
      CLAMAV_MAX_FILE_BYTES: 25 * 1024 * 1024,
      FRONTEND_URL: "http://localhost:5180",
      EMAIL_MAX_RATE_PER_SECOND: 2,
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
      RELEASE_VERSION: "unknown",
      METRICS_PORT: 9464,
      WORKERS_HEALTH_PORT: 8081,
      REDIS_URL: "redis://redis.internal:6380",
      SHUTDOWN_TIMEOUT_MS: 30_000,
      DATABASE_URL: "postgres://localhost:5432/studafy",
      SCHOOL_IDS: "",
      EMAIL_FROM_ADDRESS: "no-reply@send.studafy.com",
      EMAIL_FROM_NAME: "Studafy",
      EMAIL_DRY_RUN: false,
      PUSH_DRY_RUN: false,
      CLAMAV_PORT: 3310,
      CLAMAV_TIMEOUT_MS: 30_000,
      CLAMAV_MAX_FILE_BYTES: 25 * 1024 * 1024,
      FRONTEND_URL: "http://localhost:5180",
      EMAIL_MAX_RATE_PER_SECOND: 2,
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
        ...PRODUCTION_TRANSPORT,
        ...PRODUCTION_TRANSPORT,
        READ_DATABASE_HOST: "pgbouncer.internal",
        READ_DATABASE_NAME: "workers_read",
        STRIPE_SECRET_KEY: "sk_test_prod",
        CLAMAV_HOST: "clamd.internal",
        ...RECORD_KEYS,
        RESEND_API_KEY: "re_test",
        FIREBASE_SERVICE_ACCOUNT: "{}",
      }),
    ).toMatchObject({
      READ_DATABASE_HOST: "pgbouncer.internal",
      READ_DATABASE_NAME: "workers_read",
      STRIPE_SECRET_KEY: "sk_test_prod",
      CLAMAV_HOST: "clamd.internal",
      ...RECORD_KEYS,
    });
  });

  test("boots in production without Stripe, as a Tap-only deployment does", () => {
    const env = loadEnv({
      NODE_ENV: "production",
      ...PRODUCTION_TRANSPORT,
      READ_DATABASE_HOST: "pgbouncer.internal",
      READ_DATABASE_NAME: "workers_read",
      CLAMAV_HOST: "clamd.internal",
      ...RECORD_KEYS,
      RESEND_API_KEY: "re_test",
      FIREBASE_SERVICE_ACCOUNT: "{}",
      // Injected empty by the task definition when the secret holds no Stripe key.
      STRIPE_SECRET_KEY: "",
    });
    expect(env.STRIPE_SECRET_KEY).toBeUndefined();
  });

  test("takes the Google Play package and service account together, the key as JSON", () => {
    const google = {
      GOOGLE_PLAY_PACKAGE_NAME: "com.studafy.studafy_mobile",
      GOOGLE_PLAY_SERVICE_ACCOUNT: '{"type":"service_account"}',
    };
    expect(loadEnv(google)).toMatchObject(google);
    expect(
      loadEnv({ GOOGLE_PLAY_PACKAGE_NAME: "", GOOGLE_PLAY_SERVICE_ACCOUNT: "" })
        .GOOGLE_PLAY_PACKAGE_NAME,
    ).toBeUndefined();
    expect(() => loadEnv({ ...google, GOOGLE_PLAY_SERVICE_ACCOUNT: "" })).toThrow(
      EnvValidationError,
    );
    expect(() => loadEnv({ ...google, GOOGLE_PLAY_SERVICE_ACCOUNT: "not json" })).toThrow(
      EnvValidationError,
    );
  });

  describe("email in production", () => {
    const deployed = {
      NODE_ENV: "production",
      ...PRODUCTION_TRANSPORT,
      READ_DATABASE_HOST: "pgbouncer.internal",
      READ_DATABASE_NAME: "workers_read",
      CLAMAV_HOST: "clamd.internal",
      ...RECORD_KEYS,
      PUSH_DRY_RUN: "true",
    };

    test("refuses to boot without Resend, so email can never silently stop", () => {
      expect(() => loadEnv(deployed)).toThrow(EnvValidationError);
      // A deploy can inject the key empty; empty must not count as set.
      expect(() => loadEnv({ ...deployed, RESEND_API_KEY: "" })).toThrow(EnvValidationError);
    });

    test("boots without Resend only when dry-run is chosen on purpose", () => {
      expect(loadEnv({ ...deployed, EMAIL_DRY_RUN: "true" }).EMAIL_DRY_RUN).toBe(true);
    });

    test("sends from the verified domain by default", () => {
      const env = loadEnv({ ...deployed, RESEND_API_KEY: "re_test" });
      expect(env.EMAIL_FROM_ADDRESS).toBe("no-reply@send.studafy.com");
      expect(env.EMAIL_FROM_NAME).toBe("Studafy");
    });
  });

  describe("push in production", () => {
    const deployed = {
      NODE_ENV: "production",
      ...PRODUCTION_TRANSPORT,
      READ_DATABASE_HOST: "pgbouncer.internal",
      READ_DATABASE_NAME: "workers_read",
      CLAMAV_HOST: "clamd.internal",
      ...RECORD_KEYS,
      EMAIL_DRY_RUN: "true",
    };

    test("refuses to boot without a Firebase service account, so push can never silently stop", () => {
      expect(() => loadEnv(deployed)).toThrow(EnvValidationError);
      expect(() => loadEnv({ ...deployed, FIREBASE_SERVICE_ACCOUNT: "" })).toThrow(
        EnvValidationError,
      );
    });

    test("boots without one only when dry-run is chosen on purpose", () => {
      expect(loadEnv({ ...deployed, PUSH_DRY_RUN: "true" }).PUSH_DRY_RUN).toBe(true);
    });
  });

  test("requires a real records keyring in production", () => {
    const production = {
      NODE_ENV: "production",
      ...PRODUCTION_TRANSPORT,
      EMAIL_DRY_RUN: "true",
      PUSH_DRY_RUN: "true",
      CLAMAV_HOST: "clamd.internal",
      READ_DATABASE_HOST: "pgbouncer.internal",
      READ_DATABASE_NAME: "api_read",
    };
    expect(() => loadEnv(production)).toThrow(/RECORDS_ENCRYPTION_KEYS is required/);
    expect(() =>
      loadEnv({
        ...production,
        RECORDS_ENCRYPTION_KEYS: JSON.stringify({
          "dev-1": Buffer.from("studafy-development-only-key-v1!").toString("base64"),
        }),
        RECORDS_ENCRYPTION_CURRENT_KEY_ID: "dev-1",
      }),
    ).toThrow(/development key/);
    expect(loadEnv({ ...production, ...RECORD_KEYS }).RECORDS_ENCRYPTION_CURRENT_KEY_ID).toBe(
      "prod-1",
    );
  });
});

describe("database URL", () => {
  const discrete = {
    DATABASE_HOST: "pooler.example.com",
    DATABASE_PORT: "6543",
    DATABASE_NAME: "postgres",
    DATABASE_USER: "postgres.ref",
    DATABASE_PASSWORD: "p@ss",
  };

  test("carries verify-full TLS on the primary and read URLs when asked", () => {
    const env = loadEnv({
      ...discrete,
      DATABASE_SSL_MODE: "verify-full",
      READ_DATABASE_HOST: "r.example.com",
    });
    expect(databaseUrlFrom(env)).toBe(
      "postgresql://postgres.ref:p%40ss@pooler.example.com:6543/postgres?sslmode=verify-full",
    );
    expect(readDatabaseUrlFrom(env)).toEndWith("@r.example.com:6543/postgres?sslmode=verify-full");
  });

  test("stays a plain URL when no TLS mode is set", () => {
    expect(databaseUrlFrom(loadEnv(discrete))).toBe(
      "postgresql://postgres.ref:p%40ss@pooler.example.com:6543/postgres",
    );
  });
});

describe("transport security in production (QA-066)", () => {
  const deployed = {
    NODE_ENV: "production",
    ...PRODUCTION_TRANSPORT,
    READ_DATABASE_HOST: "aws-1-eu-central-1.pooler.supabase.com",
    READ_DATABASE_NAME: "postgres",
    CLAMAV_HOST: "studafy-core-scanner.flycast",
    ...RECORD_KEYS,
    EMAIL_DRY_RUN: "true",
    PUSH_DRY_RUN: "true",
  };

  test("boots with verified TLS to Postgres and TLS to Redis", () => {
    const env = loadEnv(deployed);
    expect(databaseUrlFrom(env)).toEndWith("?sslmode=verify-full");
    expect(readDatabaseUrlFrom(env)).toEndWith("?sslmode=verify-full");
  });

  test("refuses a database connection without verify-full", () => {
    expect(() => loadEnv({ ...deployed, DATABASE_SSL_MODE: undefined })).toThrow(
      /DATABASE_SSL_MODE must be verify-full in production/,
    );
    // Without the discrete settings the URL is the local-development default, which has no TLS.
    expect(() =>
      loadEnv({ ...deployed, DATABASE_HOST: undefined, DATABASE_USER: undefined }),
    ).toThrow(/DATABASE_SSL_MODE must be verify-full in production/);
  });

  test("refuses verify-full with no CA to verify against", () => {
    expect(() => loadEnv({ ...deployed, NODE_EXTRA_CA_CERTS: undefined })).toThrow(
      /DATABASE_CA_CERT or NODE_EXTRA_CA_CERTS is required in production/,
    );
    expect(() => loadEnv({ ...deployed, NODE_EXTRA_CA_CERTS: "" })).toThrow(
      /DATABASE_CA_CERT or NODE_EXTRA_CA_CERTS is required in production/,
    );
    expect(
      loadEnv({
        ...deployed,
        NODE_EXTRA_CA_CERTS: undefined,
        DATABASE_CA_CERT: "-----BEGIN CERTIFICATE-----",
      }).DATABASE_CA_CERT,
    ).toBe("-----BEGIN CERTIFICATE-----");
  });

  test("refuses a plaintext Redis URL, including the default", () => {
    for (const REDIS_URL of [
      undefined,
      "redis://redis.example.com:6379",
      "redis://10.0.0.5:6379",
      "redis://evil.internal.example.com:6379",
      "not a url",
    ]) {
      expect(() => loadEnv({ ...deployed, REDIS_URL })).toThrow(/REDIS_URL must use rediss:\/\//);
    }
  });

  test("accepts plaintext Redis only on Fly's private network", () => {
    for (const REDIS_URL of [
      "redis://studafy-redis.internal:6379",
      "redis://studafy-redis.flycast:6379",
      "rediss://redis.example.com:6380/1",
    ]) {
      expect(loadEnv({ ...deployed, REDIS_URL }).REDIS_URL).toBe(REDIS_URL);
    }
  });

  test("leaves development and tests alone", () => {
    expect(loadEnv({}).REDIS_URL).toBe("redis://localhost:6379");
    expect(databaseUrlFrom(loadEnv({}))).toBe("postgres://localhost:5432/studafy");
  });
});
