/**
 * Custom lists (docs/modules/custom-lists.md, 000182) over HTTP against a real database: who may
 * shape and use a list (its audience, enforced by RLS as much as by the API), typed columns and
 * cells, sensitive cells (masked, encrypted at rest, audited reveal, never searched or exported),
 * links to a student / parent / member of staff / class, the table's search, filter and sort, CSV
 * export, a subject's linked rows, global search by list name only, the caps, and creating a list
 * from an unrecognised sheet -- linked by school-issued key only, exact match, previewed first.
 * Requires a live PostgreSQL instance, gated on TEST_DATABASE_URL.
 *
 *   TEST_DATABASE_URL=postgres://... bun test tests/custom-lists/custom-lists-http.test.ts
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

// ---------------------------------------------------------------------------
// World
// ---------------------------------------------------------------------------

interface Actor {
  schoolId: string;
  userId: string;
  roles: Role[];
  channel: "web";
}

interface World {
  fixture: TenantFixture;
  schoolId: string;
  studentId: string;
  classId: string;
  admin: Actor;
  principal: Actor;
  finance: Actor;
  teacher: Actor;
  parent: Actor;
}

const LOCKER_CODE = "A1234567890";

function actor(schoolId: string, userId: string, role: Role): Actor {
  return { schoolId, userId, roles: [role], channel: "web" };
}

async function newUser(schoolId: string, role: Role, name: string) {
  const user = await createUser(database!.sql, schoolId, {
    email: `${role.toLowerCase()}-${crypto.randomUUID().slice(0, 8)}@test.local`,
    displayName: name,
  });
  await assignRole(database!.sql, schoolId, user.id, role);
  return user;
}

async function world(): Promise<World> {
  const fixture = await createFullTenant(database!.sql);
  const schoolId = fixture.schoolId;
  const principal = await newUser(schoolId, ROLES.PRINCIPAL, "Head Teacher");
  const finance = await newUser(schoolId, ROLES.FINANCE, "Bursar");
  const parent = await newUser(schoolId, ROLES.PARENT, "Rana Haddad");
  await assignRole(database!.sql, schoolId, fixture.teachers[0]!.userId, ROLES.INSTRUCTOR);
  return {
    fixture,
    schoolId,
    studentId: fixture.students[0]!.id,
    classId: fixture.cls.id,
    admin: actor(schoolId, fixture.users.ORG_ADMIN.id, ROLES.ORG_ADMIN),
    principal: actor(schoolId, principal.id, ROLES.PRINCIPAL),
    finance: actor(schoolId, finance.id, ROLES.FINANCE),
    teacher: actor(schoolId, fixture.teachers[0]!.userId, ROLES.INSTRUCTOR),
    parent: actor(schoolId, parent.id, ROLES.PARENT),
  };
}

function call(who: Actor, method: string, path: string, body?: unknown) {
  return authenticatedRequest(harness!, method, path, who, {
    headers: { "Content-Type": "application/json" },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
}

async function json<T = Record<string, unknown>>(response: Response): Promise<T> {
  return (await response.json()) as T;
}

interface ColumnDto {
  id: string;
  label_en: string;
  field_type: string;
  sensitivity: string;
  archived: boolean;
}

interface ListDto {
  id: string;
  name_en: string;
  audience: string;
  archived: boolean;
  row_count: number;
  can_manage: boolean;
  columns: ColumnDto[];
}

interface CellDto {
  column_id: string;
  value: unknown;
  masked: boolean;
  mask: string | null;
}

interface RowDto {
  id: string;
  link: { kind: string; id: string; name: string | null } | null;
  cells: CellDto[];
}

const NO_LINKS = { student: false, parent: false, staff: false, class: false };

async function createList(
  who: Actor,
  body: Record<string, unknown> & { name_en: string },
): Promise<ListDto> {
  const response = await call(who, "POST", "/api/custom-lists", {
    name_ar: "قائمة",
    audience: "admins",
    links: NO_LINKS,
    ...body,
  });
  expect(response.status).toBe(201);
  return json<ListDto>(response);
}

/** Lockers: number, size (choice), checked (yes/no), issued on (date), code (sensitive). */
async function lockersList(w: World, who: Actor = w.admin, audience = "leadership") {
  const list = await createList(who, {
    name_en: `Lockers ${crypto.randomUUID().slice(0, 6)}`,
    audience,
    links: { student: true, parent: false, staff: true, class: false },
    columns: [
      { field_type: "number", label_en: "Locker number", label_ar: "رقم الخزانة", required: true },
      {
        field_type: "single_choice",
        label_en: "Size",
        label_ar: "الحجم",
        options: [
          { value: "small", label_en: "Small", label_ar: "صغير" },
          { value: "large", label_en: "Large", label_ar: "كبير" },
        ],
      },
      {
        field_type: "multi_choice",
        label_en: "Extras",
        label_ar: "إضافات",
        options: [
          { value: "hook", label_en: "Hook", label_ar: "علاقة" },
          { value: "shelf", label_en: "Shelf", label_ar: "رف" },
        ],
      },
      { field_type: "yes_no", label_en: "Checked", label_ar: "تم الفحص" },
      { field_type: "date", label_en: "Issued on", label_ar: "تاريخ الإصدار" },
      { field_type: "short_text", label_en: "Notes", label_ar: "ملاحظات" },
      {
        field_type: "short_text",
        label_en: "Padlock code",
        label_ar: "رمز القفل",
        sensitivity: "sensitive",
      },
    ],
  });
  const byLabel = Object.fromEntries(list.columns.map((column) => [column.label_en, column.id]));
  return { list, col: byLabel as Record<string, string> };
}

async function addRow(who: Actor, listId: string, body: Record<string, unknown>) {
  return call(who, "POST", `/api/custom-lists/${listId}/rows`, body);
}

