import { createRoute, OpenAPIHono } from "@hono/zod-openapi";
import { ERROR_CODES, PERMISSIONS } from "@studafy/constants";

import { CodedHttpException } from "../../coded-http-exception";
import { setTenantScope, withSystemTx, withTenantTx } from "../../db/tenant-tx";
import { requireStorage } from "../../lib/storage";
import { auditAction } from "../../middleware/auditEmitter";
import { requireAuth } from "../../middleware/authContext";
import { hasPermission, requirePermission } from "../../middleware/authz";
import { requireChannel } from "../../middleware/channelGuard";
import { onlyMethods } from "../../middleware/only-methods";
import { openApiValidationHook } from "../../openapi/hook";
import { requestIdHeaders, standardResponses } from "../../openapi/responses";
import { AUTH_CHANNELS } from "../auth/channels";

import { listMissingParents, listMissingStudents, missingSummary } from "./missing-service";
import {
  assertSubjectReadable,
  attachDocument,
  audienceFor,
  documentDownload,
  getRecordForm,
  getSubjectRecords,
  removeDocument,
  revealValue,
  updateDocument,
  writeAnswers,
} from "./record-service";
import {
  attachRecordDocumentBodySchema,
  createRecordFieldBodySchema,
  parentRecordFieldParamSchema,
  parentRecordParamSchema,
  recordDocumentDownloadSchema,
  recordFormSchema,
  recordMissingParentListSchema,
  recordMissingQuerySchema,
  recordMissingStudentListSchema,
  recordMissingSummarySchema,
  recordTemplateFieldSchema,
  recordTemplateSchema,
  recordTemplateVersionSchema,
  reorderRecordFieldsBodySchema,
  revealedRecordValueSchema,
  studentRecordFieldParamSchema,
  studentRecordParamSchema,
  subjectKindParamSchema,
  subjectRecordsSchema,
  templateFieldParamSchema,
  updateRecordDocumentBodySchema,
  updateRecordFieldBodySchema,
  updateRecordsBodySchema,
} from "./schemas";
import {
  createField,
  getTemplate,
  publishTemplate,
  reorderFields,
  updateField,
} from "./template-service";

import type { RecordSubject } from "./record-service";
import type { Database } from "../../db/client";
import type { StorageService } from "../../lib/storage";
import type { AppEnv } from "../../middleware/requestId";
import type { RecordAudience, RecordKeyring } from "@studafy/records";
import type { Context } from "hono";
import type { TransactionSql } from "postgres";

const TAG = "Student and parent records";

function tenantFrom(c: Context<AppEnv>) {
  const auth = requireAuth(c);
  return { schoolId: auth.schoolId, userId: auth.userId, requestId: c.get("requestId") };
}

function audienceOf(c: Context<AppEnv>): RecordAudience {
  const audience = audienceFor(requireAuth(c).roles);
  if (!audience) {
    throw new CodedHttpException(403, ERROR_CODES.AUTHZ_FORBIDDEN, "Insufficient permissions");
  }
  return audience;
}

/**
 * The transaction a record read runs in. FINANCE holds no student:read and app.students' row
 * scope hides every student from it, so its (visibility-narrowed, never sensitive) reads run as
 * studafy_admin with tenant isolation armed -- the identity transaction Finance > Unlinked uses
 * (modules/finance/students/service.ts). Everyone else reads under their own RLS row scope.
 */
function readTx<T>(
  database: Database,
  c: Context<AppEnv>,
  audience: RecordAudience,
  fn: (tx: TransactionSql) => Promise<T>,
): Promise<T> {
  if (audience === "finance") {
    const { schoolId } = tenantFrom(c);
    return withSystemTx(database, async (tx) => {
      await setTenantScope(tx, schoolId, c.get("requestId"));
      return fn(tx);
    });
  }
  return withTenantTx(database, tenantFrom(c), fn);
}

/** Record responses are never cached: by a browser, a proxy, or the mobile offline cache. */
function noStore(c: Context<AppEnv>): void {
  c.header("Cache-Control", "no-store");
}

