/**
 * Cross-role smoke test of one school day, over HTTP, with the request bodies the mobile app sends.
 *
 * Every body below is what the generated Dart client (or the app's hand-written client) puts on the
 * wire once unset optional fields are omitted (`includeIfNull: false`, see
 * apps/mobile/scripts/generate_api_client.sh). The point is to catch contract drift between the app
 * and the API that unit tests of either side cannot: a 400 here is a screen that fails on a phone.
 *
 *   1. Principal: grade level, section, class moved into the section, student placed (enrolled).
 *      The subject's grading setup is written through the service, as the web wizard does.
 *   2. Teacher: publishes an assignment with an attachment, uploads a material, opens an attendance
 *      register and submits it with the student absent, enters a mark.
 *   3. Student: sees the assignment and can download its attachment, submits with an attachment.
 *   4. Parent: sees the child, and messages the teacher about the child.
 *
 * Notifications are produced by the workers from the outbox, so this asserts the outbox event the
 * worker turns into a parent notification, not the push itself (covered by the workers' tests).
 *
 *   TEST_DATABASE_URL=postgres://... bun test tests/workflow/school-day-smoke-http.test.ts
 */

import { ROLES } from "@studafy/constants";
// eslint-disable-next-line import-x/no-unresolved -- "bun:test" is a virtual Bun built-in with no resolvable file path
import { afterAll, beforeAll, describe, expect, test } from "bun:test";

import { withTenantTx } from "../../src/db/tenant-tx";
import {
  createSubjectConfig,
  setYearGradingStatus,
  upsertProgram,
} from "../../src/modules/grading/config-service";
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

import type { StorageService } from "../../src/lib/storage";
import type { TestApp, TestDatabase, TenantFixture } from "../harness";
import type { Role } from "@studafy/constants";

const describeDb = integrationEnabled ? describe : describe.skip;

// ---------------------------------------------------------------------------
// In-memory object storage: a PUT to a pre-signed URL is simulated by setting the object.
// ---------------------------------------------------------------------------

interface StoredObject {
  contentType: string;
  sizeBytes: number;
}

const objects = new Map<string, StoredObject>();

const storage: StorageService = {
  ttlSeconds: 900,
  check: async () => true,
  presign(key, _method, _contentType, ttlOverrideSeconds) {
    return {
      url: `https://storage.example/${key}?signed`,
      expiresAt: new Date(Date.now() + (ttlOverrideSeconds ?? 900) * 1000),
    };
  },
  async exists(key) {
    return objects.has(key);
  },
  async size(key) {
    return objects.get(key)?.sizeBytes ?? 0;
  },
  async head(key) {
    const object = objects.get(key);
    return object ? { contentType: object.contentType, sizeBytes: object.sizeBytes } : null;
  },
  async checksumSha256() {
    return "a".repeat(64);
  },
  async copy(source, destination) {
    const object = objects.get(source);
    if (object) objects.set(destination, { ...object });
  },
  async remove(key) {
    objects.delete(key);
  },
  async *list(prefix) {
    for (const [key, object] of objects) {
      if (key.startsWith(prefix)) yield { key, sizeBytes: object.sizeBytes };
    }
  },
};

// ---------------------------------------------------------------------------
// Harness
// ---------------------------------------------------------------------------

let database: TestDatabase | undefined;
let harness: TestApp | undefined;
let tenant: TenantFixture;

interface Actor {
  schoolId: string;
  userId: string;
  roles: Role[];
  channel: "mobile" | "web";
}

const actors = {} as Record<"principal" | "teacher" | "student" | "parent", Actor>;
const ids = {} as Record<string, string>;

const actor = (userId: string, role: Role, channel: Actor["channel"] = "mobile"): Actor => ({
  schoolId: tenant.schoolId,
  userId,
  roles: [role],
  channel,
});

