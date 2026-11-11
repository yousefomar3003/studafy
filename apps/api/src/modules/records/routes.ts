import { createRoute, OpenAPIHono } from "@hono/zod-openapi";
import { ERROR_CODES, PERMISSIONS } from "@studafy/constants";

import { CodedHttpException } from "../../coded-http-exception";
import { setTenantScope, withSystemTx, withTenantTx } from "../../db/tenant-tx";
import { requireStorage } from "../../lib/storage";
import { enqueueUploadScans } from "../../lib/storage/upload-scan";
import { auditAction } from "../../middleware/auditEmitter";
import { requireAuth } from "../../middleware/authContext";
import { hasPermission, requirePermission, requirePermissionIn } from "../../middleware/authz";
import { requireChannel } from "../../middleware/channelGuard";
import { onlyMethods } from "../../middleware/only-methods";
import { openApiValidationHook } from "../../openapi/hook";
import { requestIdHeaders, standardResponses } from "../../openapi/responses";
import { AUTH_CHANNELS } from "../auth/channels";

import {
  listMissingClasses,
  listMissingParents,
  listMissingStaff,
  listMissingStudents,
  missingSummary,
} from "./missing-service";
import { applyRecordImportColumn, previewRecordImportColumn } from "./record-import-service";
import {
  SELF_STAFF_AUDIENCE,
  assertSubjectReadable,
  attachDocument,
  audienceForSubject,
  documentDownload,
  getRecordForm,
  getSubjectRecords,
  isSchoolStaff,
  removeDocument,
  revealValue,
  updateDocument,
  writeAnswers,
} from "./record-service";
import {
  applyRecordImportColumnBodySchema,
  attachRecordDocumentBodySchema,
  classRecordFieldParamSchema,
  classRecordParamSchema,
  createRecordFieldBodySchema,
  parentRecordFieldParamSchema,
  parentRecordParamSchema,
  recordDocumentDownloadSchema,
  recordFormSchema,
  recordImportApplyResultSchema,
  recordImportColumnBodySchema,
  recordImportParamSchema,
  recordImportPreviewSchema,
  recordMissingClassListSchema,
  recordMissingParentListSchema,
  recordMissingQuerySchema,
  recordMissingStaffListSchema,
  recordMissingStudentListSchema,
  recordMissingSummarySchema,
  recordTemplateFieldSchema,
  recordTemplateSchema,
  recordTemplateVersionSchema,
  reorderRecordFieldsBodySchema,
  revealedRecordValueSchema,
  selfRecordFieldParamSchema,
  staffRecordFieldParamSchema,
  staffRecordParamSchema,
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
import type { Permission } from "@studafy/constants";
import type { RecordAudience, RecordKeyring, RecordSubjectKind } from "@studafy/records";
import type { Context } from "hono";
import type { TransactionSql } from "postgres";

const TAG = "Student and parent records";
const STAFF_CLASS_TAG = "Staff and class records";

/** The permission that edits a subject's record (and its documents). */
const UPDATE_PERMISSION: Readonly<Record<RecordSubjectKind, Permission>> = {
  student: PERMISSIONS.STUDENT_RECORD_UPDATE,
  parent: PERMISSIONS.STUDENT_RECORD_UPDATE,
  staff: PERMISSIONS.STAFF_RECORD_UPDATE,
  class: PERMISSIONS.TIMETABLE_MANAGE,
};

/** The permission that reveals a sensitive value in full. Class fields are never sensitive. */
const READ_SENSITIVE_PERMISSION: Readonly<Record<RecordSubjectKind, Permission | null>> = {
  student: PERMISSIONS.STUDENT_RECORD_READ_SENSITIVE,
  parent: PERMISSIONS.STUDENT_RECORD_READ_SENSITIVE,
  staff: PERMISSIONS.STAFF_RECORD_READ_SENSITIVE,
  class: null,
};

function tenantFrom(c: Context<AppEnv>) {
  const auth = requireAuth(c);
  return { schoolId: auth.schoolId, userId: auth.userId, requestId: c.get("requestId") };
}

function audienceOf(c: Context<AppEnv>, kind: RecordSubjectKind = "student"): RecordAudience {
  const audience = audienceForSubject(kind, requireAuth(c).roles);
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
    "student or a parent. Needs the subject's update permission: studentRecord:update, " +
    "staffRecord:update for staff, timetable:manage for a class.",
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
// Staff and class record routes (the same calls; staff only can reveal: class fields are never
// sensitive)
// ---------------------------------------------------------------------------

const getStaffRecordsRoute = createRoute({
  method: "get",
  path: "/api/staff/{staffUserId}/records",
  tags: [STAFF_CLASS_TAG],
  operationId: "getStaffRecords",
  summary: "Get a staff member's record",
  description:
    "Every field of the published form the caller may see, with its answer. Needs " +
    "staffRecord:read. Whoever holds staffRecord:readSensitive (ORG_ADMIN) sees sensitive fields " +
    "masked (value null, mask set; see the reveal call); a PRINCIPAL does not see them at all. " +
    "The subject is a user holding a staff role.",
  security: [{ bearerAuth: [] }],
  request: { params: staffRecordParamSchema },
  responses: standardResponses(
    { 200: { description: "The record.", schema: subjectRecordsSchema } },
    [401, 403, 404, 500],
  ),
});

const updateStaffRecordsRoute = createRoute({
  method: "put",
  path: "/api/staff/{staffUserId}/records",
  tags: [STAFF_CLASS_TAG],
  operationId: "updateStaffRecords",
  summary: "Fill in a staff member's record",
  description: FILL_IN_DESCRIPTION,
  security: [{ bearerAuth: [] }],
  request: {
    params: staffRecordParamSchema,
    body: { required: true, content: { "application/json": { schema: updateRecordsBodySchema } } },
  },
  responses: standardResponses(
    { 200: { description: "The record after the write.", schema: subjectRecordsSchema } },
    [400, 401, 403, 404, 409, 422, 429, 500],
  ),
});

const revealStaffRecordValueRoute = createRoute({
  method: "post",
  path: "/api/staff/{staffUserId}/records/{fieldId}/reveal",
  tags: [STAFF_CLASS_TAG],
  operationId: "revealStaffRecordValue",
  summary: "Reveal a sensitive value",
  description:
    "The full value of one sensitive answer. Needs staffRecord:readSensitive, and every call is " +
    "audited: who, when, and which field.",
  security: [{ bearerAuth: [] }],
  request: { params: staffRecordFieldParamSchema },
  responses: standardResponses(
    { 200: { description: "The revealed value.", schema: revealedRecordValueSchema } },
    [401, 403, 404, 409, 429, 500, 503],
  ),
});

const attachStaffRecordDocumentRoute = createRoute({
  method: "put",
  path: "/api/staff/{staffUserId}/records/{fieldId}/document",
  tags: [STAFF_CLASS_TAG],
  operationId: "attachStaffRecordDocument",
  summary: "Attach the file for a document field",
  description:
    "Confirms a file staged through POST /api/storage/uploads/request-upload (content class " +
    "staffRecord.document, or staffRecord.sensitiveDocument for a sensitive field) and attaches " +
    "it, replacing any earlier file. The status becomes uploaded.",
  security: [{ bearerAuth: [] }],
  request: {
    params: staffRecordFieldParamSchema,
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

const updateStaffRecordDocumentRoute = createRoute({
  method: "patch",
  path: "/api/staff/{staffUserId}/records/{fieldId}/document",
  tags: [STAFF_CLASS_TAG],
  operationId: "updateStaffRecordDocument",
  summary: "Verify a document or set its expiry",
  description: "Marks the file verified (or withdraws that), and sets its expiry date.",
  security: [{ bearerAuth: [] }],
  request: {
    params: staffRecordFieldParamSchema,
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

const removeStaffRecordDocumentRoute = createRoute({
  method: "delete",
  path: "/api/staff/{staffUserId}/records/{fieldId}/document",
  tags: [STAFF_CLASS_TAG],
  operationId: "removeStaffRecordDocument",
  summary: "Remove the file from a document field",
  description: "The field's status returns to missing and the stored file is deleted.",
  security: [{ bearerAuth: [] }],
  request: { params: staffRecordFieldParamSchema },
  responses: {
    204: { description: "File removed.", headers: requestIdHeaders },
    ...standardResponses({}, [401, 403, 404, 409, 429, 500]),
  },
});

const downloadStaffRecordDocumentRoute = createRoute({
  method: "get",
  path: "/api/staff/{staffUserId}/records/{fieldId}/document/download",
  tags: [STAFF_CLASS_TAG],
  operationId: "downloadStaffRecordDocument",
  summary: "Get a download URL for a document",
  description:
    "A short-lived download URL. A sensitive document needs staffRecord:readSensitive, its URL " +
    "lives one minute, and issuing it is audited like a reveal.",
  security: [{ bearerAuth: [] }],
  request: { params: staffRecordFieldParamSchema },
  responses: standardResponses(
    { 200: { description: "The download URL.", schema: recordDocumentDownloadSchema } },
    [401, 403, 404, 429, 500, 503],
  ),
});

const staffRecordRoutes = {
  get: getStaffRecordsRoute,
  put: updateStaffRecordsRoute,
  reveal: revealStaffRecordValueRoute,
  attach: attachStaffRecordDocumentRoute,
  updateDocument: updateStaffRecordDocumentRoute,
  removeDocument: removeStaffRecordDocumentRoute,
  download: downloadStaffRecordDocumentRoute,
};

const getClassRecordsRoute = createRoute({
  method: "get",
  path: "/api/classes/{classId}/records",
  tags: [STAFF_CLASS_TAG],
  operationId: "getClassRecords",
  summary: "Get a class's record",
  description:
    "Every field of the published form the caller may see, with its answer. Needs " +
    "classRecord:read. Leadership reads every field; a teacher reads the teacher-visible fields " +
    "of the classes they teach, and nothing of any other class. Class fields are never sensitive.",
  security: [{ bearerAuth: [] }],
  request: { params: classRecordParamSchema },
  responses: standardResponses(
    { 200: { description: "The record.", schema: subjectRecordsSchema } },
    [401, 403, 404, 500],
  ),
});

const updateClassRecordsRoute = createRoute({
  method: "put",
  path: "/api/classes/{classId}/records",
  tags: [STAFF_CLASS_TAG],
  operationId: "updateClassRecords",
  summary: "Fill in a class's record",
  description: FILL_IN_DESCRIPTION,
  security: [{ bearerAuth: [] }],
  request: {
    params: classRecordParamSchema,
    body: { required: true, content: { "application/json": { schema: updateRecordsBodySchema } } },
  },
  responses: standardResponses(
    { 200: { description: "The record after the write.", schema: subjectRecordsSchema } },
    [400, 401, 403, 404, 409, 422, 429, 500],
  ),
});

const attachClassRecordDocumentRoute = createRoute({
  method: "put",
  path: "/api/classes/{classId}/records/{fieldId}/document",
  tags: [STAFF_CLASS_TAG],
  operationId: "attachClassRecordDocument",
  summary: "Attach the file for a document field",
  description:
    "Confirms a file staged through POST /api/storage/uploads/request-upload (content class " +
    "classRecord.document) and attaches it, replacing any earlier file. The status becomes " +
    "uploaded.",
  security: [{ bearerAuth: [] }],
  request: {
    params: classRecordFieldParamSchema,
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

const updateClassRecordDocumentRoute = createRoute({
  method: "patch",
  path: "/api/classes/{classId}/records/{fieldId}/document",
  tags: [STAFF_CLASS_TAG],
  operationId: "updateClassRecordDocument",
  summary: "Verify a document or set its expiry",
  description: "Marks the file verified (or withdraws that), and sets its expiry date.",
  security: [{ bearerAuth: [] }],
  request: {
    params: classRecordFieldParamSchema,
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

const removeClassRecordDocumentRoute = createRoute({
  method: "delete",
  path: "/api/classes/{classId}/records/{fieldId}/document",
  tags: [STAFF_CLASS_TAG],
  operationId: "removeClassRecordDocument",
  summary: "Remove the file from a document field",
  description: "The field's status returns to missing and the stored file is deleted.",
  security: [{ bearerAuth: [] }],
  request: { params: classRecordFieldParamSchema },
  responses: {
    204: { description: "File removed.", headers: requestIdHeaders },
    ...standardResponses({}, [401, 403, 404, 409, 429, 500]),
  },
});

const downloadClassRecordDocumentRoute = createRoute({
  method: "get",
  path: "/api/classes/{classId}/records/{fieldId}/document/download",
  tags: [STAFF_CLASS_TAG],
  operationId: "downloadClassRecordDocument",
  summary: "Get a download URL for a document",
  description: "A short-lived download URL.",
  security: [{ bearerAuth: [] }],
  request: { params: classRecordFieldParamSchema },
  responses: standardResponses(
    { 200: { description: "The download URL.", schema: recordDocumentDownloadSchema } },
    [401, 403, 404, 429, 500, 503],
  ),
});

const classRecordRoutes = {
  get: getClassRecordsRoute,
  put: updateClassRecordsRoute,
  attach: attachClassRecordDocumentRoute,
  updateDocument: updateClassRecordDocumentRoute,
  removeDocument: removeClassRecordDocumentRoute,
  download: downloadClassRecordDocumentRoute,
  reveal: null,
};

const getOwnStaffRecordRoute = createRoute({
  method: "get",
  path: "/api/me/staff-record",
  tags: [STAFF_CLASS_TAG],
  operationId: "getOwnStaffRecord",
  summary: "Get my own staff record",
  description:
    "The caller's own staff record: every field that is not sensitive, with its answer. For any " +
    "member of staff (ORG_ADMIN, PRINCIPAL, ATTENDANCE_OFFICER, FINANCE, INSTRUCTOR); no " +
    "permission beyond holding a staff role. Sensitive fields are not listed.",
  security: [{ bearerAuth: [] }],
  responses: standardResponses(
    { 200: { description: "The record.", schema: subjectRecordsSchema } },
    [401, 403, 500],
  ),
});

const downloadOwnStaffRecordDocumentRoute = createRoute({
  method: "get",
  path: "/api/me/staff-record/{fieldId}/document/download",
  tags: [STAFF_CLASS_TAG],
  operationId: "downloadOwnStaffRecordDocument",
  summary: "Get a download URL for one of my documents",
  description:
    "A short-lived download URL for a non-sensitive document on the caller's own record.",
  security: [{ bearerAuth: [] }],
  request: { params: selfRecordFieldParamSchema },
  responses: standardResponses(
    { 200: { description: "The download URL.", schema: recordDocumentDownloadSchema } },
    [401, 403, 404, 429, 500, 503],
  ),
});

// ---------------------------------------------------------------------------
// Imported columns kept as record fields
// ---------------------------------------------------------------------------

const RECORD_IMPORT_DESCRIPTION =
  "For one unknown column of the users (staff) or classes CSV import: the rows the import " +
  "created, by the id each create call returned, with the row's cell. Only subjects the caller " +
  "created in the last 24 hours are written (checked against the audit log), and for staff only " +
  "members of staff; any other row is skipped. Rows are never matched to anyone by a value. " +
  "Needs staffRecord:update (staff) or timetable:manage (class), and recordTemplate:manage to " +
  "create a new field.";

const previewRecordImportColumnRoute = createRoute({
  method: "post",
  path: "/api/record-imports/{subjectKind}/preview",
  tags: [STAFF_CLASS_TAG],
  operationId: "previewRecordImportColumn",
  summary: "Preview keeping an imported column as a record field",
  description:
    `${RECORD_IMPORT_DESCRIPTION} Writes nothing: returns what would be written, row by row ` +
    "(a sensitive value as its mask), a guessed type for a new field, and a token for the apply.",
  security: [{ bearerAuth: [] }],
  request: {
    params: recordImportParamSchema,
    body: {
      required: true,
      content: { "application/json": { schema: recordImportColumnBodySchema } },
    },
  },
  responses: standardResponses(
    { 200: { description: "What would be written.", schema: recordImportPreviewSchema } },
    [400, 401, 403, 404, 422, 429, 500],
  ),
});

const applyRecordImportColumnRoute = createRoute({
  method: "post",
  path: "/api/record-imports/{subjectKind}/apply",
  tags: [STAFF_CLASS_TAG],
  operationId: "applyRecordImportColumn",
  summary: "Keep an imported column as a record field",
  description:
    `${RECORD_IMPORT_DESCRIPTION} Writes exactly what the preview showed: the outcome is ` +
    "recomputed and must match the preview's token (409 IMPORT_COLUMN_PREVIEW_STALE). A new " +
    "field is created and published first, refused while the template has other unpublished " +
    "changes (409 IMPORT_RECORD_DRAFT_PENDING).",
  security: [{ bearerAuth: [] }],
  request: {
    params: recordImportParamSchema,
    body: {
      required: true,
      content: { "application/json": { schema: applyRecordImportColumnBodySchema } },
    },
  },
  responses: standardResponses(
    { 200: { description: "What was written.", schema: recordImportApplyResultSchema } },
    [400, 401, 403, 404, 409, 422, 429, 500],
  ),
});

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

const listMissingStaffRoute = createRoute({
  method: "get",
  path: "/api/records/missing/staff",
  tags: [STAFF_CLASS_TAG],
  operationId: "listRecordMissingStaff",
  summary: "Staff with missing information",
  description:
    "Members of staff missing a required field or document, or holding an expired or " +
    "soon-expiring document. Needs staffRecord:read; a PRINCIPAL's list leaves out sensitive " +
    "fields.",
  security: [{ bearerAuth: [] }],
  request: { query: recordMissingQuerySchema },
  responses: standardResponses(
    { 200: { description: "One page of staff.", schema: recordMissingStaffListSchema } },
    [400, 401, 403, 500],
  ),
});

const listMissingClassesRoute = createRoute({
  method: "get",
  path: "/api/records/missing/classes",
  tags: [STAFF_CLASS_TAG],
  operationId: "listRecordMissingClasses",
  summary: "Classes with missing information",
  description:
    "Planned and active classes missing a required field or document, or holding an expired or " +
    "soon-expiring document. Needs classRecord:read; a teacher sees the classes they teach and " +
    "their teacher-visible fields.",
  security: [{ bearerAuth: [] }],
  request: { query: recordMissingQuerySchema },
  responses: standardResponses(
    { 200: { description: "One page of classes.", schema: recordMissingClassListSchema } },
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
  routes.use("/api/staff/:staffUserId/records", webOnly);
  routes.use("/api/staff/:staffUserId/records/*", webOnly);
  routes.use("/api/classes/:classId/records", webOnly);
  routes.use("/api/classes/:classId/records/*", webOnly);
  routes.use("/api/record-imports/*", requireChannel(AUTH_CHANNELS.WEB));

  // --- Permission guards ---
  routes.use("/api/record-templates/*", requirePermission(PERMISSIONS.RECORD_TEMPLATE_MANAGE));
  // The create screens read the published form with update rights, not template rights. The
  // handler narrows a staff or class form to that subject's own update permission.
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
  // Staff records: read (non-sensitive for a principal), edit, reveal (ORG_ADMIN).
  const staffWrites = onlyMethods(
    ["PUT", "PATCH", "DELETE"],
    requirePermission(PERMISSIONS.STAFF_RECORD_UPDATE),
  );
  routes.use("/api/staff/:staffUserId/records", requirePermission(PERMISSIONS.STAFF_RECORD_READ));
  routes.use("/api/staff/:staffUserId/records", staffWrites);
  routes.use("/api/staff/:staffUserId/records/*", requirePermission(PERMISSIONS.STAFF_RECORD_READ));
  routes.use("/api/staff/:staffUserId/records/*", staffWrites);
  routes.use(
    "/api/staff/:staffUserId/records/:fieldId/reveal",
    requirePermission(PERMISSIONS.STAFF_RECORD_READ_SENSITIVE),
  );
  // Class records: read by leadership and the class's teachers, edited with timetable:manage.
  const classWrites = onlyMethods(
    ["PUT", "PATCH", "DELETE"],
    requirePermission(PERMISSIONS.TIMETABLE_MANAGE),
  );
  routes.use("/api/classes/:classId/records", requirePermission(PERMISSIONS.CLASS_RECORD_READ));
  routes.use("/api/classes/:classId/records", classWrites);
  routes.use("/api/classes/:classId/records/*", requirePermission(PERMISSIONS.CLASS_RECORD_READ));
  routes.use("/api/classes/:classId/records/*", classWrites);
  // Imported columns: the subject's own edit permission (template rights checked in the handler
  // when the column creates a field).
  routes.use("/api/record-imports/staff/*", requirePermission(PERMISSIONS.STAFF_RECORD_UPDATE));
  routes.use("/api/record-imports/class/*", requirePermission(PERMISSIONS.TIMETABLE_MANAGE));
  routes.use("/api/records/missing/students", requirePermission(PERMISSIONS.STUDENT_RECORD_READ));
  routes.use("/api/records/missing/parents", requirePermission(PERMISSIONS.STUDENT_RECORD_READ));
  routes.use("/api/records/missing/summary", requirePermission(PERMISSIONS.STUDENT_RECORD_READ));
  routes.use("/api/records/missing/staff", requirePermission(PERMISSIONS.STAFF_RECORD_READ));
  routes.use("/api/records/missing/classes", requirePermission(PERMISSIONS.CLASS_RECORD_READ));

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
  routes.use("/api/staff/:staffUserId/records", auditAction("update", "record_answers"));
  routes.use(
    "/api/staff/:staffUserId/records/:fieldId/reveal",
    auditAction("read", "record_answers"),
  );
  routes.use(
    "/api/staff/:staffUserId/records/:fieldId/document",
    auditAction("update", "record_documents"),
  );
  routes.use("/api/classes/:classId/records", auditAction("update", "record_answers"));
  routes.use(
    "/api/classes/:classId/records/:fieldId/document",
    auditAction("update", "record_documents"),
  );
  routes.use("/api/record-imports/:subjectKind/preview", auditAction("read", "record_answers"));
  routes.use("/api/record-imports/:subjectKind/apply", auditAction("insert", "record_answers"));

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
    requirePermissionIn(c, UPDATE_PERMISSION[subjectKind]);
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
    ["staff", staffRecordRoutes],
    ["class", classRecordRoutes],
  ] as const) {
    const subjectFrom = (params: Record<string, string>): RecordSubject => ({
      kind,
      id: (params.studentId ?? params.parentUserId ?? params.staffUserId ?? params.classId)!,
    });
    const paramsOf = (c: Context<AppEnv>) =>
      (c.req as unknown as { valid(target: "param"): Record<string, string> }).valid("param");

    routes.openapi(definitions.get, async (c) => {
      const audience = audienceOf(c, kind);
      const subject = subjectFrom(paramsOf(c));
      const records = await readTx(database, c, audience, (tx) =>
        getSubjectRecords(tx, tenantFrom(c).schoolId, subject, audience),
      );
      noStore(c);
      return c.json(records, 200);
    });

    routes.openapi(definitions.put, async (c) => {
      const tenant = tenantFrom(c);
      const subject = subjectFrom(paramsOf(c));
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

    if (definitions.reveal !== null) {
      routes.openapi(definitions.reveal, async (c) => {
        const tenant = tenantFrom(c);
        const params = paramsOf(c);
        const revealed = await withTenantTx(database, tenant, (tx) =>
          revealValue(tx, tenant.schoolId, subjectFrom(params), params.fieldId!, keyring),
        );
        noStore(c);
        return c.json(revealed, 200);
      });
    }

    routes.openapi(definitions.attach, async (c) => {
      const tenant = tenantFrom(c);
      const params = paramsOf(c);
      const store = requireStorage(storage);
      const subject = subjectFrom(params);
      const { records, replacedKey, storageKey } = await withTenantTx(
        database,
        tenant,
        async (tx) => {
          const { replacedKey, storageKey } = await attachDocument(
            tx,
            store,
            tenant.schoolId,
            subject,
            params.fieldId!,
            tenant.userId,
            c.req.valid("json"),
          );
          return {
            records: await getSubjectRecords(tx, tenant.schoolId, subject, "staff"),
            replacedKey,
            storageKey,
          };
        },
      );
      await removeObject(store, replacedKey);
      await enqueueUploadScans(c, [
        { target: "record_document", schoolId: tenant.schoolId, storageKey },
      ]);
      noStore(c);
      return c.json(records, 200);
    });

    routes.openapi(definitions.updateDocument, async (c) => {
      const tenant = tenantFrom(c);
      const params = paramsOf(c);
      const subject = subjectFrom(params);
      const records = await withTenantTx(database, tenant, async (tx) => {
        await updateDocument(
          tx,
          tenant.schoolId,
          subject,
          params.fieldId!,
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
      const params = paramsOf(c);
      const { removedKey } = await withTenantTx(database, tenant, (tx) =>
        removeDocument(tx, tenant.schoolId, subjectFrom(params), params.fieldId!),
      );
      if (storage) await removeObject(storage, removedKey);
      return c.body(null, 204);
    });

    routes.openapi(definitions.download, async (c) => {
      const audience = audienceOf(c, kind);
      const params = paramsOf(c);
      const store = requireStorage(storage);
      const sensitivePermission = READ_SENSITIVE_PERMISSION[kind];
      const canReadSensitive =
        sensitivePermission !== null && hasPermission(requireAuth(c).roles, sensitivePermission);
      // Finance never reaches a sensitive document (isFieldVisibleTo), so its identity
      // transaction, which carries no acting user, never writes the reveal audit row.
      const download = await readTx(database, c, audience, (tx) =>
        documentDownload(
          tx,
          store,
          tenantFrom(c).schoolId,
          subjectFrom(params),
          params.fieldId!,
          audience,
          canReadSensitive,
        ),
      );
      noStore(c);
      return c.json(download, 200);
    });
  }

  // --- A staff member's own record ---

  /** The caller as the subject of their own staff record, if they are on the school's staff. */
  const ownStaffSubject = (c: Context<AppEnv>): RecordSubject => {
    const auth = requireAuth(c);
    if (!isSchoolStaff(auth.roles)) {
      throw new CodedHttpException(403, ERROR_CODES.AUTHZ_FORBIDDEN, "Insufficient permissions");
    }
    return { kind: "staff", id: auth.userId };
  };

  routes.openapi(getOwnStaffRecordRoute, async (c) => {
    const subject = ownStaffSubject(c);
    const tenant = tenantFrom(c);
    const records = await withTenantTx(database, tenant, (tx) =>
      getSubjectRecords(tx, tenant.schoolId, subject, SELF_STAFF_AUDIENCE),
    );
    noStore(c);
    return c.json(records, 200);
  });

  routes.openapi(downloadOwnStaffRecordDocumentRoute, async (c) => {
    const subject = ownStaffSubject(c);
    const tenant = tenantFrom(c);
    const store = requireStorage(storage);
    const download = await withTenantTx(database, tenant, (tx) =>
      documentDownload(
        tx,
        store,
        tenant.schoolId,
        subject,
        c.req.valid("param").fieldId,
        SELF_STAFF_AUDIENCE,
        false,
      ),
    );
    noStore(c);
    return c.json(download, 200);
  });

  // --- Imported columns kept as record fields ---

  routes.openapi(previewRecordImportColumnRoute, async (c) => {
    const { subjectKind } = c.req.valid("param");
    const body = c.req.valid("json");
    if (body.new_field) requirePermissionIn(c, PERMISSIONS.RECORD_TEMPLATE_MANAGE);
    const tenant = tenantFrom(c);
    const preview = await withTenantTx(database, tenant, (tx) =>
      previewRecordImportColumn(tx, tenant.schoolId, subjectKind, body),
    );
    noStore(c);
    return c.json(preview, 200);
  });

  routes.openapi(applyRecordImportColumnRoute, async (c) => {
    const { subjectKind } = c.req.valid("param");
    const body = c.req.valid("json");
    if (body.new_field) requirePermissionIn(c, PERMISSIONS.RECORD_TEMPLATE_MANAGE);
    const tenant = tenantFrom(c);
    const result = await withTenantTx(database, tenant, (tx) =>
      applyRecordImportColumn(tx, tenant.schoolId, tenant.userId, subjectKind, body, keyring),
    );
    noStore(c);
    return c.json(result, 200);
  });

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

  routes.openapi(listMissingStaffRoute, async (c) => {
    const audience = audienceOf(c, "staff");
    const list = await withTenantTx(database, tenantFrom(c), (tx) =>
      listMissingStaff(tx, tenantFrom(c).schoolId, audience, c.req.valid("query")),
    );
    noStore(c);
    return c.json(list, 200);
  });

  routes.openapi(listMissingClassesRoute, async (c) => {
    const audience = audienceOf(c, "class");
    const list = await withTenantTx(database, tenantFrom(c), (tx) =>
      listMissingClasses(tx, tenantFrom(c).schoolId, audience, c.req.valid("query")),
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
