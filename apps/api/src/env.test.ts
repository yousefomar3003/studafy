// eslint-disable-next-line import-x/no-unresolved -- "bun:test" is a virtual Bun built-in with no resolvable file path
import { describe, expect, test } from "bun:test";

import { EnvValidationError, loadEnv } from "./env";

describe("loadEnv", () => {
  test("applies defaults for an empty environment", () => {
    expect(loadEnv({})).toEqual({
      NODE_ENV: "development",
      PORT: 3000,
      HOST: "0.0.0.0",
      SHUTDOWN_TIMEOUT_MS: 10_000,
    });
  });

  test("parses and coerces provided values", () => {
    expect(
      loadEnv({
        NODE_ENV: "production",
        PORT: "8080",
        HOST: "127.0.0.1",
        SHUTDOWN_TIMEOUT_MS: "5000",
      }),
    ).toEqual({
      NODE_ENV: "production",
      PORT: 8080,
      HOST: "127.0.0.1",
      SHUTDOWN_TIMEOUT_MS: 5000,
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
});
