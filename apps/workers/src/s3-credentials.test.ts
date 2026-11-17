// eslint-disable-next-line import-x/no-unresolved -- "bun:test" is a virtual Bun built-in with no resolvable file path
import { describe, expect, test } from "bun:test";

import { EnvValidationError, loadEnv } from "./env";
import { applyS3CredentialAliases } from "./s3-credentials";

// QA-071: the workers take the R2 keys under the same S3_* names as the api, not as AWS_* (they are
// Cloudflare R2 keys, not AWS ones). The S3 SDK's credential chain still reads AWS_*, so bootstrap
// copies them across.
describe("S3 credential names (QA-071)", () => {
  test("copies S3_ACCESS_KEY_ID/S3_SECRET_ACCESS_KEY to the SDK's names", () => {
    const env: Record<string, string | undefined> = {
      S3_ACCESS_KEY_ID: "r2-id",
      S3_SECRET_ACCESS_KEY: "r2-secret",
    };
    applyS3CredentialAliases(env);
    expect(env.AWS_ACCESS_KEY_ID).toBe("r2-id");
    expect(env.AWS_SECRET_ACCESS_KEY).toBe("r2-secret");
  });

  test("the S3_* pair wins over stale AWS_* secrets left on the app", () => {
    const env: Record<string, string | undefined> = {
      S3_ACCESS_KEY_ID: "new-id",
      S3_SECRET_ACCESS_KEY: "new-secret",
      AWS_ACCESS_KEY_ID: "old-id",
      AWS_SECRET_ACCESS_KEY: "old-secret",
    };
    applyS3CredentialAliases(env);
    expect(env.AWS_ACCESS_KEY_ID).toBe("new-id");
    expect(env.AWS_SECRET_ACCESS_KEY).toBe("new-secret");
  });

  test("leaves AWS_* alone when no S3_* pair is set", () => {
    const env: Record<string, string | undefined> = { AWS_ACCESS_KEY_ID: "id" };
    applyS3CredentialAliases(env);
    expect(env).toEqual({ AWS_ACCESS_KEY_ID: "id" });
  });

  test("the environment takes the two halves together", () => {
    expect(loadEnv({ S3_ACCESS_KEY_ID: "id", S3_SECRET_ACCESS_KEY: "s" })).toMatchObject({
      S3_ACCESS_KEY_ID: "id",
      S3_SECRET_ACCESS_KEY: "s",
    });
    expect(() => loadEnv({ S3_ACCESS_KEY_ID: "id" })).toThrow(EnvValidationError);
    expect(() => loadEnv({ S3_SECRET_ACCESS_KEY: "s" })).toThrow(EnvValidationError);
    // An empty secret injected by a deploy template counts as unset.
    expect(loadEnv({ S3_ACCESS_KEY_ID: "", S3_SECRET_ACCESS_KEY: "" }).S3_ACCESS_KEY_ID).toBe(
      undefined,
    );
  });
});
