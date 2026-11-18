/**
 * Placing a material in a week and day of its class's term (000226), end to end over HTTP.
 *
 * The mobile app groups a class's materials into week sections with day sub-groups, and the teacher
 * picks both when uploading. The API keeps them optional on create (older app versions in the
 * field upload without them and their materials land under "Unscheduled"), editable as a pair on
 * update, returned on every material, and filterable on the list.
 *
 *   TEST_DATABASE_URL=postgres://... bun test tests/academics/material-week-day-http.test.ts
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

import type { StorageService } from "../../src/lib/storage";
import type { TestApp, TestDatabase, TenantFixture } from "../harness";

const describeDb = integrationEnabled ? describe : describe.skip;

/** Only presign is reached: initiating an upload signs a PUT and never touches the bucket. */
const storage: StorageService = {
  ttlSeconds: 900,
  check: async () => true,
  presign: (key) => ({
    url: `https://storage.example/${key}?signed`,
    expiresAt: new Date(Date.now() + 900_000),
  }),
  exists: async () => false,
  size: async () => 0,
  head: async () => null,
  checksumSha256: async () => "a".repeat(64),
  copy: async () => undefined,
  remove: async () => undefined,
  // eslint-disable-next-line require-yield -- an empty bucket
  async *list() {
    return;
  },
};

let database: TestDatabase | undefined;
let harness: TestApp | undefined;

beforeAll(async () => {
  if (!integrationEnabled) return;
  database = await createTestDatabase();
  await migrateDatabase(database.url);
  const created = createTestApp({
    database: database.sql,
    storage,
    uploadScanEnqueuer: async () => undefined,
  });
  await created.ready;
  harness = created;
}, 60_000);

afterAll(async () => {
  harness?.keyStore.destroy();
  await database?.cleanup();
});

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

interface MaterialBody {
  id: string;
  storage_key: string;
  week_number: number | null;
  day_of_week: number | null;
}

let tenant: TenantFixture;

async function asAdmin<T>(fn: (tx: TestDatabase["sql"]) => Promise<T>) {
  return database!.sql.begin(async (tx) => {
    await tx.unsafe("SET LOCAL ROLE studafy_admin");
    await tx`SELECT set_config('app.school_id', ${tenant.schoolId}, true)`;
    return fn(tx as unknown as TestDatabase["sql"]);
  }) as Promise<T>;
}

function request(method: string, path: string, body?: unknown) {
  return authenticatedRequest(
    harness!,
    method,
    path,
    {
      schoolId: tenant.schoolId,
      userId: tenant.teachers[0]!.userId,
      roles: [ROLES.INSTRUCTOR],
      channel: "mobile",
    },
    body === undefined
      ? undefined
      : { headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) },
  );
}

let fileCounter = 0;

function uploadBody(placement: Record<string, unknown>) {
  fileCounter += 1;
  return {
    class_id: tenant.cls.id,
    title: `Week notes ${fileCounter}`,
    original_file_name: `notes-${fileCounter}.pdf`,
    mime_type: "application/pdf",
    size_bytes: 1_000,
    ...placement,
  };
}

/** Initiates an upload and resolves the created row the way the app does: by its material id. */
async function upload(placement: Record<string, unknown>): Promise<MaterialBody> {
  const res = await request("POST", "/api/academics/materials/upload", uploadBody(placement));
  expect(res.status).toBe(201);
  // The returned storage_key is the temp/ staging key (QA-009); the row is named by material_id.
  const { material_id } = (await res.json()) as { material_id: string };
  const list = await request("GET", `/api/academics/materials?class_id=${tenant.cls.id}&limit=100`);
  const { materials } = (await list.json()) as { materials: MaterialBody[] };
  const material = materials.find((m) => m.id === material_id);
  expect(material).toBeDefined();
  return material!;
}