function cell(row: RowDto, columnId: string): CellDto | undefined {
  return row.cells.find((candidate) => candidate.column_id === columnId);
}

// ---------------------------------------------------------------------------
// Audience and permissions
// ---------------------------------------------------------------------------

describeDb("custom lists: audience and permissions", () => {
  test("each list exists only for its audience; families never see lists", async () => {
    const w = await world();
    const adminOnly = await createList(w.admin, { name_en: "Payroll notes", audience: "admins" });
    const leadership = await createList(w.admin, { name_en: "Visitors", audience: "leadership" });
    const staff = await createList(w.admin, { name_en: "Duty rota", audience: "staff" });

    const names = async (who: Actor) => {
      const response = await call(who, "GET", "/api/custom-lists");
      expect(response.status).toBe(200);
      return (await json<{ lists: ListDto[] }>(response)).lists.map((list) => list.name_en).sort();
    };
    expect(await names(w.admin)).toEqual(["Duty rota", "Payroll notes", "Visitors"]);
    expect(await names(w.principal)).toEqual(["Duty rota", "Visitors"]);
    expect(await names(w.teacher)).toEqual(["Duty rota"]);
    expect(await names(w.finance)).toEqual(["Duty rota"]);

    // Outside the audience is not found -- never forbidden, so ids cannot be probed.
    expect((await call(w.principal, "GET", `/api/custom-lists/${adminOnly.id}`)).status).toBe(404);
    expect((await call(w.teacher, "GET", `/api/custom-lists/${leadership.id}/rows`)).status).toBe(
      404,
    );
    expect((await call(w.teacher, "GET", `/api/custom-lists/${staff.id}/rows`)).status).toBe(200);

    expect((await call(w.parent, "GET", "/api/custom-lists")).status).toBe(403);
    expect((await call(w.parent, "GET", `/api/custom-lists/${staff.id}`)).status).toBe(403);

    const otherSchool = await world();
    expect((await call(otherSchool.admin, "GET", `/api/custom-lists/${staff.id}`)).status).toBe(
      404,
    );
  }, 60_000);

  test("leadership shapes lists; a manager cannot pick an audience that hides the list from them", async () => {
    const w = await world();
    const teacherCreate = await call(w.teacher, "POST", "/api/custom-lists", {
      name_en: "Teacher list",
      name_ar: "قائمة",
      audience: "staff",
      links: NO_LINKS,
    });
    expect(teacherCreate.status).toBe(403);

    const hidden = await call(w.principal, "POST", "/api/custom-lists", {
      name_en: "Admins only",
      name_ar: "قائمة",
      audience: "admins",
      links: NO_LINKS,
    });
    expect(hidden.status).toBe(422);
    expect((await json(hidden)).code).toBe("CUSTOM_LIST_INVALID");

    const list = await createList(w.principal, {
      name_en: "Clinic visits",
      audience: "leadership",
    });
    expect(list.can_manage).toBe(true);
    const duplicate = await call(w.admin, "POST", "/api/custom-lists", {
      name_en: "clinic VISITS",
      name_ar: "قائمة",
      audience: "admins",
      links: NO_LINKS,
    });
    expect(duplicate.status).toBe(409);
    expect((await json(duplicate)).code).toBe("CUSTOM_LIST_NAME_TAKEN");

    // A teacher may use an all-staff list but not change its columns.
    const staff = await createList(w.admin, { name_en: "Lost property", audience: "staff" });
    const addColumn = await call(w.teacher, "POST", `/api/custom-lists/${staff.id}/columns`, {
      field_type: "short_text",
      label_en: "Item",
      label_ar: "الغرض",
    });
    expect(addColumn.status).toBe(403);
  }, 60_000);
});

// ---------------------------------------------------------------------------
// Columns
// ---------------------------------------------------------------------------

describeDb("custom lists: columns", () => {
  test("typed columns: choices need options, archive keeps values, order and caps hold", async () => {
    const w = await world();
    const { list, col } = await lockersList(w);
    const badChoice = await call(w.admin, "POST", `/api/custom-lists/${list.id}/columns`, {
      field_type: "single_choice",
      label_en: "Colour",
      label_ar: "اللون",
    });
    expect(badChoice.status).toBe(422);
    const documentColumn = await call(w.admin, "POST", `/api/custom-lists/${list.id}/columns`, {
      field_type: "document",
      label_en: "Scan",
      label_ar: "مسح",
    });
    expect(documentColumn.status).toBe(400);

    const row = await addRow(w.admin, list.id, {
      values: [
        { column_id: col["Locker number"], value: 12 },
        { column_id: col.Size, value: "small" },
      ],
    });
    expect(row.status).toBe(201);

    // A used choice cannot be removed, only relabelled.
    const removeUsed = await call(
      w.admin,
      "PATCH",
      `/api/custom-lists/${list.id}/columns/${col.Size}`,
      {
        options: [{ value: "large", label_en: "Large", label_ar: "كبير" }],
      },
    );
    expect(removeUsed.status).toBe(422);
    const relabel = await call(
      w.admin,
      "PATCH",
      `/api/custom-lists/${list.id}/columns/${col.Size}`,
      {
        options: [
          { value: "small", label_en: "Compact", label_ar: "صغير" },
          { value: "large", label_en: "Large", label_ar: "كبير" },
          { value: "xl", label_en: "Extra large", label_ar: "كبير جدا" },
        ],
      },
    );
    expect(relabel.status).toBe(200);

    const archived = await call(
      w.admin,
      "PATCH",
      `/api/custom-lists/${list.id}/columns/${col.Size}`,
      {
        archived: true,
      },
    );
    expect(archived.status).toBe(200);
    const page = await json<{ rows: RowDto[] }>(
      await call(w.admin, "GET", `/api/custom-lists/${list.id}/rows`),
    );
    expect(cell(page.rows[0]!, col.Size!)).toBeUndefined();
    await call(w.admin, "PATCH", `/api/custom-lists/${list.id}/columns/${col.Size}`, {
      archived: false,
    });
    const restored = await json<{ rows: RowDto[] }>(
      await call(w.admin, "GET", `/api/custom-lists/${list.id}/rows`),
    );
    expect(cell(restored.rows[0]!, col.Size!)?.value).toBe("small");

    const reversed = [...list.columns.map((column) => column.id)].reverse();
    const reorder = await call(w.admin, "PUT", `/api/custom-lists/${list.id}/column-order`, {
      column_ids: reversed,
    });
    expect(reorder.status).toBe(200);
    expect((await json<ListDto>(reorder)).columns.map((column) => column.id)).toEqual(reversed);
    const partial = await call(w.admin, "PUT", `/api/custom-lists/${list.id}/column-order`, {
      column_ids: reversed.slice(1),
    });
    expect(partial.status).toBe(422);

    // 7 columns now; 23 more fill the cap of 30, and the 31st is refused.
    for (let index = 0; index < 23; index += 1) {
      const added = await call(w.admin, "POST", `/api/custom-lists/${list.id}/columns`, {
        field_type: "short_text",
        label_en: `Extra ${index}`,
        label_ar: `إضافي ${index}`,
      });
      expect(added.status).toBe(201);
    }
    const overCap = await call(w.admin, "POST", `/api/custom-lists/${list.id}/columns`, {
      field_type: "short_text",
      label_en: "One too many",
      label_ar: "زائد",
    });
    expect(overCap.status).toBe(409);
    expect((await json(overCap)).code).toBe("CUSTOM_LIST_LIMIT_REACHED");
  }, 60_000);
});