/** Remove an object after its row change committed; a failure is left to the bucket's inventory. */
async function removeObject(storage: StorageService, key: string | null): Promise<void> {
  if (!key) return;
  try {
    await storage.remove(key);
  } catch {
    // The row no longer references it; storage-quota reconciliation reports the stray object.
  }
}

// ---------------------------------------------------------------------------
// Template editor routes
// ---------------------------------------------------------------------------

const getTemplateRoute = createRoute({
  method: "get",
  path: "/api/record-templates/{subjectKind}",
  tags: [TAG],
  operationId: "getRecordTemplate",
  summary: "Get the record template draft",
  description:
    "The school's draft template for students or parents, with every field (archived ones " +
    "included) and whether the draft differs from the published version.",
  security: [{ bearerAuth: [] }],
  request: { params: subjectKindParamSchema },
  responses: standardResponses(
    { 200: { description: "The draft template.", schema: recordTemplateSchema } },
    [400, 401, 403, 500],
  ),
});

const createFieldRoute = createRoute({
  method: "post",
  path: "/api/record-templates/{subjectKind}/fields",
  tags: [TAG],
  operationId: "createRecordField",
  summary: "Add a field to the draft",
  description: "Adds a field at the end of the draft. It reaches the form at the next publish.",
  security: [{ bearerAuth: [] }],
  request: {
    params: subjectKindParamSchema,
    body: {
      required: true,
      content: { "application/json": { schema: createRecordFieldBodySchema } },
    },
  },
  responses: standardResponses(
    { 201: { description: "The new draft field.", schema: recordTemplateFieldSchema } },
    [400, 401, 403, 422, 429, 500],
  ),
});

const updateFieldRoute = createRoute({
  method: "patch",
  path: "/api/record-templates/{subjectKind}/fields/{fieldId}",
  tags: [TAG],
  operationId: "updateRecordField",
  summary: "Edit or archive a draft field",
  description:
    "Edits a field in the draft, or archives it (`archived: true`) so the next publish drops it " +
    "from the form. Answers are never deleted. A published field's type cannot change, and a " +
    "field published as sensitive stays sensitive (409 RECORD_FIELD_LOCKED).",
  security: [{ bearerAuth: [] }],
  request: {
    params: templateFieldParamSchema,
    body: {
      required: true,
      content: { "application/json": { schema: updateRecordFieldBodySchema } },
    },
  },
  responses: standardResponses(
    { 200: { description: "The updated draft field.", schema: recordTemplateFieldSchema } },
    [400, 401, 403, 404, 409, 422, 429, 500],
  ),
});

const reorderFieldsRoute = createRoute({
  method: "put",
  path: "/api/record-templates/{subjectKind}/field-order",
  tags: [TAG],
  operationId: "reorderRecordFields",
  summary: "Reorder the draft fields",
  description: "The listed fields come first, in that order; any others follow in their order.",
  security: [{ bearerAuth: [] }],
  request: {
    params: subjectKindParamSchema,
    body: {
      required: true,
      content: { "application/json": { schema: reorderRecordFieldsBodySchema } },
    },
  },
  responses: standardResponses(
    { 200: { description: "The draft template.", schema: recordTemplateSchema } },
    [400, 401, 403, 422, 429, 500],
  ),
});

const publishTemplateRoute = createRoute({
  method: "post",
  path: "/api/record-templates/{subjectKind}/publish",
  tags: [TAG],
  operationId: "publishRecordTemplate",
  summary: "Publish the draft as a new version",
  description:
    "Snapshots the draft's non-archived fields as the next version. Existing answers keep " +
    "pointing at the version they were given under. Fields raised to sensitive have their " +
    "answers encrypted in the same transaction.",
  security: [{ bearerAuth: [] }],
  request: { params: subjectKindParamSchema },
  responses: standardResponses(
    { 201: { description: "The published version.", schema: recordTemplateVersionSchema } },
    [400, 401, 403, 409, 429, 500],
  ),
});

