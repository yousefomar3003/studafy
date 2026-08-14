// eslint-disable-next-line import-x/no-unresolved -- "bun:test" is a virtual Bun built-in
import { afterAll, beforeAll, describe, expect, test } from "bun:test";

import {
  assignRole,
  authenticatedRequest,
  createSchool,
  createTestApp,
  createTestDatabase,
  createUser,
  integrationEnabled,
  migrateDatabase,
} from "../harness";

import type { TestApp, TestDatabase } from "../harness";
import type { SchoolRecord, UserRecord } from "../harness/factories";

/**
 * Route-level coverage for ST-188's invitation-management screens: the new `GET /api/invitations`
 * list endpoint (status derivation), and — since the acceptance criteria require actions be
 * "verified via audit explorer" and no such admin UI exists yet — a direct check that
 * revoke/regenerate actually land in `GET /api/audit/logs`, the API the (not-yet-built) explorer
 * would read from. This does not assert anything about a UI; it proves the audit trail this
 * screen's actions depend on is real, not just wired-looking.
 */

const integrationTest = test.skipIf(!integrationEnabled);

let database: TestDatabase | undefined;
let harness: TestApp | undefined;
let school: SchoolRecord | undefined;
let admin: UserRecord | undefined;

describe("invitation routes", () => {
  beforeAll(async () => {
    if (!integrationEnabled) return;

    database = await createTestDatabase();
    await migrateDatabase(database.url);
    school = await createSchool(database.sql, { slug: `st188-${crypto.randomUUID().slice(0, 8)}` });
    admin = await createUser(database.sql, school.id, {
      email: `admin-${crypto.randomUUID().slice(0, 8)}@test.local`,
    });
    await assignRole(database.sql, school.id, admin.id, "ORG_ADMIN");

    const created = createTestApp({ database: database.sql });
    await created.ready;
    harness = created;
  }, 60_000);

  afterAll(async () => {
    harness?.keyStore.destroy();
    await database?.cleanup();
  });

  integrationTest("create then list shows the invitation as pending, with no token", async () => {
    const auth = { schoolId: school!.id, userId: admin!.id, roles: ["ORG_ADMIN" as const] };
    const email = `invitee-${crypto.randomUUID().slice(0, 8)}@test.local`;

    const createRes = await authenticatedRequest(harness!, "POST", "/api/invitations", auth, {
      body: JSON.stringify({ email, role: "STUDENT" }),
      headers: { "Content-Type": "application/json" },
    });
    expect(createRes.status).toBe(201);
    const created = (await createRes.json()) as { invitation: { id: string }; token: string };
    expect(created.token).toMatch(/^[0-9a-f]{64}$/);

    const listRes = await authenticatedRequest(harness!, "GET", "/api/invitations", auth);
    expect(listRes.status).toBe(200);
    const list = (await listRes.json()) as {
      invitations: { id: string; status: string; email: string }[];
    };
    const row = list.invitations.find((i) => i.id === created.invitation.id);
    expect(row).toBeDefined();
    expect(row!.status).toBe("pending");
    expect(row!.email).toBe(email);
    expect(row).not.toHaveProperty("token");
  });

  integrationTest(
    "revoke flips status to revoked and is visible via GET /api/audit/logs",
    async () => {
      const auth = { schoolId: school!.id, userId: admin!.id, roles: ["ORG_ADMIN" as const] };

      const createRes = await authenticatedRequest(harness!, "POST", "/api/invitations", auth, {
        body: JSON.stringify({
          email: `revoke-${crypto.randomUUID().slice(0, 8)}@test.local`,
          role: "STUDENT",
        }),
        headers: { "Content-Type": "application/json" },
      });
      const created = (await createRes.json()) as { invitation: { id: string } };
      const invitationId = created.invitation.id;

      const revokeRes = await authenticatedRequest(
        harness!,
        "POST",
        `/api/invitations/${invitationId}/revoke`,
        auth,
      );
      expect(revokeRes.status).toBe(200);

      const listRes = await authenticatedRequest(harness!, "GET", "/api/invitations", auth);
      const list = (await listRes.json()) as { invitations: { id: string; status: string }[] };
      expect(list.invitations.find((i) => i.id === invitationId)?.status).toBe("revoked");

      // This is the "verified via audit explorer" check: the audit trail exists at the API the
      // acceptance criteria's explorer would read from, keyed on the exact invitation id.
      const auditRes = await authenticatedRequest(
        harness!,
        "GET",
        `/api/audit/logs?target_table=invitations&target_id=${invitationId}&action=update`,
        auth,
      );
      expect(auditRes.status).toBe(200);
      const audit = (await auditRes.json()) as {
        items: {
          target_id: string;
          target_table: string;
          action: string;
          actor_id: string | null;
        }[];
      };
      expect(audit.items.length).toBeGreaterThanOrEqual(1);
      expect(audit.items[0]!.target_id).toBe(invitationId);
      expect(audit.items[0]!.actor_id).toBe(admin!.id);
    },
  );

  integrationTest(
    "resend (regenerate) revokes the old invitation and audits both the old and new rows",
    async () => {
      const auth = { schoolId: school!.id, userId: admin!.id, roles: ["ORG_ADMIN" as const] };

      const createRes = await authenticatedRequest(harness!, "POST", "/api/invitations", auth, {
        body: JSON.stringify({
          email: `resend-${crypto.randomUUID().slice(0, 8)}@test.local`,
          role: "STUDENT",
        }),
        headers: { "Content-Type": "application/json" },
      });
      const created = (await createRes.json()) as { invitation: { id: string } };
      const oldId = created.invitation.id;

      const regenerateRes = await authenticatedRequest(
        harness!,
        "POST",
        `/api/invitations/${oldId}/regenerate`,
        auth,
      );
      expect(regenerateRes.status).toBe(201);
      const regenerated = (await regenerateRes.json()) as {
        invitation: { id: string };
        revoked_invitation_id: string;
      };
      expect(regenerated.revoked_invitation_id).toBe(oldId);
      const newId = regenerated.invitation.id;

      const listRes = await authenticatedRequest(harness!, "GET", "/api/invitations", auth);
      const list = (await listRes.json()) as { invitations: { id: string; status: string }[] };
      expect(list.invitations.find((i) => i.id === oldId)?.status).toBe("revoked");
      expect(list.invitations.find((i) => i.id === newId)?.status).toBe("pending");

      const oldAuditRes = await authenticatedRequest(
        harness!,
        "GET",
        `/api/audit/logs?target_table=invitations&target_id=${oldId}&action=update`,
        auth,
      );
      expect(
        ((await oldAuditRes.json()) as { items: unknown[] }).items.length,
      ).toBeGreaterThanOrEqual(1);

      const newAuditRes = await authenticatedRequest(
        harness!,
        "GET",
        `/api/audit/logs?target_table=invitations&target_id=${newId}&action=insert`,
        auth,
      );
      expect(
        ((await newAuditRes.json()) as { items: unknown[] }).items.length,
      ).toBeGreaterThanOrEqual(1);
    },
  );

  integrationTest("status filter narrows the list to matching rows", async () => {
    const auth = { schoolId: school!.id, userId: admin!.id, roles: ["ORG_ADMIN" as const] };

    const createRes = await authenticatedRequest(harness!, "POST", "/api/invitations", auth, {
      body: JSON.stringify({
        email: `filter-${crypto.randomUUID().slice(0, 8)}@test.local`,
        role: "STUDENT",
      }),
      headers: { "Content-Type": "application/json" },
    });
    const created = (await createRes.json()) as { invitation: { id: string } };

    const pendingRes = await authenticatedRequest(
      harness!,
      "GET",
      "/api/invitations?status=pending",
      auth,
    );
    const pending = (await pendingRes.json()) as { invitations: { id: string; status: string }[] };
    expect(pending.invitations.every((i) => i.status === "pending")).toBe(true);
    expect(pending.invitations.some((i) => i.id === created.invitation.id)).toBe(true);

    const revokedRes = await authenticatedRequest(
      harness!,
      "GET",
      "/api/invitations?status=revoked",
      auth,
    );
    const revoked = (await revokedRes.json()) as { invitations: { id: string }[] };
    expect(revoked.invitations.some((i) => i.id === created.invitation.id)).toBe(false);
  });

  integrationTest("a non-admin role is forbidden from listing invitations", async () => {
    const student = await createUser(database!.sql, school!.id, {
      email: `student-${crypto.randomUUID().slice(0, 8)}@test.local`,
    });
    await assignRole(database!.sql, school!.id, student.id, "STUDENT");

    const res = await authenticatedRequest(harness!, "GET", "/api/invitations", {
      schoolId: school!.id,
      userId: student.id,
      roles: ["STUDENT"],
    });
    expect(res.status).toBe(403);
  });
});