// ---------------------------------------------------------------------------
// Rows and cells
// ---------------------------------------------------------------------------

describeDb("custom lists: rows, links and sensitive cells", () => {
  test("typed cells round-trip; a sensitive cell is sealed, masked and revealed only with an audit", async () => {
    const w = await world();
    const { list, col } = await lockersList(w);
    const created = await addRow(w.principal, list.id, {
      link: { kind: "student", id: w.studentId },
      values: [
        { column_id: col["Locker number"], value: 42 },
        { column_id: col.Size, value: "Large" },
        { column_id: col.Extras, value: ["shelf", "hook"] },
        { column_id: col.Checked, value: "yes" },
        { column_id: col["Issued on"], value: "2026-09-01" },
        { column_id: col["Padlock code"], value: LOCKER_CODE },
      ],
    });
    expect(created.status).toBe(201);
    const row = await json<RowDto>(created);
    expect(row.link).toMatchObject({
      kind: "student",
      id: w.studentId,
      name: "Primary TestStudent",
    });
    expect(cell(row, col["Locker number"]!)?.value).toBe(42);
    expect(cell(row, col.Size!)?.value).toBe("large");
    // In the column's own option order.
    expect(cell(row, col.Extras!)?.value).toEqual(["hook", "shelf"]);
    expect(cell(row, col.Checked!)?.value).toBe(true);
    expect(String(cell(row, col["Issued on"]!)?.value).slice(0, 10)).toBe("2026-09-01");
    expect(cell(row, col["Padlock code"]!)).toMatchObject({
      value: null,
      masked: true,
      mask: "•••• 7890",
    });
    expect(JSON.stringify(row)).not.toContain(LOCKER_CODE);

    // At rest: ciphertext and mask only.
    const stored = await database!.sql<
      { value_text: string | null; value_ciphertext: Buffer | null; value_mask: string | null }[]
    >`
      SELECT value_text, value_ciphertext, value_mask FROM app.custom_list_values
      WHERE row_id = ${row.id}::uuid AND column_id = ${col["Padlock code"]!}::uuid
    `;
    expect(stored).toHaveLength(1);
    expect(stored[0]!.value_text).toBeNull();
    expect(Buffer.from(stored[0]!.value_ciphertext!).toString("utf8")).not.toContain(LOCKER_CODE);
    const options = await database!.sql`
      SELECT 1 FROM app.custom_list_values
      WHERE row_id = ${row.id}::uuid AND column_id = ${col.Extras!}::uuid
    `;
    expect(options).toHaveLength(2);

    const revealPath = `/api/custom-lists/${list.id}/rows/${row.id}/cells/${col["Padlock code"]}/reveal`;
    const revealed = await call(w.principal, "POST", revealPath);
    expect(revealed.status).toBe(200);
    expect((await json(revealed)).value).toBe(LOCKER_CODE);
    const audits = await database!.sql<{ new_values: Record<string, unknown> }[]>`
      SELECT new_values FROM app.audit_logs
      WHERE school_id = ${w.schoolId}::uuid AND target_table = 'custom_list_values'
        AND action = 'read' AND target_id = ${row.id}::uuid
    `;
    expect(audits).toHaveLength(1);
    expect(audits[0]!.new_values).toMatchObject({ column_id: col["Padlock code"], reveal: true });
    expect(JSON.stringify(audits[0]!.new_values)).not.toContain(LOCKER_CODE);
    // No audit row anywhere holds the sensitive value.
    const leaked = await database!.sql`
      SELECT 1 FROM app.audit_logs
      WHERE school_id = ${w.schoolId}::uuid
        AND (coalesce(new_values::text, '') LIKE ${`%${LOCKER_CODE}%`}
          OR coalesce(old_values::text, '') LIKE ${`%${LOCKER_CODE}%`})
    `;
    expect(leaked).toHaveLength(0);

    const notSensitive = await call(
      w.admin,
      "POST",
      `/api/custom-lists/${list.id}/rows/${row.id}/cells/${col.Notes}/reveal`,
    );
    expect(notSensitive.status).toBe(409);

    // A teacher on an all-staff list sees the mask and may not reveal.
    const staffList = await lockersList(w, w.admin, "staff");
    const staffRow = await json<RowDto>(
      await addRow(w.admin, staffList.list.id, {
        values: [
          { column_id: staffList.col["Locker number"], value: 7 },
          { column_id: staffList.col["Padlock code"], value: LOCKER_CODE },
        ],
      }),
    );
    const teacherPage = await json<{ rows: RowDto[] }>(
      await call(w.teacher, "GET", `/api/custom-lists/${staffList.list.id}/rows`),
    );
    expect(cell(teacherPage.rows[0]!, staffList.col["Padlock code"]!)?.masked).toBe(true);
    const teacherReveal = await call(
      w.teacher,
      "POST",
      `/api/custom-lists/${staffList.list.id}/rows/${staffRow.id}/cells/${staffList.col["Padlock code"]}/reveal`,
    );
    expect(teacherReveal.status).toBe(403);
  }, 60_000);

  test("links follow the list's link kinds and the subject's role; required cells are enforced", async () => {
    const w = await world();
    const { list, col } = await lockersList(w);
    const number = { column_id: col["Locker number"], value: 1 };

    const missingRequired = await addRow(w.admin, list.id, { values: [] });
    expect(missingRequired.status).toBe(422);
    expect((await json(missingRequired)).code).toBe("RECORD_VALUE_INVALID");

    const classLink = await addRow(w.admin, list.id, {
      link: { kind: "class", id: w.classId },
      values: [number],
    });
    expect(classLink.status).toBe(422);
    expect((await json(classLink)).code).toBe("CUSTOM_LIST_LINK_INVALID");

    // A parent is not a member of staff.
    const parentAsStaff = await addRow(w.admin, list.id, {
      link: { kind: "staff", id: w.parent.userId },
      values: [number],
    });
    expect(parentAsStaff.status).toBe(422);

    const staffLink = await addRow(w.admin, list.id, {
      link: { kind: "staff", id: w.teacher.userId },
      values: [number],
    });
    expect(staffLink.status).toBe(201);

    const badValue = await addRow(w.admin, list.id, {
      values: [{ column_id: col["Locker number"], value: "twelve" }],
    });
    expect(badValue.status).toBe(422);
    expect(JSON.stringify(await json(badValue))).not.toContain("twelve");

    // Turning off a link kind rows use is refused; editing a row can drop the link.
    const narrow = await call(w.admin, "PATCH", `/api/custom-lists/${list.id}`, {
      links: { student: true, parent: false, staff: false, class: false },
    });
    expect(narrow.status).toBe(422);
    const row = await json<RowDto>(staffLink);
    const unlinked = await call(w.admin, "PATCH", `/api/custom-lists/${list.id}/rows/${row.id}`, {
      link: null,
      values: [{ column_id: col.Notes, value: "Moved to block B" }],
    });
    expect(unlinked.status).toBe(200);
    const after = await json<RowDto>(unlinked);
    expect(after.link).toBeNull();
    expect(cell(after, col.Notes!)?.value).toBe("Moved to block B");
    expect(cell(after, col["Locker number"]!)?.value).toBe(1);

    const cleared = await call(w.admin, "PATCH", `/api/custom-lists/${list.id}/rows/${row.id}`, {
      values: [{ column_id: col.Notes, value: null }],
    });
    expect(cell(await json<RowDto>(cleared), col.Notes!)).toBeUndefined();
    const requiredCleared = await call(
      w.admin,
      "PATCH",
      `/api/custom-lists/${list.id}/rows/${row.id}`,
      {
        values: [{ column_id: col["Locker number"], value: null }],
      },
    );
    expect(requiredCleared.status).toBe(422);

    expect(
      (await call(w.admin, "DELETE", `/api/custom-lists/${list.id}/rows/${row.id}`)).status,
    ).toBe(204);
    expect(
      (await call(w.admin, "PATCH", `/api/custom-lists/${list.id}/rows/${row.id}`, { values: [] }))
        .status,
    ).toBe(404);
  }, 60_000);
});

