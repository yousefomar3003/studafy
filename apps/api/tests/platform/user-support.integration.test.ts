// Platform console per-account support actions against a real, migrated database.
//
// The operator is a SUPER_ADMIN of a home school acting on accounts in another school, so each
// action must work inside that school's RLS scope with no actor there, and write two audit rows:
// a system row in the target school and an attributed row at home. Only a real database shows that
// the composite actor FK, the SECURITY DEFINER session revoke and the invitation outbox all hold.

// eslint-disable-next-line import-x/no-unresolved -- "bun:test" is a virtual Bun built-in
import { afterAll, beforeAll, describe, expect, test } from "bun:test";

import {
  deactivateAccount,
  getSupportUser,
  reactivateAccount,
  resendInvitation,
  signOutEverywhere,
  unlockAccount,
} from "../../src/modules/platform/user-support-service";
import { linkParentToStudent } from "../../src/modules/users/student-service";
import {
  assignRole,
  createRefreshSession,
  createSchool,
  createStudent,
  createTestDatabase,
  createUser,
  integrationEnabled,
  migrateDatabase,
  type TestDatabase,
} from "../harness";

import type { Database } from "../../src/db/client";
import type { Logger } from "../../src/logger";
import type { Actor } from "../../src/modules/platform/service";
import type { SupportDeps } from "../../src/modules/platform/user-support-service";

const integrationTest = test.skipIf(!integrationEnabled);

const silentLogger: Logger = {
  level: "info",
  trace: () => undefined,
  debug: () => undefined,
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
  fatal: () => undefined,
  child: () => silentLogger,
};

interface Fixture {
  home: string;
  school: string;
  actor: Actor;
  otherOperator: string;
  parent: string;
  student: string;
  invitedTeacher: string;
  memberParent: string;
  activeTeacher: string;
}

let db: TestDatabase;
let fixture: Fixture;

const database = () => db.sql as unknown as Database;
const deps = (): SupportDeps => ({ database: database(), denylist: null, logger: silentLogger });
const REASON = "Support ticket 1234: user asked for help";

async function asAdmin<T>(schoolId: string, fn: (tx: TestDatabase["sql"]) => Promise<T>) {
  return db.sql.begin(async (tx) => {
    await tx.unsafe("SET LOCAL ROLE studafy_admin");
    await tx`SELECT set_config('app.school_id', ${schoolId}, true)`;
    return fn(tx as unknown as TestDatabase["sql"]);
  }) as Promise<T>;
}

async function seed(sql: TestDatabase["sql"]): Promise<Fixture> {
  const home = (await createSchool(sql, { name: "Studafy HQ" })).id;
  const school = (await createSchool(sql, { name: "Gamma School" })).id;

  const operator = await createUser(sql, home, { email: "ops@studafy.test" });
  await assignRole(sql, home, operator.id, "SUPER_ADMIN");
  const otherOperator = await createUser(sql, home, { email: "ops2@studafy.test" });
  await assignRole(sql, home, otherOperator.id, "SUPER_ADMIN");

  const parentUser = await createUser(sql, school, {
    email: "mother@gamma.test",
    displayName: "Mona Parent",
  });
  await assignRole(sql, school, parentUser.id, "PARENT");
  const student = await createStudent(sql, school, { firstName: "Sami", lastName: "Kid" });
  await assignRole(sql, school, student.userId, "STUDENT");

  const invitedTeacher = await createUser(sql, school, {
    email: "new.teacher@gamma.test",
    status: "invited",
  });
  await assignRole(sql, school, invitedTeacher.id, "INSTRUCTOR");

  const memberParent = await createUser(sql, school, { displayName: "Code Parent" });
  await assignRole(sql, school, memberParent.id, "PARENT");

  const activeTeacher = await createUser(sql, school, { email: "teacher@gamma.test" });
  await assignRole(sql, school, activeTeacher.id, "INSTRUCTOR");

  await sql.begin(async (tx) => {
    await tx.unsafe("SET LOCAL ROLE studafy_admin");
    await tx`UPDATE app.schools SET status = 'active' WHERE id IN (${home}, ${school})`;
    await tx`SELECT set_config('app.school_id', ${school}, true)`;
    await linkParentToStudent(
      tx as unknown as Parameters<typeof linkParentToStudent>[0],
      school,
      student.id,
      parentUser.id,
      "mother",
    );
    // A pending invitation for the invited teacher, as the school admin's invite would leave.
    await tx`
      INSERT INTO app.invitations (school_id, email, normalized_email, role, token_hash, expires_at)
      VALUES (${school}, 'new.teacher@gamma.test', 'new.teacher@gamma.test', 'INSTRUCTOR',
              sha256(gen_random_uuid()::text::bytea), CURRENT_TIMESTAMP + INTERVAL '3 days')
    `;
    // A member-ID parent locked out after wrong passwords.
    await tx`
      INSERT INTO app.member_credentials (school_id, user_id, failed_attempts, locked_until)
      VALUES (${school}, ${memberParent.id}, 0, CURRENT_TIMESTAMP + INTERVAL '10 minutes')
    `;
    await tx`UPDATE app.users SET last_login_at = CURRENT_TIMESTAMP WHERE id = ${activeTeacher.id}`;
    // Member-ID accounts have no email address.
    await tx`UPDATE app.users SET email = NULL, normalized_email = NULL WHERE id = ${memberParent.id}`;
  });

  return {
    home,
    school,
    actor: { userId: operator.id, schoolId: home },
    otherOperator: otherOperator.id,
    parent: parentUser.id,
    student: student.userId,
    invitedTeacher: invitedTeacher.id,
    memberParent: memberParent.id,
    activeTeacher: activeTeacher.id,
  };
}

