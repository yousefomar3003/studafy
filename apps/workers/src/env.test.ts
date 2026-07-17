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
    });
  });

  test("parses and coerces provided values", () => {
    expect(
      loadEnv({
        NODE_ENV: "production",
        REDIS_URL: "redis://redis.internal:6380",
        SHUTDOWN_TIMEOUT_MS: "30000",
      }),
    ).toEqual({
      NODE_ENV: "production",
      REDIS_URL: "redis://redis.internal:6380",
      SHUTDOWN_TIMEOUT_MS: 30_000,
      DATABASE_URL: "postgres://localhost:5432/studafy",
      SCHOOL_IDS: "",
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
});