async function call(who: Actor, method: string, path: string, body?: unknown) {
  const response = await authenticatedRequest(harness!, method, path, who, {
    headers: { "Content-Type": "application/json" },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const text = await response.text();
  let json: unknown;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    json = text;
  }
  return { status: response.status, json: json as Record<string, unknown> };
}

/** Assert a status and say which request failed and why, so a contract break reads clearly. */
function expectStatus(result: { status: number; json: unknown }, expected: number, what: string) {
  if (result.status !== expected) {
    throw new Error(
      `${what}: expected ${expected}, got ${result.status} ${JSON.stringify(result.json)}`,
    );
  }
}

const today = new Date().toISOString().slice(0, 10);
const docx = "application/vnd.openxmlformats-officedocument.wordprocessingml.document";

beforeAll(async () => {
  if (!integrationEnabled) return;
  database = await createTestDatabase();
  await migrateDatabase(database.url);
  const created = createTestApp({ database: database.sql, storage });
  await created.ready;
  harness = created;
  const sql = database.sql;
  tenant = await createFullTenant(sql);

  await assignRole(sql, tenant.schoolId, tenant.teachers[0]!.userId, ROLES.INSTRUCTOR);
  await assignRole(sql, tenant.schoolId, tenant.students[0]!.userId, ROLES.STUDENT);
  const principal = await createUser(sql, tenant.schoolId, {
    email: `principal-${crypto.randomUUID().slice(0, 8)}@test.local`,
  });
  await assignRole(sql, tenant.schoolId, principal.id, ROLES.PRINCIPAL);

  actors.principal = actor(principal.id, ROLES.PRINCIPAL, "web");
  actors.teacher = actor(tenant.teachers[0]!.userId, ROLES.INSTRUCTOR);
  actors.student = actor(tenant.students[0]!.userId, ROLES.STUDENT);
  actors.parent = actor(tenant.users.PARENT.id, ROLES.PARENT);
  ids.student = tenant.students[0]!.id;
  ids.class = tenant.cls.id;

  // The parent's link to the child (what an import or the admission flow writes).
  const [family] = await sql<{ id: string }[]>`
    INSERT INTO app.families (school_id, display_name, primary_parent_user_id)
    VALUES (${tenant.schoolId}::uuid, 'Family', ${tenant.users.PARENT.id}::uuid)
    RETURNING id
  `;
  await sql`
    INSERT INTO app.parent_child_links (school_id, family_id, parent_user_id, student_id, relationship)
    VALUES (${tenant.schoolId}::uuid, ${family!.id}::uuid, ${tenant.users.PARENT.id}::uuid,
            ${ids.student}::uuid, 'guardian')
  `;
}, 180_000);

afterAll(async () => {
  harness?.keyStore.destroy();
  await database?.cleanup();
});

// ---------------------------------------------------------------------------
// The day
// ---------------------------------------------------------------------------

describeDb("one school day across roles, with the app's request shapes", () => {
  test("principal: grade, section, class in the section, student placed", async () => {
    const grade = await call(actors.principal, "POST", "/api/academics/grade-levels", {
      name: "Grade 12",
      sort_order: 12,
    });
    expectStatus(grade, 201, "create grade level");
    ids.grade = grade.json.id as string;

    const section = await call(actors.principal, "POST", "/api/academics/sections", {
      academic_year_id: tenant.academicYear.id,
      grade_level_id: ids.grade,
      name: "A",
    });
    expectStatus(section, 201, "create section");
    ids.section = section.json.id as string;

    expectStatus(
      await call(actors.principal, "PATCH", `/api/academics/classes/${ids.class}`, {
        section_id: ids.section,
      }),
      200,
      "move class into section",
    );

    const placed = await call(
      actors.principal,
      "POST",
      `/api/academics/sections/${ids.section}/students`,
      { student_id: ids.student },
    );
    expect([200, 201]).toContain(placed.status);

    // Grading setup for the class's subject (the web wizard writes the same through the service).
    await withTenantTx(
      database!.sql,
      { schoolId: tenant.schoolId, userId: tenant.users.ORG_ADMIN.id },
      async (tx) => {
        await upsertProgram(tx, tenant.schoolId, tenant.academicYear.id, ids.grade!, {
          mark_approval_required: false,
          result_format: "percentage",
          result_scale_max: null,
        });
        await createSubjectConfig(
          tx,
          tenant.schoolId,
          tenant.users.ORG_ADMIN.id,
          {
            yearId: tenant.academicYear.id,
            gradeLevelId: ids.grade!,
            sectionId: null,
            subjectId: tenant.subject.id,
          },
          {
            requirement: "mandatory",
            include_in_average: true,
            include_on_certificate: true,
            average_weight: 1,
            grading_method: "weighted",
            max_marks: 100,
            pass_percentage: 50,
            final_exam_pass_percentage: null,
            grade_scale_id: null,
            rounding_decimals: 2,
            rounding_mode: "half_up",
            missing_mark_policy: "incomplete",
            absent_policy: "incomplete",
            retake_policy: "none",
            retake_cap_percentage: null,
            teachers_can_add_assessments: true,
            teacher_assessments_require_approval: false,
            instructions: null,
            term_weights: [],
            categories: [
              {
                ref: "final",
                name: "Final",
                kind: "final_exam",
                scope: "annual",
                weight: 100,
                aggregation: "weighted_average",
                drop_lowest: 0,
                sort_order: 0,
              },
            ],
            assessments: [
              {
                category_ref: "final",
                term_id: null,
                name: "Final",
                max_marks: 100,
                weight: 1,
                is_mandatory: true,
                assessment_date: null,
                due_date: null,
                sort_order: 0,
              },
            ],
          },
        );
        await setYearGradingStatus(tx, tenant.schoolId, tenant.academicYear.id, "active");
      },
    );

    const enrollments = await call(
      actors.teacher,
      "GET",
      `/api/academics/classes/${ids.class}/enrollments`,
    );
    expectStatus(enrollments, 200, "teacher lists enrollments");
    expect(JSON.stringify(enrollments.json)).toContain(ids.student!);
  });

  test("teacher: publishes an assignment with an attachment", async () => {
    // CreateAssignmentBody as the composer sends it.
    const created = await call(actors.teacher, "POST", "/api/academics/assignments", {
      class_id: ids.class,
      title: "الجاذبية",
      description: "اقرأ الملف",
      due_at: new Date(Date.now() + 7 * 86_400_000).toISOString(),
      max_score: 100,
      allow_late_submission: true,
      status: "published",
      kind: "written",
    });
    expectStatus(created, 201, "create assignment");
    ids.assignment = created.json.id as string;

    const base = `/api/academics/assignments/${ids.assignment}/attachments`;
    const minted = await call(actors.teacher, "POST", `${base}/upload-url`, {
      file_name: "فلسطين كما خلقها الله - نسخة النشر.docx",
      content_type: docx,
    });
    expectStatus(minted, 201, "assignment attachment upload-url");
    objects.set(minted.json.storage_key as string, { contentType: docx, sizeBytes: 4_000 });

    // AssignmentConfirmAttachmentBody: storage_key + content_type, no checksum.
    const confirmed = await call(actors.teacher, "POST", base, {
      storage_key: minted.json.storage_key,
      content_type: docx,
    });
    expectStatus(confirmed, 201, "confirm assignment attachment");
  });

  test("teacher: uploads a material the way the app resolves and confirms it", async () => {
    const initiated = await call(actors.teacher, "POST", "/api/academics/materials/upload", {
      class_id: ids.class,
      title: "math",
      description: "math to study",
      original_file_name: "Studafy TAM SAM SOM 2.pdf",
      mime_type: "application/pdf",
      size_bytes: 12_000,
    });
    expectStatus(initiated, 201, "initiate material upload");
    const storageKey = initiated.json.storage_key as string;

    // The app finds the new row by its storage key in the class's material list.
    const list = await call(
      actors.teacher,
      "GET",
      `/api/academics/materials?class_id=${ids.class}&limit=100`,
    );
    expectStatus(list, 200, "list materials");
    const pending = (list.json.materials as { id: string; storage_key: string }[]).find(
      (material) => material.storage_key === storageKey,
    );
    expect(pending).toBeDefined();

    objects.set(storageKey, { contentType: "application/pdf", sizeBytes: 12_000 });
    // ConfirmUploadBody: storage_key only (checksum omitted when unset).
    const confirmed = await call(
      actors.teacher,
      "POST",
      `/api/academics/materials/${pending!.id}/confirm`,
      { storage_key: storageKey },
    );
    expectStatus(confirmed, 200, "confirm material upload");
  });

  test("teacher: takes today's register with the student absent and submits it", async () => {
    const opened = await call(actors.teacher, "POST", "/api/attendance/sessions", {
      class_id: ids.class,
      session_date: today,
    });
    expect([200, 201]).toContain(opened.status);
    ids.session = opened.json.id as string;

    const recorded = await call(actors.teacher, "POST", "/api/attendance/records/batch", {
      attendance_session_id: ids.session,
      records: [{ student_id: ids.student, status: "absent" }],
    });
    expect([200, 201]).toContain(recorded.status);

    const submitted = await call(
      actors.teacher,
      "PATCH",
      `/api/attendance/sessions/${ids.session}`,
      {
        status: "submitted",
      },
    );
    expectStatus(submitted, 200, "submit register");

    // The worker turns this into the parents' absence notification.
    const [event] = await database!.sql<{ count: string }[]>`
      SELECT count(*)::text AS count FROM app.outbox_events
      WHERE school_id = ${tenant.schoolId}::uuid AND event_name ILIKE '%attendance%'
    `;
    expect(Number(event!.count)).toBeGreaterThan(0);
  });

  test("teacher: enters the student's mark on the mark sheet", async () => {
    const sheet = await call(
      actors.teacher,
      "GET",
      `/api/grading/sections/${ids.section}/subjects/${tenant.subject.id}/marks`,
    );
    expectStatus(sheet, 200, "get mark sheet");
    const assessment = (sheet.json.assessments as { id: string }[])[0]!;

    // MarkEntry.toJson sends every key, nulls included (all nullable in the schema).
    const saved = await call(
      actors.teacher,
      "PUT",
      `/api/grading/sections/${ids.section}/subjects/${tenant.subject.id}/marks`,
      {
        entries: [
          {
            assessment_id: assessment.id,
            student_id: ids.student,
            attempt: 1,
            status: "graded",
            score: 85,
            descriptor_id: null,
            remarks: null,
            expected_updated_at: null,
          },
        ],
      },
    );
    expectStatus(saved, 200, "save marks");
  });

  test("student: sees the assignment, can open its attachment, submits with a file", async () => {
    interface Attachment {
      download_url: string | null;
      download_state: string;
    }
    const open = () => call(actors.student, "GET", `/api/academics/assignments/${ids.assignment}`);

    // Before the malware scan finishes the file is listed as being checked, without a link.
    const checking = await open();
    expectStatus(checking, 200, "student opens assignment");
    const pending = checking.json.attachments as Attachment[];
    expect(pending).toHaveLength(1);
    expect(pending[0]!.download_state).toBe("checking");
    expect(pending[0]!.download_url).toBeNull();

    // The scan worker marks it clean; the student then gets a link.
    await database!.sql`
      UPDATE app.assignment_attachments SET scan_status = 'clean'
      WHERE assignment_id = ${ids.assignment!}::uuid
    `;
    const ready = (await open()).json.attachments as Attachment[];
    expect(ready[0]!.download_state).toBe("ready");
    expect(ready[0]!.download_url).toBeTruthy();

    // CreateSubmissionBody with only the typed answer.
    const submission = await call(
      actors.student,
      "POST",
      `/api/academics/assignments/${ids.assignment}/submissions`,
      { content: "my answer" },
    );
    expect([200, 201]).toContain(submission.status);
    ids.submission = submission.json.id as string;

    const base = `/api/academics/submissions/${ids.submission}/attachments`;
    const minted = await call(actors.student, "POST", `${base}/upload-url`, {
      file_name: "homework.jpg",
      content_type: "image/jpeg",
    });
    expectStatus(minted, 201, "submission attachment upload-url");
    objects.set(minted.json.storage_key as string, { contentType: "image/jpeg", sizeBytes: 3_000 });

    // ConfirmSubmissionAttachmentBody: storage_key + content_type (checksum omitted).
    const confirmed = await call(actors.student, "POST", base, {
      storage_key: minted.json.storage_key,
      content_type: "image/jpeg",
    });
    expectStatus(confirmed, 201, "confirm submission attachment");
  });

  test("parent: sees the child and messages the teacher", async () => {
    const children = await call(
      actors.parent,
      "GET",
      `/api/reports/children/comparison?term_id=${tenant.term.id}`,
    );
    expectStatus(children, 200, "parent children report");
    expect(JSON.stringify(children.json)).toContain(ids.student!);

    const conversation = await call(actors.parent, "POST", "/api/messaging/conversations", {
      student_id: ids.student,
      teacher_id: tenant.teachers[0]!.userId,
    });
    if (![200, 201].includes(conversation.status))
      throw new Error(
        `create conversation: ${conversation.status} ${JSON.stringify(conversation.json)}`,
      );
    const sent = await call(
      actors.parent,
      "POST",
      `/api/messaging/conversations/${(conversation.json.conversation as { id: string }).id}/messages`,
      { body: "Hello teacher" },
    );
    if (![200, 201].includes(sent.status))
      throw new Error(`send message: ${sent.status} ${JSON.stringify(sent.json)}`);
  });
});