/** The support rows (newest last) in one school, by the action they record. */
async function supportRows(schoolId: string, action: string) {
  return asAdmin(schoolId, async (tx) => {
    return tx<{ actor_id: string | null; new_values: Record<string, unknown> }[]>`
      SELECT actor_id, new_values FROM app.audit_logs
      WHERE target_table = 'users' AND new_values->>'support_action' = ${action}
      ORDER BY created_at
    `;
  });
}

async function userStatus(userId: string) {
  return asAdmin(fixture.school, async (tx) => {
    const [row] = await tx<{ status: string }[]>`
      SELECT status::text AS status FROM app.users WHERE id = ${userId}
    `;
    return row!.status;
  });
}

beforeAll(async () => {
  if (!integrationEnabled) return;
  db = await createTestDatabase();
  await migrateDatabase(db.url);
  fixture = await seed(db.sql);
}, 120_000);

afterAll(async () => {
  if (!integrationEnabled) return;
  await db.cleanup();
});

describe("support panel", () => {
  integrationTest(
    "shows a parent's children by name and audits the read in both schools",
    async () => {
      const panel = await getSupportUser(database(), fixture.school, fixture.parent, fixture.actor);
      expect(panel.school.name).toBe("Gamma School");
      expect(panel.roles).toEqual(["PARENT"]);
      expect(panel.children).toEqual([{ name: "Sami Kid", relationship: "mother" }]);
      expect(panel.parents).toEqual([]);
      expect(panel.actionable).toBe(true);

      const inSchool = await supportRows(fixture.school, "view");
      const atHome = await supportRows(fixture.home, "view");
      expect(inSchool.at(-1)?.actor_id).toBeNull();
      expect(atHome.at(-1)?.actor_id).toBe(fixture.actor.userId);
    },
  );

  integrationTest("shows a student's parents by name", async () => {
    const panel = await getSupportUser(database(), fixture.school, fixture.student, fixture.actor);
    expect(panel.parents).toEqual([{ name: "Mona Parent", relationship: "mother" }]);
  });

  integrationTest("shows a pending invitation and a member lockout", async () => {
    const teacher = await getSupportUser(
      database(),
      fixture.school,
      fixture.invitedTeacher,
      fixture.actor,
    );
    expect(teacher.invitation?.status).toBe("pending");
    expect(teacher.activated).toBe(false);

    const member = await getSupportUser(
      database(),
      fixture.school,
      fixture.memberParent,
      fixture.actor,
    );
    expect(member.signIn.locked).toBe(true);
    expect(member.email).toBeNull();
  });

  integrationTest("another platform administrator is not actionable", async () => {
    const panel = await getSupportUser(
      database(),
      fixture.home,
      fixture.otherOperator,
      fixture.actor,
    );
    expect(panel.actionable).toBe(false);
  });

  integrationTest("a user from another school is not found", async () => {
    await expect(
      getSupportUser(database(), fixture.home, fixture.parent, fixture.actor),
    ).rejects.toMatchObject({ status: 404 });
  });
});