const getFormRoute = createRoute({
  method: "get",
  path: "/api/record-forms/{subjectKind}",
  tags: [TAG],
  operationId: "getRecordForm",
  summary: "Get the published record form",
  description:
    "The fields of the current published version, for filling a record in while creating a " +
    "student or a parent. Needs studentRecord:update.",
  security: [{ bearerAuth: [] }],
  request: { params: subjectKindParamSchema },
  responses: standardResponses(
    { 200: { description: "The published form.", schema: recordFormSchema } },
    [400, 401, 403, 500],
  ),
});

// ---------------------------------------------------------------------------
// Subject record routes (students and parents share one shape)
// ---------------------------------------------------------------------------

const FILL_IN_DESCRIPTION =
  "Writes the listed answers against the current form; null clears one. Missing required fields " +
  "are never an error. Every change is audited; a sensitive field's audit row names the field, " +
  "never the value.";
const REVEAL_DESCRIPTION =
  "The full value of one sensitive answer. Needs studentRecord:readSensitive, and every call is " +
  "audited: who, when, and which field.";
const ATTACH_DESCRIPTION =
  "Confirms a file staged through POST /api/storage/uploads/request-upload (content class " +
  "record.document, or record.sensitiveDocument for a sensitive field) and attaches it, " +
  "replacing any earlier file. The status becomes uploaded.";
const DOWNLOAD_DESCRIPTION =
  "A short-lived download URL. A sensitive document needs studentRecord:readSensitive, its URL " +
  "lives one minute, and issuing it is audited like a reveal.";

const getStudentRecordsRoute = createRoute({
  method: "get",
  path: "/api/students/{studentId}/records",
  tags: [TAG],
  operationId: "getStudentRecords",
  summary: "Get a student's record",
  description:
    "Every field of the published form the caller may see, with its answer. Sensitive answers " +
    "come back masked (value null, mask set); see the reveal call.",
  security: [{ bearerAuth: [] }],
  request: { params: studentRecordParamSchema },
  responses: standardResponses(
    { 200: { description: "The record.", schema: subjectRecordsSchema } },
    [401, 403, 404, 500],
  ),
});

const updateStudentRecordsRoute = createRoute({
  method: "put",
  path: "/api/students/{studentId}/records",
  tags: [TAG],
  operationId: "updateStudentRecords",
  summary: "Fill in a student's record",
  description: FILL_IN_DESCRIPTION,
  security: [{ bearerAuth: [] }],
  request: {
    params: studentRecordParamSchema,
    body: { required: true, content: { "application/json": { schema: updateRecordsBodySchema } } },
  },
  responses: standardResponses(
    { 200: { description: "The record after the write.", schema: subjectRecordsSchema } },
    [400, 401, 403, 404, 409, 422, 429, 500],
  ),
});

const revealStudentRecordValueRoute = createRoute({
  method: "post",
  path: "/api/students/{studentId}/records/{fieldId}/reveal",
  tags: [TAG],
  operationId: "revealStudentRecordValue",
  summary: "Reveal a sensitive value",
  description: REVEAL_DESCRIPTION,
  security: [{ bearerAuth: [] }],
  request: { params: studentRecordFieldParamSchema },
  responses: standardResponses(
    { 200: { description: "The revealed value.", schema: revealedRecordValueSchema } },
    [401, 403, 404, 409, 429, 500, 503],
  ),
});

const attachStudentRecordDocumentRoute = createRoute({
  method: "put",
  path: "/api/students/{studentId}/records/{fieldId}/document",
  tags: [TAG],
  operationId: "attachStudentRecordDocument",
  summary: "Attach the file for a document field",
  description: ATTACH_DESCRIPTION,
  security: [{ bearerAuth: [] }],
  request: {
    params: studentRecordFieldParamSchema,
    body: {
      required: true,
      content: { "application/json": { schema: attachRecordDocumentBodySchema } },
    },
  },
  responses: standardResponses(
    { 200: { description: "The record after the write.", schema: subjectRecordsSchema } },
    [400, 401, 403, 404, 409, 422, 429, 500, 503],
  ),
});

