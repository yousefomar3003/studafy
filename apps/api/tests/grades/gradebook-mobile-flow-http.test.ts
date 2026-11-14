/**
 * The class gradebook as the mobile teacher app drives it (features/teacher/data/grade_entry_client.dart).
 *
 * Full HTTP path, mobile channel, the app's exact request bodies: resolve the class gradebook,
 * read the entry grid, add an assessment, then write a mark with the cell's concurrency token.
 * Saving a mark used to answer 500: its audit row was an "update" with no before-values, which
 * ck_audit_logs_payload rejects (fixed centrally in auditEmitter's auditPayload).
 *
 *   TEST_DATABASE_URL=postgres://... bun test tests/grades/gradebook-mobile-flow-http.test.ts
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
  integrationEnabled,
  migrateDatabase,
} from "../harness";

import type { TestApp, TestDatabase } from "../harness";
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

function request(actor: Actor, method: string, path: string, body?: unknown) {
  return authenticatedRequest(
    harness!,
    method,
    path,
    { channel: "mobile", ...actor },
    body === undefined
      ? undefined
      : { headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) },
  );
}

interface Cell {
  id: string;
  updated_at: string;
  score: number | null;
}

describeDb("mobile teacher gradebook", () => {
  test("resolve, add an assessment and enter a mark", async () => {
    const fixture = await createFullTenant(database!.sql);
    const teacher = fixture.teachers[0]!;
    await assignRole(database!.sql, fixture.schoolId, teacher.userId, ROLES.INSTRUCTOR);
    const actor = { schoolId: fixture.schoolId, userId: teacher.userId, roles: [ROLES.INSTRUCTOR] };

    const resolved = await request(
      actor,
      "GET",
      `/api/grades/gradebooks?classId=${fixture.cls.id}`,
    );
    expect(resolved.status).toBe(200);
    const gradebook = (await resolved.json()) as { id: string };
    expect(gradebook.id).toBeString();

    const entry = await request(actor, "GET", `/api/grades/gradebooks/${gradebook.id}/entry`);
    expect(entry.status).toBe(200);

    const created = await request(
      actor,
      "POST",
      `/api/grades/gradebooks/${gradebook.id}/assessments`,
      { label: "Quiz 1", max_score: 20.0, weight: 1.0 },
    );
    expect(created.status).toBeLessThan(300);
    const grid: unknown = await created.json();

    // Find one grade cell (an object with id, score and updated_at) anywhere in the grid.
    const found: Cell[] = [];
    const walk = (node: unknown) => {
      if (Array.isArray(node)) node.forEach(walk);
      else if (node && typeof node === "object") {
        const record = node as Record<string, unknown>;
        if ("score" in record && "updated_at" in record && typeof record.id === "string") {
          found.push(record as unknown as Cell);
        }
        Object.values(record).forEach(walk);
      }
    };
    walk(grid);
    expect(found.length).toBeGreaterThan(0);

    const updated = await request(actor, "PATCH", `/api/grades/gradebooks/${gradebook.id}/grades`, {
      grades: [{ id: found[0]!.id, score: 17, updated_at: found[0]!.updated_at }],
    });
    expect(updated.status).toBe(200);
    const [cell] = (await updated.json()) as Cell[];
    expect(Number(cell!.score)).toBe(17);

    // The audit row records the score before and after.
    const [audit] = await database!.sql.begin(async (tx) => {
      await tx.unsafe("SET LOCAL ROLE studafy_admin");
      await tx`SELECT set_config('app.school_id', ${fixture.schoolId}, true)`;
      return tx<{ old_values: { scores: Cell[] }; new_values: { scores: Cell[] } }[]>`
        SELECT old_values, new_values FROM app.audit_logs
        WHERE school_id = ${fixture.schoolId}::uuid AND target_table = 'grades' AND action = 'update'
          AND old_values ? 'scores'
        ORDER BY created_at DESC LIMIT 1
      `;
    });
    expect(audit!.old_values.scores[0]!.score).toBeNull();
    expect(Number(audit!.new_values.scores[0]!.score)).toBe(17);
  });
});
