/**
 * Legal acceptance (000187) end to end at the service level: a user who has not accepted the current
 * Terms of Service and Privacy Policy is issued a token carrying `legal_acceptance_pending`;
 * accepting the current versions records them, and the refreshed token no longer carries the claim.
 * Outdated versions are refused. Requires a live PostgreSQL instance, gated on TEST_DATABASE_URL.
 */

import { LEGAL_DOCUMENT_VERSIONS } from "@studafy/constants";
// eslint-disable-next-line import-x/no-unresolved -- "bun:test" is a virtual Bun built-in with no resolvable file path
import { afterAll, beforeAll, describe, expect, test } from "bun:test";

import { withTenantTx } from "../../src/db/tenant-tx";
import { acceptLegalDocuments } from "../../src/modules/account/legal-acceptance-service";
import { getAccountProfile } from "../../src/modules/account/profile-service";
import { AUTH_CHANNELS, KeyStore } from "../../src/modules/auth";
import {
  issueTokenPair,
  rotateRefreshToken,
} from "../../src/modules/auth/services/session-service";
import {
  createFullTenant,
  createTestDatabase,
  integrationEnabled,
  migrateDatabase,
} from "../harness";

import type { SessionTokenConfig } from "../../src/modules/auth/services/session-service";
import type { TestDatabase } from "../harness";

const integrationTest = test.skipIf(!integrationEnabled);

let db: TestDatabase | undefined;
let keyStore: KeyStore | undefined;

beforeAll(async () => {
  if (!integrationEnabled) return;
  db = await createTestDatabase({ maxConnections: 8 });
  await migrateDatabase(db.url);
  keyStore = new KeyStore(60_000);
  await keyStore.init();
}, 120_000);

afterAll(async () => {
  keyStore?.destroy();
  await db?.cleanup();
});

function config(): SessionTokenConfig {
  return {
    keyStore: keyStore!,
    issuer: "studafy-test",
    audience: "studafy-api-test",
    accessTtlSeconds: 900,
    refreshTtlSeconds: 3600,
  };
}

function decode(token: string): Record<string, unknown> {
  return JSON.parse(Buffer.from(token.split(".")[1]!, "base64url").toString()) as Record<
    string,
    unknown
  >;
}

const CURRENT = {
  termsVersion: LEGAL_DOCUMENT_VERSIONS.terms,
  privacyVersion: LEGAL_DOCUMENT_VERSIONS.privacy,
};

describe("legal acceptance", () => {
  integrationTest(
    "a user must accept before the claim clears, and only current versions count",
    async () => {
      const tenant = await createFullTenant(db!.sql);
      const schoolId = tenant.schoolId;
      // A mobile-only role signs in on the mobile channel (see tests/entitlements/token-claims.test.ts).
      const userId = tenant.users.INSTRUCTOR.id;
      // Test users are created having accepted (tests/harness/factories.ts); this one has not.
      await db!.sql`
        UPDATE app.users SET terms_version = NULL, privacy_version = NULL, legal_accepted_at = NULL
         WHERE id = ${userId}::uuid
      `;

      const issued = await withTenantTx(db!.sql, { schoolId, userId }, (tx) =>
        issueTokenPair(tx, config(), { userId, schoolId, channel: AUTH_CHANNELS.MOBILE }),
      );
      expect(decode(issued.accessToken).legal_acceptance_pending).toBe(true);

      // An outdated version is refused and records nothing.
      await expect(
        withTenantTx(db!.sql, { schoolId, userId }, (tx) =>
          acceptLegalDocuments(tx, userId, { ...CURRENT, termsVersion: "2000-01-01" }),
        ),
      ).rejects.toMatchObject({ code: "LEGAL_VERSION_OUTDATED" });

      const accepted = await withTenantTx(db!.sql, { schoolId, userId }, (tx) =>
        acceptLegalDocuments(tx, userId, CURRENT),
      );
      expect(accepted.termsVersion).toBe(LEGAL_DOCUMENT_VERSIONS.terms);

      const profile = await withTenantTx(db!.sql, { schoolId, userId }, (tx) =>
        getAccountProfile(tx, schoolId, userId),
      );
      expect(profile?.terms_version).toBe(LEGAL_DOCUMENT_VERSIONS.terms);
      expect(profile?.privacy_version).toBe(LEGAL_DOCUMENT_VERSIONS.privacy);
      expect(profile?.legal_accepted_at).toBeInstanceOf(Date);

      // The refreshed token is minted from the updated row: no claim, so the guard lets it through.
      const rotated = await rotateRefreshToken(db!.sql, config(), {
        presentedToken: issued.refreshToken,
      });
      expect(decode(rotated.accessToken).legal_acceptance_pending).toBeUndefined();
    },
  );

  integrationTest("a user who accepted an older version is asked again", async () => {
    const tenant = await createFullTenant(db!.sql);
    const schoolId = tenant.schoolId;
    const userId = tenant.users.INSTRUCTOR.id;
    await db!.sql`
      UPDATE app.users
         SET terms_version = '2000-01-01', privacy_version = ${LEGAL_DOCUMENT_VERSIONS.privacy},
             legal_accepted_at = now()
       WHERE id = ${userId}::uuid
    `;

    const issued = await withTenantTx(db!.sql, { schoolId, userId }, (tx) =>
      issueTokenPair(tx, config(), { userId, schoolId, channel: AUTH_CHANNELS.MOBILE }),
    );
    expect(decode(issued.accessToken).legal_acceptance_pending).toBe(true);
  });
});