const updateStudentRecordDocumentRoute = createRoute({
  method: "patch",
  path: "/api/students/{studentId}/records/{fieldId}/document",
  tags: [TAG],
  operationId: "updateStudentRecordDocument",
  summary: "Verify a document or set its expiry",
  description: "Marks the file verified (or withdraws that), and sets its expiry date.",
  security: [{ bearerAuth: [] }],
  request: {
    params: studentRecordFieldParamSchema,
    body: {
      required: true,
      content: { "application/json": { schema: updateRecordDocumentBodySchema } },
    },
  },
  responses: standardResponses(
    { 200: { description: "The record after the write.", schema: subjectRecordsSchema } },
    [400, 401, 403, 404, 409, 422, 429, 500],
  ),
});

const removeStudentRecordDocumentRoute = createRoute({
  method: "delete",
  path: "/api/students/{studentId}/records/{fieldId}/document",
  tags: [TAG],
  operationId: "removeStudentRecordDocument",
  summary: "Remove the file from a document field",
  description: "The field's status returns to missing and the stored file is deleted.",
  security: [{ bearerAuth: [] }],
  request: { params: studentRecordFieldParamSchema },
  responses: {
    204: { description: "File removed.", headers: requestIdHeaders },
    ...standardResponses({}, [401, 403, 404, 409, 429, 500]),
  },
});

const downloadStudentRecordDocumentRoute = createRoute({
  method: "get",
  path: "/api/students/{studentId}/records/{fieldId}/document/download",
  tags: [TAG],
  operationId: "downloadStudentRecordDocument",
  summary: "Get a download URL for a document",
  description: DOWNLOAD_DESCRIPTION,
  security: [{ bearerAuth: [] }],
  request: { params: studentRecordFieldParamSchema },
  responses: standardResponses(
    { 200: { description: "The download URL.", schema: recordDocumentDownloadSchema } },
    [401, 403, 404, 429, 500, 503],
  ),
});

const studentRecordRoutes = {
  get: getStudentRecordsRoute,
  put: updateStudentRecordsRoute,
  reveal: revealStudentRecordValueRoute,
  attach: attachStudentRecordDocumentRoute,
  updateDocument: updateStudentRecordDocumentRoute,
  removeDocument: removeStudentRecordDocumentRoute,
  download: downloadStudentRecordDocumentRoute,
};

const getParentRecordsRoute = createRoute({
  method: "get",
  path: "/api/parents/{parentUserId}/records",
  tags: [TAG],
  operationId: "getParentRecords",
  summary: "Get a parent's record",
  description:
    "Every field of the published form the caller may see, with its answer. Sensitive answers " +
    "come back masked (value null, mask set); see the reveal call." +
    " Leadership and finance only.",
  security: [{ bearerAuth: [] }],
  request: { params: parentRecordParamSchema },
  responses: standardResponses(
    { 200: { description: "The record.", schema: subjectRecordsSchema } },
    [401, 403, 404, 500],
  ),
});

const updateParentRecordsRoute = createRoute({
  method: "put",
  path: "/api/parents/{parentUserId}/records",
  tags: [TAG],
  operationId: "updateParentRecords",
  summary: "Fill in a parent's record",
  description: FILL_IN_DESCRIPTION,
  security: [{ bearerAuth: [] }],
  request: {
    params: parentRecordParamSchema,
    body: { required: true, content: { "application/json": { schema: updateRecordsBodySchema } } },
  },
  responses: standardResponses(
    { 200: { description: "The record after the write.", schema: subjectRecordsSchema } },
    [400, 401, 403, 404, 409, 422, 429, 500],
  ),
});

const revealParentRecordValueRoute = createRoute({
  method: "post",
  path: "/api/parents/{parentUserId}/records/{fieldId}/reveal",
  tags: [TAG],
  operationId: "revealParentRecordValue",
  summary: "Reveal a sensitive value",
  description: REVEAL_DESCRIPTION,
  security: [{ bearerAuth: [] }],
  request: { params: parentRecordFieldParamSchema },
  responses: standardResponses(
    { 200: { description: "The revealed value.", schema: revealedRecordValueSchema } },
    [401, 403, 404, 409, 429, 500, 503],
  ),
});