async function listIds(query: string): Promise<string[]> {
  const res = await request("GET", `/api/academics/materials?class_id=${tenant.cls.id}&${query}`);
  expect(res.status).toBe(200);
  const { materials, total } = (await res.json()) as { materials: MaterialBody[]; total: number };
  expect(total).toBe(materials.length);
  return materials.map((m) => m.id).sort();
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describeDb("material week and day placement", () => {
  beforeAll(async () => {
    tenant = await createFullTenant(database!.sql);
    await assignRole(database!.sql, tenant.schoolId, tenant.teachers[0]!.userId, ROLES.INSTRUCTOR);
  });

  test("an upload with a week and day returns them on the material", async () => {
    const material = await upload({ week_number: 3, day_of_week: 2 });
    expect(material.week_number).toBe(3);
    expect(material.day_of_week).toBe(2);

    const res = await request("GET", `/api/academics/materials/${material.id}`);
    expect(res.status).toBe(200);
    const fetched = (await res.json()) as MaterialBody;
    expect(fetched.week_number).toBe(3);
    expect(fetched.day_of_week).toBe(2);
  });

  test("an upload without them (an older app) is accepted as unscheduled", async () => {
    const material = await upload({});
    expect(material.week_number).toBeNull();
    expect(material.day_of_week).toBeNull();
  });

  test("an upload with only one of the pair is refused", async () => {
    for (const placement of [{ week_number: 2 }, { day_of_week: 4 }]) {
      const res = await request("POST", "/api/academics/materials/upload", uploadBody(placement));
      expect(res.status).toBe(400);
    }
  });

  test("week and day outside their ranges are refused", async () => {
    for (const placement of [
      { week_number: 0, day_of_week: 1 },
      { week_number: 61, day_of_week: 1 },
      { week_number: 1, day_of_week: 0 },
      { week_number: 1, day_of_week: 8 },
      { week_number: 1.5, day_of_week: 1 },
      { week_number: null, day_of_week: null },
    ]) {
      const res = await request("POST", "/api/academics/materials/upload", uploadBody(placement));
      expect(res.status).toBe(400);
    }
    // The bounds themselves are fine.
    const material = await upload({ week_number: 60, day_of_week: 7 });
    expect(material.week_number).toBe(60);
    expect(material.day_of_week).toBe(7);
  });

  test("the database keeps the pair together and in range", async () => {
    const material = await upload({ week_number: 1, day_of_week: 1 });
    const attempts = [
      { week: null, day: 1 },
      { week: 1, day: null },
      { week: 0, day: 1 },
      { week: 61, day: 1 },
      { week: 1, day: 8 },
    ];
    for (const { week, day } of attempts) {
      const code = await asAdmin(
        (tx) => tx`
          UPDATE app.materials SET week_number = ${week}, day_of_week = ${day}
          WHERE id = ${material.id}
        `,
      ).then(
        () => null,
        (error: { code?: string }) => error.code,
      );
      expect(code).toBe("23514");
    }
  });

  test("an update moves a material, clears it, and leaves it alone when omitted", async () => {
    const material = await upload({ week_number: 2, day_of_week: 3 });
    const path = `/api/academics/materials/${material.id}`;

    const moved = await request("PATCH", path, { week_number: 5, day_of_week: 1 });
    expect(moved.status).toBe(200);
    expect((await moved.json()) as MaterialBody).toMatchObject({ week_number: 5, day_of_week: 1 });

    // A title-only edit keeps the placement.
    const renamed = await request("PATCH", path, { title: "Renamed" });
    expect(renamed.status).toBe(200);
    expect((await renamed.json()) as MaterialBody).toMatchObject({
      week_number: 5,
      day_of_week: 1,
    });

    const cleared = await request("PATCH", path, { week_number: null, day_of_week: null });
    expect(cleared.status).toBe(200);
    expect((await cleared.json()) as MaterialBody).toMatchObject({
      week_number: null,
      day_of_week: null,
    });

    // And back into a week from unscheduled.
    const placed = await request("PATCH", path, { week_number: 9, day_of_week: 6 });
    expect(placed.status).toBe(200);
    expect((await placed.json()) as MaterialBody).toMatchObject({ week_number: 9, day_of_week: 6 });
  });

  test("an update that half-changes the pair or leaves the ranges is refused", async () => {
    const material = await upload({ week_number: 4, day_of_week: 4 });
    const path = `/api/academics/materials/${material.id}`;
    for (const body of [
      { week_number: 5 },
      { day_of_week: 2 },
      { week_number: null },
      { week_number: null, day_of_week: 2 },
      { week_number: 3, day_of_week: null },
      { week_number: 0, day_of_week: 2 },
      { week_number: 61, day_of_week: 2 },
      { week_number: 3, day_of_week: 8 },
    ]) {
      const res = await request("PATCH", path, body);
      expect(res.status).toBe(400);
    }
    const res = await request("GET", path);
    expect((await res.json()) as MaterialBody).toMatchObject({ week_number: 4, day_of_week: 4 });
  });

  test("the list filters by week and by day", async () => {
    // A class of its own, so materials from the tests above don't leak into the counts.
    tenant = await createFullTenant(database!.sql);
    await assignRole(database!.sql, tenant.schoolId, tenant.teachers[0]!.userId, ROLES.INSTRUCTOR);

    const w1Mon = await upload({ week_number: 1, day_of_week: 1 });
    const w1Wed = await upload({ week_number: 1, day_of_week: 3 });
    const w2Mon = await upload({ week_number: 2, day_of_week: 1 });
    await upload({});

    expect(await listIds("week_number=1")).toEqual([w1Mon.id, w1Wed.id].sort());
    expect(await listIds("day_of_week=1")).toEqual([w1Mon.id, w2Mon.id].sort());
    expect(await listIds("week_number=1&day_of_week=3")).toEqual([w1Wed.id]);
    expect(await listIds("week_number=7")).toEqual([]);

    for (const query of ["week_number=0", "week_number=61", "day_of_week=8", "week_number=x"]) {
      const res = await request("GET", `/api/academics/materials?${query}`);
      expect(res.status).toBe(400);
    }
  });
});
