/**
 * Timetable HTTP tests: the timetable:manage gate on every write, one-step publish, and the school
 * week settings (000122). Full HTTP path — JWT auth, permission gates, a real tenant transaction with
 * RLS armed, and the audit rows the service writes. Requires a live PostgreSQL instance, gated on
 * TEST_DATABASE_URL like every other integration suite.
 *
 *   TEST_DATABASE_URL=postgres://... bun test tests/timetable/timetable-http.test.ts
 */

import { ROLES } from "@studafy/constants";
// eslint-disable-next-line import-x/no-unresolved -- "bun:test" is a virtual Bun built-in with no resolvable file path
import { afterAll, beforeAll, describe, expect, test } from "bun:test";

import {
  assignRole,
  authenticatedRequest,
  createFullTenant,
  createTestApp,
  createTestDatabase,
  createUser,
  integrationEnabled,
  migrateDatabase,
} from "../harness";

import type { TenantFixture, TestApp, TestDatabase } from "../harness";
import type { Role } from "@studafy/constants";

const describeDb = integrationEnabled ? describe : describe.skip;

let database: TestDatabase | undefined;
let harness: TestApp | undefined;

beforeAll(async () => {
  if (!integrationEnabled) return;
  database = await createTestDatabase();
  await migrateDatabase(database.url);
  const created = createTestApp({ database: database.sql });
  await created.ready;
  harness = created;
}, 60_000);

afterAll(async () => {
  harness?.keyStore.destroy();
  await database?.cleanup();
});

interface Actor {
  schoolId: string;
  userId: string;
  roles: Role[];
}

interface VersionResponse {
  id: string;
  status: string;
  submitted_at: string | null;
  approved_at: string | null;
}

async function principalOf(fixture: TenantFixture): Promise<Actor> {
  const user = await createUser(database!.sql, fixture.schoolId, {
    email: `principal-${crypto.randomUUID().slice(0, 8)}@test.local`,
  });
  await assignRole(database!.sql, fixture.schoolId, user.id, ROLES.PRINCIPAL);
  return { schoolId: fixture.schoolId, userId: user.id, roles: [ROLES.PRINCIPAL] };
}

function actorOf(fixture: TenantFixture, role: Exclude<Role, "PRINCIPAL" | "FINANCE">): Actor {
  // eslint-disable-next-line security/detect-object-injection -- `role` is a fixed Role literal from the test itself, never external input
  return { schoolId: fixture.schoolId, userId: fixture.users[role].id, roles: [role] };
}

function request(actor: Actor, method: string, path: string, body?: unknown) {
  return authenticatedRequest(
    harness!,
    method,
    path,
    actor,
    body === undefined
      ? undefined
      : { headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) },
  );
}

async function createDraft(actor: Actor, fixture: TenantFixture): Promise<VersionResponse> {
  const response = await request(actor, "POST", "/api/academics/timetable-versions", {
    term_id: fixture.term.id,
    academic_year_id: fixture.academicYear.id,
    name: "Weekly schedule",
  });
  expect(response.status).toBe(201);
  return (await response.json()) as VersionResponse;
}

function slotBody(fixture: TenantFixture) {
  return {
    class_id: fixture.cls.id,
    teacher_id: fixture.teachers[0]!.id,
    room_id: fixture.room.id,
    weekday: 7,
    period: 1,
  };
}