const attachParentRecordDocumentRoute = createRoute({
  method: "put",
  path: "/api/parents/{parentUserId}/records/{fieldId}/document",
  tags: [TAG],
  operationId: "attachParentRecordDocument",
  summary: "Attach the file for a document field",
  description: ATTACH_DESCRIPTION,
  security: [{ bearerAuth: [] }],
  request: {
    params: parentRecordFieldParamSchema,
    body: {
      required: true,
      content: { "application/json": { schema: attachRecordDocumentBodySchema } },
    },
  },
  responses: standardResponses(
    { 200: { description: "The record after the write.", schema: subjectRecordsSchema } },
    [400, 401, 403, 404, 409, 422, 429, 500, 503],
  ),
});

const updateParentRecordDocumentRoute = createRoute({
  method: "patch",
  path: "/api/parents/{parentUserId}/records/{fieldId}/document",
  tags: [TAG],
  operationId: "updateParentRecordDocument",
  summary: "Verify a document or set its expiry",
  description: "Marks the file verified (or withdraws that), and sets its expiry date.",
  security: [{ bearerAuth: [] }],
  request: {
    params: parentRecordFieldParamSchema,
    body: {
      required: true,
      content: { "application/json": { schema: updateRecordDocumentBodySchema } },
    },
  },
  responses: standardResponses(
    { 200: { description: "The record after the write.", schema: subjectRecordsSchema } },
    [400, 401, 403, 404, 409, 422, 429, 500],
  ),
});

const removeParentRecordDocumentRoute = createRoute({
  method: "delete",
  path: "/api/parents/{parentUserId}/records/{fieldId}/document",
  tags: [TAG],
  operationId: "removeParentRecordDocument",
  summary: "Remove the file from a document field",
  description: "The field's status returns to missing and the stored file is deleted.",
  security: [{ bearerAuth: [] }],
  request: { params: parentRecordFieldParamSchema },
  responses: {
    204: { description: "File removed.", headers: requestIdHeaders },
    ...standardResponses({}, [401, 403, 404, 409, 429, 500]),
  },
});

const downloadParentRecordDocumentRoute = createRoute({
  method: "get",
  path: "/api/parents/{parentUserId}/records/{fieldId}/document/download",
  tags: [TAG],
  operationId: "downloadParentRecordDocument",
  summary: "Get a download URL for a document",
  description: DOWNLOAD_DESCRIPTION,
  security: [{ bearerAuth: [] }],
  request: { params: parentRecordFieldParamSchema },
  responses: standardResponses(
    { 200: { description: "The download URL.", schema: recordDocumentDownloadSchema } },
    [401, 403, 404, 429, 500, 503],
  ),
});

const parentRecordRoutes = {
  get: getParentRecordsRoute,
  put: updateParentRecordsRoute,
  reveal: revealParentRecordValueRoute,
  attach: attachParentRecordDocumentRoute,
  updateDocument: updateParentRecordDocumentRoute,
  removeDocument: removeParentRecordDocumentRoute,
  download: downloadParentRecordDocumentRoute,
};

// ---------------------------------------------------------------------------
// Missing information
// ---------------------------------------------------------------------------

const listMissingStudentsRoute = createRoute({
  method: "get",
  path: "/api/records/missing/students",
  tags: [TAG],
  operationId: "listRecordMissingStudents",
  summary: "Students with missing information",
  description:
    "Current students missing a required field or document, or holding a document that has " +
    "expired or expires within 30 days. Field labels only, limited to fields the caller may see.",
  security: [{ bearerAuth: [] }],
  request: { query: recordMissingQuerySchema },
  responses: standardResponses(
    { 200: { description: "One page of students.", schema: recordMissingStudentListSchema } },
    [400, 401, 403, 500],
  ),
});