describeDb("custom lists: the link picker", () => {
  test("offers only subjects of an allowed kind, holding the right role, the caller can see", async () => {
    const w = await world();
    const { list } = await lockersList(w);
    const pick = async (who: Actor, kind: string, q: string) => {
      const response = await call(
        who,
        "GET",
        `/api/custom-lists/${list.id}/link-candidates?kind=${kind}&q=${encodeURIComponent(q)}`,
      );
      return {
        status: response.status,
        body:
          response.status === 200
            ? await json<{ candidates: { id: string; name: string; detail: string | null }[] }>(
                response,
              )
            : null,
      };
    };
    const student = await pick(w.admin, "student", "TestStud");
    expect(student.status).toBe(200);
    expect(student.body!.candidates).toEqual([
      {
        id: w.studentId,
        name: "Primary TestStudent",
        detail: w.fixture.students[0]!.admissionNumber,
      },
    ]);
    const byAdmission = await pick(w.admin, "student", w.fixture.students[0]!.admissionNumber);
    expect(byAdmission.body!.candidates.map((candidate) => candidate.id)).toEqual([w.studentId]);

    // "Staff" never offers a parent, and the parent's name finds nobody there.
    const staff = await pick(w.admin, "staff", "Rana");
    expect(staff.body!.candidates).toEqual([]);
    const teacher = await pick(w.admin, "staff", w.fixture.teachers[0]!.employeeNumber);
    expect(teacher.body!.candidates).toEqual([
      expect.objectContaining({
        id: w.teacher.userId,
        detail: w.fixture.teachers[0]!.employeeNumber,
      }),
    ]);

    // The list allows no parent or class links.
    expect((await pick(w.admin, "parent", "Rana")).status).toBe(422);
    expect((await pick(w.admin, "class", "CLS")).status).toBe(422);
    // A one-letter search is refused before any SQL.
    expect((await pick(w.admin, "student", "P")).status).toBe(400);

    const parents = await createList(w.admin, {
      name_en: "Volunteers",
      audience: "staff",
      links: { student: true, parent: true, staff: false, class: true },
    });
    const parentPick = await call(
      w.admin,
      "GET",
      `/api/custom-lists/${parents.id}/link-candidates?kind=parent&q=Rana`,
    );
    const parentHits = (await json<{ candidates: { id: string }[] }>(parentPick)).candidates;
    expect(parentHits.map((candidate) => candidate.id)).toEqual([w.parent.userId]);
    const classPick = await call(
      w.admin,
      "GET",
      `/api/custom-lists/${parents.id}/link-candidates?kind=class&q=${w.fixture.cls.code}`,
    );
    expect(
      (await json<{ candidates: { id: string }[] }>(classPick)).candidates.map((c) => c.id),
    ).toEqual([w.classId]);

    // A teacher with access to the all-staff list finds only students they can see.
    const outsider = await call(
      w.teacher,
      "GET",
      `/api/custom-lists/${parents.id}/link-candidates?kind=student&q=TestStud`,
    );
    expect(outsider.status).toBe(200);
    // Outside the list's audience the list does not exist.
    expect((await pick(w.teacher, "student", "TestStud")).status).toBe(404);
  }, 60_000);
});