describeDb("timetable HTTP", () => {
  test("a principal builds a draft and publishes it in one step", async () => {
    const fixture = await createFullTenant(database!.sql);
    const principal = await principalOf(fixture);

    const draft = await createDraft(principal, fixture);
    const slot = await request(
      principal,
      "POST",
      `/api/academics/timetable-versions/${draft.id}/slots`,
      slotBody(fixture),
    );
    expect(slot.status).toBe(201);

    const published = await request(
      principal,
      "POST",
      `/api/academics/timetable-versions/${draft.id}/publish`,
    );
    expect(published.status).toBe(200);
    const version = (await published.json()) as VersionResponse;
    expect(version.status).toBe("approved");
    expect(version.submitted_at).not.toBeNull();
    expect(version.approved_at).not.toBeNull();

    // An approved version is no longer a draft: publishing it again is a state conflict.
    const again = await request(
      principal,
      "POST",
      `/api/academics/timetable-versions/${draft.id}/publish`,
    );
    expect(again.status).toBe(409);

    const audit = await database!.sql<{ status: string }[]>`
      SELECT new_values->>'status' AS status FROM app.audit_logs
      WHERE school_id = ${fixture.schoolId} AND target_table = 'timetable_versions'
        AND target_id = ${draft.id} AND action = 'update'
    `;
    // Both transitions run in one transaction, so they share a timestamp: compare as a set.
    expect(audit.map((row) => row.status).sort()).toEqual(["approved", "pending"]);
  });

  test("teachers and students read the timetable but cannot change it", async () => {
    const fixture = await createFullTenant(database!.sql);
    const admin = actorOf(fixture, "ORG_ADMIN");
    const draft = await createDraft(admin, fixture);
    const slotResponse = await request(
      admin,
      "POST",
      `/api/academics/timetable-versions/${draft.id}/slots`,
      slotBody(fixture),
    );
    const { id: slotId } = (await slotResponse.json()) as { id: string };

    for (const role of ["INSTRUCTOR", "STUDENT"] as const) {
      const actor = actorOf(fixture, role);
      expect(
        (
          await request(
            actor,
            "GET",
            `/api/academics/timetable-versions?term_id=${fixture.term.id}&limit=10&offset=0`,
          )
        ).status,
      ).toBe(200);
      expect((await request(actor, "GET", "/api/academics/timetable-settings")).status).toBe(200);

      expect(
        (
          await request(actor, "POST", "/api/academics/timetable-versions", {
            term_id: fixture.term.id,
            academic_year_id: fixture.academicYear.id,
            name: "Nope",
          })
        ).status,
      ).toBe(403);
      expect(
        (
          await request(
            actor,
            "POST",
            `/api/academics/timetable-versions/${draft.id}/slots`,
            slotBody(fixture),
          )
        ).status,
      ).toBe(403);
      expect(
        (await request(actor, "PATCH", `/api/academics/slots/${slotId}`, { period: 2 })).status,
      ).toBe(403);
      expect((await request(actor, "DELETE", `/api/academics/slots/${slotId}`)).status).toBe(403);
      expect(
        (await request(actor, "POST", `/api/academics/timetable-versions/${draft.id}/publish`))
          .status,
      ).toBe(403);
      expect(
        (
          await request(actor, "PUT", "/api/academics/timetable-settings", {
            school_days: [1, 2, 3, 4, 5],
            periods_per_day: 6,
          })
        ).status,
      ).toBe(403);
    }
  });

  test("school week settings default to Sunday–Thursday and are updated with an audit entry", async () => {
    const fixture = await createFullTenant(database!.sql);
    const principal = await principalOf(fixture);

    const initial = await request(principal, "GET", "/api/academics/timetable-settings");
    expect(initial.status).toBe(200);
    expect(await initial.json()).toEqual({ school_days: [7, 1, 2, 3, 4], periods_per_day: 8 });

    const updated = await request(principal, "PUT", "/api/academics/timetable-settings", {
      school_days: [1, 2, 3, 4, 5],
      periods_per_day: 6,
    });
    expect(updated.status).toBe(200);
    expect(await updated.json()).toEqual({ school_days: [1, 2, 3, 4, 5], periods_per_day: 6 });

    const reread = await request(
      actorOf(fixture, "INSTRUCTOR"),
      "GET",
      "/api/academics/timetable-settings",
    );
    expect(await reread.json()).toEqual({ school_days: [1, 2, 3, 4, 5], periods_per_day: 6 });

    const audit = await database!.sql<{ count: number }[]>`
      SELECT count(*)::int AS count FROM app.audit_logs
      WHERE school_id = ${fixture.schoolId} AND target_table = 'school_settings'
    `;
    expect(audit[0]!.count).toBe(1);
  });

  test("editing a live timetable copies its lessons into a new draft", async () => {
    const fixture = await createFullTenant(database!.sql);
    const principal = await principalOf(fixture);
    const live = await createDraft(principal, fixture);
    await request(
      principal,
      "POST",
      `/api/academics/timetable-versions/${live.id}/slots`,
      slotBody(fixture),
    );
    await request(principal, "POST", `/api/academics/timetable-versions/${live.id}/publish`);

    const copied = await request(principal, "POST", "/api/academics/timetable-versions/copy", {
      source_version_id: live.id,
      term_id: fixture.term.id,
      academic_year_id: fixture.academicYear.id,
      name: "Weekly schedule (2)",
    });
    expect(copied.status).toBe(201);
    const body = (await copied.json()) as {
      timetable_version: VersionResponse;
      slots_copied: number;
      slots_skipped: number;
    };
    expect(body.timetable_version.status).toBe("draft");
    expect(body.slots_copied).toBe(1);
    expect(body.slots_skipped).toBe(0);
  });

  test("publishing a new version archives the previous live one", async () => {
    const fixture = await createFullTenant(database!.sql);
    const principal = await principalOf(fixture);
    const first = await createDraft(principal, fixture);
    await request(principal, "POST", `/api/academics/timetable-versions/${first.id}/publish`);

    const copied = await request(principal, "POST", "/api/academics/timetable-versions/copy", {
      source_version_id: first.id,
      term_id: fixture.term.id,
      academic_year_id: fixture.academicYear.id,
      name: "Weekly schedule (2)",
    });
    const { timetable_version: second } = (await copied.json()) as {
      timetable_version: VersionResponse;
    };

    const published = await request(
      principal,
      "POST",
      `/api/academics/timetable-versions/${second.id}/publish`,
    );
    expect(published.status).toBe(200);

    const listed = await request(
      principal,
      "GET",
      `/api/academics/timetable-versions?term_id=${fixture.term.id}&limit=10&offset=0`,
    );
    const { timetable_versions } = (await listed.json()) as {
      timetable_versions: VersionResponse[];
    };
    const statusById = new Map(timetable_versions.map((version) => [version.id, version.status]));
    expect(statusById.get(first.id)).toBe("archived");
    expect(statusById.get(second.id)).toBe("approved");
  });

  test("a duplicate version name in the same term is a 409, not a 500", async () => {
    const fixture = await createFullTenant(database!.sql);
    const principal = await principalOf(fixture);
    await createDraft(principal, fixture);

    const duplicate = await request(principal, "POST", "/api/academics/timetable-versions", {
      term_id: fixture.term.id,
      academic_year_id: fixture.academicYear.id,
      name: "Weekly schedule",
    });
    expect(duplicate.status).toBe(409);
  });

  test("discarding a draft with slots needs discard_slots=true", async () => {
    const fixture = await createFullTenant(database!.sql);
    const principal = await principalOf(fixture);
    const draft = await createDraft(principal, fixture);
    await request(
      principal,
      "POST",
      `/api/academics/timetable-versions/${draft.id}/slots`,
      slotBody(fixture),
    );

    const refused = await request(
      principal,
      "DELETE",
      `/api/academics/timetable-versions/${draft.id}`,
    );
    expect(refused.status).toBe(409);

    const discarded = await request(
      principal,
      "DELETE",
      `/api/academics/timetable-versions/${draft.id}?discard_slots=true`,
    );
    expect(discarded.status).toBe(204);

    const remaining = await database!.sql<{ count: number }[]>`
      SELECT count(*)::int AS count FROM app.timetable_slots
      WHERE school_id = ${fixture.schoolId} AND timetable_version_id = ${draft.id}
    `;
    expect(remaining[0]!.count).toBe(0);
  });

  test("rejects invalid school weeks", async () => {
    const fixture = await createFullTenant(database!.sql);
    const principal = await principalOf(fixture);

    for (const body of [
      { school_days: [], periods_per_day: 8 },
      { school_days: [1, 1, 2], periods_per_day: 8 },
      { school_days: [0, 1], periods_per_day: 8 },
      { school_days: [1, 2], periods_per_day: 0 },
      { school_days: [1, 2], periods_per_day: 17 },
    ]) {
      const response = await request(principal, "PUT", "/api/academics/timetable-settings", body);
      expect(response.status).toBe(400);
    }
  });
});