const listMissingParentsRoute = createRoute({
  method: "get",
  path: "/api/records/missing/parents",
  tags: [TAG],
  operationId: "listRecordMissingParents",
  summary: "Parents with missing information",
  description:
    "Parents missing a required field or document, or holding an expired or soon-expiring " +
    "document. Leadership and finance; anyone else gets an empty list.",
  security: [{ bearerAuth: [] }],
  request: { query: recordMissingQuerySchema },
  responses: standardResponses(
    { 200: { description: "One page of parents.", schema: recordMissingParentListSchema } },
    [400, 401, 403, 500],
  ),
});

const missingSummaryRoute = createRoute({
  method: "get",
  path: "/api/records/missing/summary",
  tags: [TAG],
  operationId: "getRecordMissingSummary",
  summary: "Missing information counts",
  description: "Counts for the dashboard tile.",
  security: [{ bearerAuth: [] }],
  responses: standardResponses(
    { 200: { description: "The counts.", schema: recordMissingSummarySchema } },
    [401, 403, 500],
  ),
});

// ---------------------------------------------------------------------------
// Route factory
// ---------------------------------------------------------------------------

const MUTATING = ["POST", "PUT", "PATCH", "DELETE"] as const;

export function recordRoutes(
  database: Database,
  storage: StorageService | null,
  keyring: RecordKeyring,
): OpenAPIHono<AppEnv> {
  const routes = new OpenAPIHono<AppEnv>({ defaultHook: openApiValidationHook });

  // --- Channel guard: every write is a web session's; reads also serve the mobile app ---
  const webOnly = onlyMethods(MUTATING, requireChannel(AUTH_CHANNELS.WEB));
  routes.use("/api/record-templates/*", requireChannel(AUTH_CHANNELS.WEB));
  routes.use("/api/record-forms/*", requireChannel(AUTH_CHANNELS.WEB));
  routes.use("/api/students/:studentId/records", webOnly);
  routes.use("/api/students/:studentId/records/*", webOnly);
  routes.use("/api/parents/:parentUserId/records", webOnly);
  routes.use("/api/parents/:parentUserId/records/*", webOnly);

  // --- Permission guards ---
  routes.use("/api/record-templates/*", requirePermission(PERMISSIONS.RECORD_TEMPLATE_MANAGE));
  // The create screens read the published form with update rights, not template rights.
  routes.use("/api/record-forms/*", requirePermission(PERMISSIONS.STUDENT_RECORD_UPDATE));
  const writes = onlyMethods(
    ["PUT", "PATCH", "DELETE"],
    requirePermission(PERMISSIONS.STUDENT_RECORD_UPDATE),
  );
  routes.use(
    "/api/students/:studentId/records",
    requirePermission(PERMISSIONS.STUDENT_RECORD_READ),
  );
  routes.use("/api/students/:studentId/records", writes);
  routes.use(
    "/api/students/:studentId/records/*",
    requirePermission(PERMISSIONS.STUDENT_RECORD_READ),
  );
  routes.use("/api/students/:studentId/records/*", writes);
  routes.use(
    "/api/students/:studentId/records/:fieldId/reveal",
    requirePermission(PERMISSIONS.STUDENT_RECORD_READ_SENSITIVE),
  );
  routes.use(
    "/api/parents/:parentUserId/records",
    requirePermission(PERMISSIONS.STUDENT_RECORD_READ),
  );
  routes.use("/api/parents/:parentUserId/records", writes);
  routes.use(
    "/api/parents/:parentUserId/records/*",
    requirePermission(PERMISSIONS.STUDENT_RECORD_READ),
  );
  routes.use("/api/parents/:parentUserId/records/*", writes);
  routes.use(
    "/api/parents/:parentUserId/records/:fieldId/reveal",
    requirePermission(PERMISSIONS.STUDENT_RECORD_READ_SENSITIVE),
  );
  routes.use("/api/records/missing/*", requirePermission(PERMISSIONS.STUDENT_RECORD_READ));

  // --- Audit declarations ---
  routes.use("/api/record-templates/:subjectKind/fields", auditAction("insert", "record_fields"));
  routes.use(
    "/api/record-templates/:subjectKind/fields/:fieldId",
    auditAction("update", "record_fields"),
  );
  routes.use(
    "/api/record-templates/:subjectKind/field-order",
    auditAction("update", "record_templates"),
  );
  routes.use(
    "/api/record-templates/:subjectKind/publish",
    auditAction("insert", "record_template_versions"),
  );
  routes.use("/api/students/:studentId/records", auditAction("update", "record_answers"));
  routes.use(
    "/api/students/:studentId/records/:fieldId/reveal",
    auditAction("read", "record_answers"),
  );
  routes.use(
    "/api/students/:studentId/records/:fieldId/document",
    auditAction("update", "record_documents"),
  );
  routes.use("/api/parents/:parentUserId/records", auditAction("update", "record_answers"));
  routes.use(
    "/api/parents/:parentUserId/records/:fieldId/reveal",
    auditAction("read", "record_answers"),
  );
  routes.use(
    "/api/parents/:parentUserId/records/:fieldId/document",
    auditAction("update", "record_documents"),
  );

  // --- Template editor handlers ---

  routes.openapi(getTemplateRoute, async (c) => {
    const { subjectKind } = c.req.valid("param");
    const template = await withTenantTx(database, tenantFrom(c), (tx) =>
      getTemplate(tx, tenantFrom(c).schoolId, subjectKind),
    );
    return c.json(template, 200);
  });

  routes.openapi(createFieldRoute, async (c) => {
    const { subjectKind } = c.req.valid("param");
    const tenant = tenantFrom(c);
    const field = await withTenantTx(database, tenant, (tx) =>
      createField(tx, tenant.schoolId, subjectKind, tenant.userId, c.req.valid("json")),
    );
    return c.json(field, 201);
  });

  routes.openapi(updateFieldRoute, async (c) => {
    const { subjectKind, fieldId } = c.req.valid("param");
    const tenant = tenantFrom(c);
    const field = await withTenantTx(database, tenant, (tx) =>
      updateField(tx, tenant.schoolId, subjectKind, fieldId, c.req.valid("json")),
    );
    return c.json(field, 200);
  });

  routes.openapi(reorderFieldsRoute, async (c) => {
    const { subjectKind } = c.req.valid("param");
    const tenant = tenantFrom(c);
    const template = await withTenantTx(database, tenant, (tx) =>
      reorderFields(tx, tenant.schoolId, subjectKind, c.req.valid("json").field_ids),
    );
    return c.json(template, 200);
  });

  routes.openapi(publishTemplateRoute, async (c) => {
    const { subjectKind } = c.req.valid("param");
    const tenant = tenantFrom(c);
    const version = await withTenantTx(database, tenant, (tx) =>
      publishTemplate(tx, tenant.schoolId, subjectKind, tenant.userId, keyring),
    );
    return c.json(version, 201);
  });

  routes.openapi(getFormRoute, async (c) => {
    const { subjectKind } = c.req.valid("param");
    const tenant = tenantFrom(c);
    const form = await withTenantTx(database, tenant, (tx) =>
      getRecordForm(tx, tenant.schoolId, subjectKind),
    );
    return c.json(form, 200);
  });

  // --- Subject record handlers ---

  for (const [kind, definitions] of [
    ["student", studentRecordRoutes],
    ["parent", parentRecordRoutes],
  ] as const) {
    const subjectFrom = (params: { studentId?: string; parentUserId?: string }): RecordSubject => ({
      kind,
      id: (kind === "student" ? params.studentId : params.parentUserId)!,
    });

    routes.openapi(definitions.get, async (c) => {
      const audience = audienceOf(c);
      const subject = subjectFrom(c.req.valid("param"));
      const records = await readTx(database, c, audience, (tx) =>
        getSubjectRecords(tx, tenantFrom(c).schoolId, subject, audience),
      );
      noStore(c);
      return c.json(records, 200);
    });

    routes.openapi(definitions.put, async (c) => {
      const tenant = tenantFrom(c);
      const subject = subjectFrom(c.req.valid("param"));
      const records = await withTenantTx(database, tenant, async (tx) => {
        await assertSubjectReadable(tx, tenant.schoolId, subject, "staff");
        await writeAnswers(
          tx,
          tenant.schoolId,
          subject,
          tenant.userId,
          c.req.valid("json").answers,
          keyring,
        );
        return getSubjectRecords(tx, tenant.schoolId, subject, "staff");
      });
      noStore(c);
      return c.json(records, 200);
    });

    routes.openapi(definitions.reveal, async (c) => {
      const tenant = tenantFrom(c);
      const params = c.req.valid("param");
      const revealed = await withTenantTx(database, tenant, (tx) =>
        revealValue(tx, tenant.schoolId, subjectFrom(params), params.fieldId, keyring),
      );
      noStore(c);
      return c.json(revealed, 200);
    });

    routes.openapi(definitions.attach, async (c) => {
      const tenant = tenantFrom(c);
      const params = c.req.valid("param");
      const store = requireStorage(storage);
      const subject = subjectFrom(params);
      const { records, replacedKey } = await withTenantTx(database, tenant, async (tx) => {
        const { replacedKey } = await attachDocument(
          tx,
          store,
          tenant.schoolId,
          subject,
          params.fieldId,
          tenant.userId,
          c.req.valid("json"),
        );
        return {
          records: await getSubjectRecords(tx, tenant.schoolId, subject, "staff"),
          replacedKey,
        };
      });
      await removeObject(store, replacedKey);
      noStore(c);
      return c.json(records, 200);
    });

    routes.openapi(definitions.updateDocument, async (c) => {
      const tenant = tenantFrom(c);
      const params = c.req.valid("param");
      const subject = subjectFrom(params);
      const records = await withTenantTx(database, tenant, async (tx) => {
        await updateDocument(
          tx,
          tenant.schoolId,
          subject,
          params.fieldId,
          tenant.userId,
          c.req.valid("json"),
        );
        return getSubjectRecords(tx, tenant.schoolId, subject, "staff");
      });
      noStore(c);
      return c.json(records, 200);
    });

    routes.openapi(definitions.removeDocument, async (c) => {
      const tenant = tenantFrom(c);
      const params = c.req.valid("param");
      const { removedKey } = await withTenantTx(database, tenant, (tx) =>
        removeDocument(tx, tenant.schoolId, subjectFrom(params), params.fieldId),
      );
      if (storage) await removeObject(storage, removedKey);
      return c.body(null, 204);
    });

    routes.openapi(definitions.download, async (c) => {
      const audience = audienceOf(c);
      const params = c.req.valid("param");
      const store = requireStorage(storage);
      const canReadSensitive = hasPermission(
        requireAuth(c).roles,
        PERMISSIONS.STUDENT_RECORD_READ_SENSITIVE,
      );
      // Finance never reaches a sensitive document (isFieldVisibleTo), so its identity
      // transaction, which carries no acting user, never writes the reveal audit row.
      const download = await readTx(database, c, audience, (tx) =>
        documentDownload(
          tx,
          store,
          tenantFrom(c).schoolId,
          subjectFrom(params),
          params.fieldId,
          audience,
          canReadSensitive,
        ),
      );
      noStore(c);
      return c.json(download, 200);
    });
  }

  // --- Missing information handlers ---

  routes.openapi(listMissingStudentsRoute, async (c) => {
    const audience = audienceOf(c);
    const list = await readTx(database, c, audience, (tx) =>
      listMissingStudents(tx, tenantFrom(c).schoolId, audience, c.req.valid("query")),
    );
    noStore(c);
    return c.json(list, 200);
  });

  routes.openapi(listMissingParentsRoute, async (c) => {
    const audience = audienceOf(c);
    const list = await readTx(database, c, audience, (tx) =>
      listMissingParents(tx, tenantFrom(c).schoolId, audience, c.req.valid("query")),
    );
    noStore(c);
    return c.json(list, 200);
  });

  routes.openapi(missingSummaryRoute, async (c) => {
    const audience = audienceOf(c);
    const summary = await readTx(database, c, audience, (tx) =>
      missingSummary(tx, tenantFrom(c).schoolId, audience),
    );
    noStore(c);
    return c.json(summary, 200);
  });

  return routes;
}