// ---------------------------------------------------------------------------
// Table, export, linked rows, search
// ---------------------------------------------------------------------------

describeDb("custom lists: table, export, linked rows and search", () => {
  test("search, filter and sort never touch a sensitive cell", async () => {
    const w = await world();
    const { list, col } = await lockersList(w);
    const rows: [number, string, string | null][] = [
      [3, "small", "Near the gym"],
      [11, "large", null],
      [7, "large", "Broken hinge"],
    ];
    for (const [number, size, notes] of rows) {
      const response = await addRow(w.admin, list.id, {
        ...(number === 3 ? { link: { kind: "student", id: w.studentId } } : {}),
        values: [
          { column_id: col["Locker number"], value: number },
          { column_id: col.Size, value: size },
          { column_id: col["Padlock code"], value: `${LOCKER_CODE}${number}` },
          ...(notes ? [{ column_id: col.Notes, value: notes }] : []),
        ],
      });
      expect(response.status).toBe(201);
    }
    const numbers = async (query: string) => {
      const response = await call(w.admin, "GET", `/api/custom-lists/${list.id}/rows?${query}`);
      expect(response.status).toBe(200);
      const page = await json<{ rows: RowDto[]; total: number }>(response);
      return page.rows.map((row) => cell(row, col["Locker number"]!)?.value);
    };
    expect(await numbers(`sort=${col["Locker number"]}&order=desc`)).toEqual([11, 7, 3]);
    expect(await numbers("q=hinge")).toEqual([7]);
    // A choice by its label, a linked student by name.
    expect(await numbers(`q=${encodeURIComponent("Small")}`)).toEqual([3]);
    expect(await numbers("q=TestStudent")).toEqual([3]);
    // The plaintext of a sensitive cell matches nothing.
    expect(await numbers(`q=${LOCKER_CODE}`)).toEqual([]);
    expect(
      await numbers(`filter_column=${col.Size}&filter_value=large&sort=${col["Locker number"]}`),
    ).toEqual([7, 11]);
    expect(await numbers("link_kind=student")).toEqual([3]);
    expect(await numbers("link_kind=none&limit=1&offset=1")).toHaveLength(1);
    // Wildcards are literal.
    expect(await numbers("q=%25")).toEqual([]);

    for (const query of [
      `filter_column=${col["Padlock code"]}&filter_value=A`,
      `sort=${col["Padlock code"]}`,
      `filter_column=${col["Locker number"]}&filter_value=abc`,
    ]) {
      const response = await call(w.admin, "GET", `/api/custom-lists/${list.id}/rows?${query}`);
      expect(response.status).toBe(422);
    }
    // Not a sort key at all: refused by validation before any SQL.
    expect(
      (await call(w.admin, "GET", `/api/custom-lists/${list.id}/rows?sort=password`)).status,
    ).toBe(400);
  }, 60_000);

  test("CSV export leaves sensitive columns out and defuses formulas", async () => {
    const w = await world();
    const { list, col } = await lockersList(w);
    await addRow(w.admin, list.id, {
      link: { kind: "student", id: w.studentId },
      values: [
        { column_id: col["Locker number"], value: -5 },
        { column_id: col.Size, value: "small" },
        { column_id: col.Notes, value: '=HYPERLINK("x")' },
        { column_id: col["Padlock code"], value: LOCKER_CODE },
      ],
    });
    const response = await call(w.admin, "GET", `/api/custom-lists/${list.id}/export?lang=ar`);
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain("text/csv");
    const bytes = new Uint8Array(await response.arrayBuffer());
    // A UTF-8 byte-order mark, so spreadsheet apps read the Arabic correctly.
    expect([...bytes.slice(0, 3)]).toEqual([0xef, 0xbb, 0xbf]);
    const csv = new TextDecoder().decode(bytes);
    expect(csv).not.toContain(LOCKER_CODE);
    expect(csv).not.toContain("رمز القفل");
    expect(csv).toContain("رقم الخزانة");
    expect(csv).toContain("صغير");
    expect(csv).toContain("Primary TestStudent");
    expect(csv).toContain(`"'=HYPERLINK(""x"")"`);
    expect(csv).toContain(",-5,");
    const exports = await database!.sql`
      SELECT 1 FROM app.audit_logs
      WHERE school_id = ${w.schoolId}::uuid AND action = 'export' AND target_id = ${list.id}::uuid
    `;
    expect(exports).toHaveLength(1);
  }, 60_000);

  test("a subject's linked rows come only from lists the caller may use", async () => {
    const w = await world();
    const leadership = await lockersList(w, w.admin, "leadership");
    const adminOnly = await lockersList(w, w.admin, "admins");
    for (const { list, col } of [leadership, adminOnly]) {
      await addRow(w.admin, list.id, {
        link: { kind: "student", id: w.studentId },
        values: [
          { column_id: col["Locker number"], value: 9 },
          { column_id: col["Padlock code"], value: LOCKER_CODE },
        ],
      });
    }
    const linked = async (who: Actor) => {
      const response = await call(who, "GET", `/api/custom-lists/linked/student/${w.studentId}`);
      expect(response.status).toBe(200);
      return json<{ lists: { list: { id: string }; rows: RowDto[]; total: number }[] }>(response);
    };
    const admin = await linked(w.admin);
    expect(admin.lists.map((entry) => entry.list.id).sort()).toEqual(
      [leadership.list.id, adminOnly.list.id].sort(),
    );
    const principal = await linked(w.principal);
    expect(principal.lists.map((entry) => entry.list.id)).toEqual([leadership.list.id]);
    expect(JSON.stringify(principal)).not.toContain(LOCKER_CODE);
    expect((await linked(w.teacher)).lists).toEqual([]);
  }, 60_000);

  test("global search finds a list by name for its audience only, never by a row value", async () => {
    const w = await world();
    const leadership = await createList(w.admin, {
      name_en: "Uniform orders",
      name_ar: "طلبات الزي",
      audience: "leadership",
      columns: [{ field_type: "short_text", label_en: "Item", label_ar: "القطعة" }],
    });
    await createList(w.admin, { name_en: "Uniform budget", audience: "admins" });
    await addRow(w.admin, leadership.id, {
      values: [{ column_id: leadership.columns[0]!.id, value: "Zanzibarblazer" }],
    });
    const search = async (who: Actor, q: string) => {
      const response = await call(
        who,
        "GET",
        `/api/search?q=${encodeURIComponent(q)}&types=custom_lists`,
      );
      expect(response.status).toBe(200);
      const body = await json<{
        results: { custom_lists: { id: string; name_en: string }[] };
        totals: { custom_lists: number };
      }>(response);
      return body;
    };
    expect((await search(w.admin, "unifo")).totals.custom_lists).toBe(2);
    const principal = await search(w.principal, "uniform");
    expect(principal.results.custom_lists.map((hit) => hit.name_en)).toEqual(["Uniform orders"]);
    expect(principal.totals.custom_lists).toBe(1);
    expect((await search(w.principal, "طلبات")).totals.custom_lists).toBe(1);
    expect((await search(w.admin, "Zanzibarblazer")).totals.custom_lists).toBe(0);
    expect((await search(w.teacher, "uniform")).totals.custom_lists).toBe(0);
    expect((await search(w.parent, "uniform")).totals.custom_lists).toBe(0);
  }, 60_000);
});

