/**
 * Integration test: runTenantExport against a real, disposable school fixture, with an in-memory
 * fake S3 (no AWS dependency, same shape report-runner.test.ts's fakes use). Skipped without
 * TEST_DATABASE_URL.
 */
// eslint-disable-next-line import-x/no-unresolved -- "bun:test" is a virtual Bun built-in
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import postgres from "postgres";

import { runTenantExport } from "./tenant-export.worker";

import type { MaintenanceS3Client } from "./tenant-export.worker";
import type { Sql } from "postgres";

const databaseUrl = process.env.TEST_DATABASE_URL;
const enabled = Boolean(databaseUrl);
const dbTest = test.skipIf(!enabled);

let sql: Sql | undefined;
let schoolId: string;
let userId: string;

function createFakeS3(): MaintenanceS3Client & { objects: Map<string, Uint8Array> } {
  const objects = new Map<string, Uint8Array>();
  return {
    objects,
    async put(key, body) {
      objects.set(key, body);
    },
  };
}

beforeAll(async () => {
  if (!enabled) return;
  sql = postgres(databaseUrl!, { max: 1, ssl: false, prepare: false });
  const [country] = await sql<{ id: string }[]>`SELECT id FROM app.countries LIMIT 1`;
  const [currency] = await sql<{ id: string }[]>`SELECT id FROM app.currencies LIMIT 1`;
  const slug = "dsr-export-test-" + crypto.randomUUID().slice(0, 8);
  const [school] = await sql<{ id: string }[]>`
    INSERT INTO app.schools (slug, name, status, country_id, default_currency_id, email, normalized_email)
    VALUES (
      ${slug}, 'DSR Export Fixture', 'active', ${country!.id}, ${currency!.id},
      ${slug + "@example.com"}, ${slug + "@example.com"}
    )
    RETURNING id
  `;
  schoolId = school!.id;
  await sql`SELECT set_config('app.school_id', ${schoolId}, false)`;

  const [admin] = await sql<{ id: string }[]>`
    INSERT INTO app.users (school_id, email, normalized_email, display_name, status)
    VALUES (${schoolId}::uuid, 'org-admin@example.com', 'org-admin@example.com', 'Org Admin', 'active')
    RETURNING id
  `;
  await sql`INSERT INTO app.user_roles (school_id, user_id, role) VALUES (${schoolId}::uuid, ${admin!.id}::uuid, 'ORG_ADMIN')`;

  const [subject] = await sql<{ id: string }[]>`
    INSERT INTO app.users (school_id, email, normalized_email, display_name, status)
    VALUES (${schoolId}::uuid, 'export-me@example.com', 'export-me@example.com', 'Export Me', 'active')
    RETURNING id
  `;
  userId = subject!.id;
  await sql`
    INSERT INTO app.students (school_id, user_id, admission_number, first_name, last_name, status)
    VALUES (${schoolId}::uuid, ${userId}::uuid, 'ADM-200', 'Export', 'Me', 'enrolled')
  `;
});

afterAll(async () => {
  if (!enabled) return;
  await sql!`DELETE FROM app.students WHERE school_id = ${schoolId}::uuid`;
  await sql!`DELETE FROM app.notification_preferences WHERE school_id = ${schoolId}::uuid`;
  await sql!`DELETE FROM app.user_roles WHERE school_id = ${schoolId}::uuid`;
  await sql!`DELETE FROM app.users WHERE school_id = ${schoolId}::uuid`;
  await sql!`DELETE FROM app.schools WHERE id = ${schoolId}::uuid`;
  await sql?.end({ timeout: 5 });
});

describe("runTenantExport", () => {
  dbTest(
    "tenant-wide export produces a schema-verified manifest covering the fixture rows",
    async () => {
      const s3 = createFakeS3();
      const requestId = crypto.randomUUID();

      const result = await sql!.begin((tx) =>
        runTenantExport(tx, {
          s3,
          requestId,
          schoolId,
          subjectScope: "tenant",
          subjectUserId: null,
          now: new Date("2026-09-09T12:00:00.000Z"),
        }),
      );

      expect(result.manifest.schemaVersion).toBe(1);
      expect(result.manifest.subjectScope).toBe("tenant");

      const usersEntry = result.manifest.tables.find((entry) => entry.table === "users");
      expect(usersEntry?.rowCount).toBe(2);
      expect(s3.objects.has(usersEntry!.storageKey)).toBe(true);

      // The bundle includes the school's own financial/legal-hold tables too -- export is not erasure.
      expect(result.manifest.retainedTables).toEqual([]);

      expect(s3.objects.has(result.manifestKey)).toBe(true);
      const uploaded = JSON.parse(new TextDecoder().decode(s3.objects.get(result.manifestKey)));
      expect(uploaded.requestId).toBe(requestId);
    },
  );

  dbTest("per-user export narrows to only that subject's rows", async () => {
    const s3 = createFakeS3();
    const result = await sql!.begin((tx) =>
      runTenantExport(tx, {
        s3,
        requestId: crypto.randomUUID(),
        schoolId,
        subjectScope: "user",
        subjectUserId: userId,
        now: new Date(),
      }),
    );

    const usersEntry = result.manifest.tables.find((entry) => entry.table === "users");
    expect(usersEntry?.rowCount).toBe(1);
    const usersObject = s3.objects.get(usersEntry!.storageKey)!;
    const row = JSON.parse(new TextDecoder().decode(usersObject));
    expect(row.id).toBe(userId);

    // A table with no subject-link column at all (e.g. app.classes) contributes nothing.
    expect(result.manifest.tables.some((entry) => entry.table === "classes")).toBe(false);
  });
});