describe("support actions", () => {
  integrationTest("re-sending an invitation reissues it and never returns the token", async () => {
    const result = await resendInvitation(
      deps(),
      fixture.school,
      fixture.invitedTeacher,
      REASON,
      fixture.actor,
    );
    expect(Object.keys(result).sort()).toEqual(["expiresAt", "invitationId"]);

    const invitations = await asAdmin(
      fixture.school,
      (tx) =>
        tx<{ id: string; revoked: boolean }[]>`
        SELECT id, revoked_at IS NOT NULL AS revoked FROM app.invitations
        WHERE normalized_email = 'new.teacher@gamma.test' ORDER BY created_at
      `,
    );
    expect(invitations).toHaveLength(2);
    expect(invitations[0]!.revoked).toBe(true);
    expect(invitations[1]).toEqual({ id: result.invitationId, revoked: false });

    const outbox = await asAdmin(
      fixture.school,
      (tx) =>
        tx<{ count: number }[]>`
        SELECT count(*)::int AS count FROM app.outbox_events WHERE event_name = 'invitation.sent'
      `,
    );
    expect(outbox[0]!.count).toBeGreaterThanOrEqual(1);

    const home = await supportRows(fixture.home, "resend_invitation");
    expect(home.at(-1)?.actor_id).toBe(fixture.actor.userId);
    expect(home.at(-1)?.new_values.reason).toBe(REASON);
    const inSchool = await supportRows(fixture.school, "resend_invitation");
    expect(inSchool.at(-1)?.actor_id).toBeNull();
  });

  integrationTest("an activated account or a member-ID account cannot be re-invited", async () => {
    await expect(
      resendInvitation(deps(), fixture.school, fixture.activeTeacher, REASON, fixture.actor),
    ).rejects.toMatchObject({ status: 409 });
    await expect(
      resendInvitation(deps(), fixture.school, fixture.memberParent, REASON, fixture.actor),
    ).rejects.toMatchObject({ status: 409 });
  });

  integrationTest("signing out everywhere ends every session", async () => {
    await createRefreshSession(db.sql, fixture.school, fixture.activeTeacher);
    await createRefreshSession(db.sql, fixture.school, fixture.activeTeacher, {
      channel: "mobile",
    });

    const result = await signOutEverywhere(
      deps(),
      fixture.school,
      fixture.activeTeacher,
      REASON,
      fixture.actor,
    );
    expect(result.revokedSessions).toBe(2);

    const panel = await getSupportUser(
      database(),
      fixture.school,
      fixture.activeTeacher,
      fixture.actor,
    );
    expect(panel.activeSessions).toBe(0);
    const home = await supportRows(fixture.home, "sign_out_everywhere");
    expect(home.at(-1)?.new_values.revoked_token_count).toBe(2);
  });

  integrationTest("unlocking clears a member lockout, and is idempotent", async () => {
    const first = await unlockAccount(
      deps(),
      fixture.school,
      fixture.memberParent,
      REASON,
      fixture.actor,
    );
    expect(first.wasLocked).toBe(true);
    const second = await unlockAccount(
      deps(),
      fixture.school,
      fixture.memberParent,
      REASON,
      fixture.actor,
    );
    expect(second.wasLocked).toBe(false);
  });

  integrationTest(
    "deactivating suspends and reactivating restores an activated account",
    async () => {
      await createRefreshSession(db.sql, fixture.school, fixture.activeTeacher);
      const off = await deactivateAccount(
        deps(),
        fixture.school,
        fixture.activeTeacher,
        REASON,
        fixture.actor,
      );
      expect(off.status).toBe("suspended");
      expect(off.revokedSessions).toBe(1);
      expect(await userStatus(fixture.activeTeacher)).toBe("suspended");

      await expect(
        deactivateAccount(deps(), fixture.school, fixture.activeTeacher, REASON, fixture.actor),
      ).rejects.toMatchObject({ status: 409 });

      const on = await reactivateAccount(
        deps(),
        fixture.school,
        fixture.activeTeacher,
        REASON,
        fixture.actor,
      );
      expect(on.status).toBe("active");
      expect(await userStatus(fixture.activeTeacher)).toBe("active");
    },
  );

  integrationTest("a never-activated account comes back as invited", async () => {
    await deactivateAccount(deps(), fixture.school, fixture.invitedTeacher, REASON, fixture.actor);
    const on = await reactivateAccount(
      deps(),
      fixture.school,
      fixture.invitedTeacher,
      REASON,
      fixture.actor,
    );
    expect(on.status).toBe("invited");
  });

  integrationTest("another platform administrator's account is refused", async () => {
    for (const run of [unlockAccount, signOutEverywhere, deactivateAccount, resendInvitation]) {
      await expect(
        run(deps(), fixture.home, fixture.otherOperator, REASON, fixture.actor),
      ).rejects.toMatchObject({ status: 403 });
    }
  });

  integrationTest("the operator may act on their own account, but not deactivate it", async () => {
    const result = await unlockAccount(
      deps(),
      fixture.home,
      fixture.actor.userId,
      REASON,
      fixture.actor,
    );
    expect(result.wasLocked).toBe(false);
    await expect(
      deactivateAccount(deps(), fixture.home, fixture.actor.userId, REASON, fixture.actor),
    ).rejects.toMatchObject({ status: 409 });
  });
});