// ---------------------------------------------------------------------------
// Lifecycle and caps
// ---------------------------------------------------------------------------

describeDb("custom lists: archive, delete and caps", () => {
  test("an archived list is hidden by default and takes no rows; deleting it removes everything", async () => {
    const w = await world();
    const { list, col } = await lockersList(w);
    await addRow(w.admin, list.id, { values: [{ column_id: col["Locker number"], value: 1 }] });
    expect(
      (await call(w.admin, "PATCH", `/api/custom-lists/${list.id}`, { archived: true })).status,
    ).toBe(200);
    const visible = await json<{ lists: ListDto[] }>(
      await call(w.admin, "GET", "/api/custom-lists"),
    );
    expect(visible.lists.some((candidate) => candidate.id === list.id)).toBe(false);
    const all = await json<{ lists: ListDto[] }>(
      await call(w.admin, "GET", "/api/custom-lists?include_archived=true"),
    );
    expect(all.lists.find((candidate) => candidate.id === list.id)?.archived).toBe(true);
    const refused = await addRow(w.admin, list.id, {
      values: [{ column_id: col["Locker number"], value: 2 }],
    });
    expect(refused.status).toBe(422);

    expect((await call(w.principal, "DELETE", `/api/custom-lists/${list.id}`)).status).toBe(204);
    const left = await database!.sql`
      SELECT (SELECT count(*) FROM app.custom_list_rows WHERE list_id = ${list.id}::uuid)
           + (SELECT count(*) FROM app.custom_list_values WHERE list_id = ${list.id}::uuid)
           + (SELECT count(*) FROM app.custom_list_columns WHERE list_id = ${list.id}::uuid)
           + (SELECT count(*) FROM app.custom_list_column_options WHERE list_id = ${list.id}::uuid)
           AS total
    `;
    expect(Number(left[0]!.total)).toBe(0);
  }, 60_000);

  test("the caps count every list and row in the school, including lists the caller cannot see", async () => {
    const w = await world();
    const { list, col } = await lockersList(w, w.admin, "leadership");
    const hidden = await createList(w.admin, { name_en: "Hidden", audience: "admins" });

    // 5,000 rows fill one list.
    await database!.sql`
      INSERT INTO app.custom_list_rows (school_id, list_id)
      SELECT ${w.schoolId}::uuid, ${list.id}::uuid FROM generate_series(1, 5000)
    `;
    const full = await addRow(w.principal, list.id, {
      values: [{ column_id: col["Locker number"], value: 1 }],
    });
    expect(full.status).toBe(409);
    expect((await json(full)).code).toBe("CUSTOM_LIST_LIMIT_REACHED");

    // 15,000 more in admin-only lists the principal cannot see bring the school to 20,000.
    await database!.sql`DELETE FROM app.custom_list_rows WHERE list_id = ${list.id}::uuid`;
    await database!.sql`
      INSERT INTO app.custom_list_rows (school_id, list_id)
      SELECT ${w.schoolId}::uuid, ${hidden.id}::uuid FROM generate_series(1, 5000)
    `;
    for (let index = 0; index < 3; index += 1) {
      const more = await createList(w.admin, { name_en: `Hidden ${index}`, audience: "admins" });
      await database!.sql`
        INSERT INTO app.custom_list_rows (school_id, list_id)
        SELECT ${w.schoolId}::uuid, ${more.id}::uuid
        FROM generate_series(1, ${index === 2 ? 4999 : 5000})
      `;
    }
    const lastRoom = await addRow(w.principal, list.id, {
      values: [{ column_id: col["Locker number"], value: 1 }],
    });
    expect(lastRoom.status).toBe(201);
    const schoolFull = await addRow(w.principal, list.id, {
      values: [{ column_id: col["Locker number"], value: 2 }],
    });
    expect(schoolFull.status).toBe(409);

    // 50 lists per school, counted the same way.
    await database!.sql`
      INSERT INTO app.custom_lists (school_id, name_en, name_ar, audience)
      SELECT ${w.schoolId}::uuid, 'Filler ' || n, 'قائمة ' || n, 'admins'
      FROM generate_series(1, 45) AS n
    `;
    const tooMany = await call(w.principal, "POST", "/api/custom-lists", {
      name_en: "Fifty-first",
      name_ar: "قائمة",
      audience: "leadership",
      links: NO_LINKS,
    });
    expect(tooMany.status).toBe(409);
    expect((await json(tooMany)).code).toBe("CUSTOM_LIST_LIMIT_REACHED");
  }, 120_000);
});

