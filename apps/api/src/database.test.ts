// eslint-disable-next-line import-x/no-unresolved -- "bun:test" is a virtual Bun built-in
import { describe, expect, test } from "bun:test";

import { checkDatabase, createDatabase } from "./database";
import { loadEnv } from "./env";

describe("database", () => {
  test("is optional outside production", async () => {
    const database = createDatabase(loadEnv({ NODE_ENV: "test" }));
    expect(database).toBeNull();
    expect(await checkDatabase(database)).toBe(true);
  });

  test("creates a lazy PgBouncer client with complete TLS configuration", async () => {
    const database = createDatabase(
      loadEnv({
        NODE_ENV: "production",
        DATABASE_HOST: "pgbouncer.internal",
        DATABASE_PORT: "6432",
        DATABASE_NAME: "api",
        DATABASE_USER: "api",
        DATABASE_PASSWORD: "secret",
        DATABASE_CA_CERT: "-----BEGIN CERTIFICATE-----\ntest\n-----END CERTIFICATE-----",
        READ_DATABASE_HOST: "pgbouncer.internal",
        READ_DATABASE_NAME: "api_read",
      }),
    );
    expect(database).not.toBeNull();
    await database?.end({ timeout: 0 });
  });
});