// ---------------------------------------------------------------------------
// Import: a sheet Studafy does not recognise
// ---------------------------------------------------------------------------

describeDb("custom lists: creating a list from a sheet", () => {
  async function importWorld() {
    const w = await world();
    const admission = w.fixture.students[0]!.admissionNumber;
    const studentName = "Primary TestStudent";
    const csv = [
      "Admission No,Book,Due back,Returned,Copies,National ID,Student name",
      `${admission},Dune,2026-10-01,yes,1,9881234567,${studentName}`,
      ` ${admission.toLowerCase()} ,Emma,2026-10-03,no,2,9881234568,${studentName}`,
      // No key: never linked, even though the name matches a student.
      `,Ulysses,2026-11-01,no,1,9881234569,${studentName}`,
      // A key nobody has.
      `NOPE-999,Beloved,not a date,yes,1,9881234570,${studentName}`,
      // Only a prefix of a real key: no partial match.
      `${admission.slice(0, -1)},Persuasion,2026-12-01,no,3,9881234571,${studentName}`,
    ].join("\n");
    const body = {
      csv,
      file_name: "library-loans.csv",
      list: { name_en: "Library loans", name_ar: "إعارات المكتبة", audience: "leadership" },
      link: { column_index: 0, key: "admission_number" },
    };
    return { w, body, csv };
  }

  interface Preview {
    columns: {
      header: string;
      field_type: string;
      sensitivity: string;
      suggested_sensitive: boolean;
      sample: string[];
      invalid_count: number;
      invalid_lines: number[];
      include: boolean;
    }[];
    rows: {
      line: number;
      status: string;
      reason: string | null;
      link: { id: string; name: string | null } | null;
    }[];
    totals: { rows: number; linked: number; unmatched: number; invalid_cells: number };
    links: Record<string, boolean>;
    preview_token: string;
  }

  test("the preview guesses types, proposes exact links only and writes nothing", async () => {
    const { w, body } = await importWorld();
    const response = await call(w.admin, "POST", "/api/custom-lists/imports/preview", body);
    expect(response.status).toBe(200);
    const preview = await json<Preview>(response);
    const byHeader = Object.fromEntries(preview.columns.map((column) => [column.header, column]));
    expect(byHeader["Due back"]!.field_type).toBe("short_text");
    expect(byHeader.Returned!.field_type).toBe("yes_no");
    expect(byHeader.Copies!.field_type).toBe("number");
    expect(byHeader["National ID"]!).toMatchObject({
      sensitivity: "sensitive",
      suggested_sensitive: true,
    });
    // A sensitive column's sample is masks only.
    expect(byHeader["National ID"]!.sample.every((value) => value.startsWith("••••"))).toBe(true);

    expect(preview.rows.map((row) => [row.line, row.status, row.reason])).toEqual([
      [2, "linked", null],
      [3, "linked", null],
      [4, "no_key", null],
      [5, "unmatched", "NO_MATCH"],
      [6, "unmatched", "NO_MATCH"],
    ]);
    expect(preview.rows[0]!.link).toMatchObject({ id: w.studentId, name: "Primary TestStudent" });
    expect(preview.totals).toMatchObject({ rows: 5, linked: 2, unmatched: 3 });
    expect(preview.links).toEqual({ student: true, parent: false, staff: false, class: false });

    const lists = await database!
      .sql`SELECT 1 FROM app.custom_lists WHERE school_id = ${w.schoolId}::uuid`;
    expect(lists).toHaveLength(0);

    // Changing a type re-validates: "not a date" is an invalid date on line 5.
    const asDate = await json<Preview>(
      await call(w.admin, "POST", "/api/custom-lists/imports/preview", {
        ...body,
        columns: [{ index: 2, include: true, field_type: "date" }],
      }),
    );
    const due = asDate.columns.find((column) => column.header === "Due back")!;
    expect(due).toMatchObject({ field_type: "date", invalid_count: 1, invalid_lines: [5] });
    expect(asDate.preview_token).not.toBe(preview.preview_token);
  }, 60_000);

  test("apply writes exactly the preview, and refuses a stale or foreign token", async () => {
    const { w, body } = await importWorld();
    const edited = {
      ...body,
      columns: [
        { index: 2, include: true, field_type: "date" },
        { index: 6, include: false },
      ],
      skip_unmatched: false,
    };
    const preview = await json<Preview>(
      await call(w.admin, "POST", "/api/custom-lists/imports/preview", edited),
    );

    const stale = await call(w.admin, "POST", "/api/custom-lists/imports/apply", {
      ...edited,
      list: { ...edited.list, name_en: "Library loans 2" },
      preview_token: preview.preview_token,
    });
    expect(stale.status).toBe(409);
    expect((await json(stale)).code).toBe("CUSTOM_LIST_PREVIEW_STALE");
    // A token is the previewing caller's own.
    const foreign = await call(w.principal, "POST", "/api/custom-lists/imports/apply", {
      ...edited,
      preview_token: preview.preview_token,
    });
    expect(foreign.status).toBe(409);
    expect(
      (await call(w.teacher, "POST", "/api/custom-lists/imports/preview", edited)).status,
    ).toBe(403);

    const applied = await call(w.admin, "POST", "/api/custom-lists/imports/apply", {
      ...edited,
      preview_token: preview.preview_token,
    });
    expect(applied.status).toBe(201);
    const result = await json<{
      list_id: string;
      rows_created: number;
      rows_linked: number;
      cells_left_empty: number;
    }>(applied);
    expect(result).toMatchObject({ rows_created: 5, rows_linked: 2, cells_left_empty: 1 });

    const detail = await json<ListDto>(
      await call(w.admin, "GET", `/api/custom-lists/${result.list_id}`),
    );
    expect(detail.columns.map((column) => column.label_en)).toEqual([
      "Admission No",
      "Book",
      "Due back",
      "Returned",
      "Copies",
      "National ID",
    ]);
    expect(detail.audience).toBe("leadership");
    const nationalId = detail.columns.find((column) => column.label_en === "National ID")!;
    expect(nationalId.sensitivity).toBe("sensitive");
    const book = detail.columns.find((column) => column.label_en === "Book")!;

    const page = await json<{ rows: RowDto[]; total: number }>(
      await call(
        w.admin,
        "GET",
        `/api/custom-lists/${result.list_id}/rows?sort=created_at&limit=10`,
      ),
    );
    expect(page.total).toBe(5);
    const linked = page.rows.filter((row) => row.link !== null);
    expect(linked.map((row) => cell(row, book.id)?.value).sort()).toEqual(["Dune", "Emma"]);
    expect(linked.every((row) => row.link!.id === w.studentId)).toBe(true);
    expect(page.rows.every((row) => cell(row, nationalId.id)?.masked === true)).toBe(true);
    const sealed = await database!.sql`
      SELECT 1 FROM app.custom_list_values
      WHERE column_id = ${nationalId.id}::uuid AND value_ciphertext IS NOT NULL AND value_text IS NULL
    `;
    expect(sealed).toHaveLength(5);

    // One audit row for the import, with counts and no cell.
    const audits = await database!.sql<{ new_values: Record<string, unknown> }[]>`
      SELECT new_values FROM app.audit_logs
      WHERE school_id = ${w.schoolId}::uuid AND target_table = 'custom_list_rows'
        AND target_id = ${result.list_id}::uuid
    `;
    expect(audits).toHaveLength(1);
    expect(audits[0]!.new_values).toMatchObject({ import: true, rows_created: 5, rows_linked: 2 });
    expect(JSON.stringify(audits[0]!.new_values)).not.toContain("9881234567");
  }, 60_000);

  test("member codes and class codes link exactly; skip_unmatched leaves the rest out", async () => {
    const w = await world();
    await assignRole(database!.sql, w.schoolId, w.fixture.students[0]!.userId, ROLES.STUDENT);
    const codes = await database!.sql<{ kind: string; code: string; user_id: string }[]>`
      SELECT kind, code, user_id FROM app.member_codes WHERE school_id = ${w.schoolId}::uuid
    `;
    const studentCode = codes.find(
      (code) => code.kind === "STU" && code.user_id === w.fixture.students[0]!.userId,
    )!.code;
    const teacherCode = codes.find((code) => code.user_id === w.teacher.userId)!.code;
    const parentCode = codes.find((code) => code.user_id === w.parent.userId)!.code;
    const csv = [
      "Member,Bus stop",
      `${studentCode.toLowerCase()},North gate`,
      `${teacherCode},Staff car park`,
      `${parentCode},Main road`,
      "STU-0,Nowhere",
    ].join("\n");
    const body = {
      csv,
      list: { name_en: "Bus stops", name_ar: "مواقف الحافلات", audience: "admins" },
      link: { column_index: 0, key: "member_id" },
      skip_unmatched: true,
    };
    const preview = await json<Preview>(
      await call(w.admin, "POST", "/api/custom-lists/imports/preview", body),
    );
    expect(preview.rows.map((row) => row.status)).toEqual([
      "linked",
      "linked",
      "linked",
      "skipped",
    ]);
    expect(preview.links).toEqual({ student: true, parent: true, staff: true, class: false });
    const applied = await json<{ list_id: string; rows_created: number }>(
      await call(w.admin, "POST", "/api/custom-lists/imports/apply", {
        ...body,
        preview_token: preview.preview_token,
      }),
    );
    expect(applied.rows_created).toBe(3);
    const page = await json<{ rows: RowDto[] }>(
      await call(w.admin, "GET", `/api/custom-lists/${applied.list_id}/rows`),
    );
    expect(page.rows.map((row) => row.link?.kind).sort()).toEqual(["parent", "staff", "student"]);

    const classes = await json<Preview>(
      await call(w.admin, "POST", "/api/custom-lists/imports/preview", {
        csv: `Class,Homeroom\n${w.fixture.cls.code.toUpperCase()},Room 4\nCLS-NONE,Room 5\n`,
        list: { name_en: "Homerooms", name_ar: "الصفوف", audience: "admins" },
        link: { column_index: 0, key: "class_code" },
      }),
    );
    expect(classes.rows.map((row) => row.status)).toEqual(["linked", "unmatched"]);
    expect(classes.rows[0]!.link?.id).toBe(w.classId);
  }, 60_000);
});
