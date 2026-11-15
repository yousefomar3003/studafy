/**
 * QA-001: every API operation either makes a permission decision, or says in writing why not.
 *
 * permission-guard-coverage.test.ts checks *files*: a route file passes as soon as
 * `requirePermission(` appears anywhere in it. That let whole routes ship with no guard -- the
 * learning-material writes (QA-008), `POST /api/finance/expenses/{id}/attachments` (Hono's
 * `:expenseId` matches one segment, so the guard mounted on `/api/finance/expenses/:expenseId`
 * never ran for it; QA-011) and the two school checkouts (QA-013).
 *
 * This test checks *routes*, by behaviour instead of by text. `observePermissionChecks` hears every
 * permission decision the app makes -- the `requirePermission` middleware, `requirePermissionIn` in a
 * handler, or a handler's own `hasPermission` branch all funnel through `hasPermission`. Each
 * operation of the live OpenAPI document (`buildOpenApiDocument()`, the same one openapi.json is
 * generated from) is sent through the real app as an ORG_ADMIN, first with an empty body and then
 * with a body synthesised from its own request schema (so a check that runs after validation is
 * still reached), on the web and the mobile channel. An operation that never triggers a decision
 * must be one of:
 *
 *   - public by declaration (`security: []`: sign-in, registration, webhooks, health);
 *   - in GUARD_EXEMPT, with the reason it needs no permission (self-service on the caller's own
 *     rows, a role or self gate, an object-level check) -- a reviewed, enumerable list;
 *   - in KNOWN_UNGUARDED, a finding with an open QA task. Fixing it means deleting the entry.
 *
 * Both lists are kept tight: an exempt or known-unguarded operation that starts making a permission
 * decision fails the test until its entry is removed.
 *
 * Requires a live PostgreSQL instance, gated on TEST_DATABASE_URL:
 *
 *   TEST_DATABASE_URL=postgres://... bun test tests/security/route-guard-coverage.test.ts
 */

// Imported before src/middleware -- see the note at the top of tests/auth/support.ts.
import "@hono/zod-openapi";

import { PERMISSIONS, ROLES } from "@studafy/constants";
// eslint-disable-next-line import-x/no-unresolved -- "bun:test" is a virtual Bun built-in
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { Hono } from "hono";

import { createApp } from "../../src/app";
import { resetSecurityConfig } from "../../src/config/security";
import { createInflightTracker } from "../../src/lifecycle";
import { createLogger } from "../../src/logger";
import {
  observePermissionChecks,
  requirePermission,
  requirePermissionIn,
} from "../../src/middleware/authz";
import { KeyStore } from "../../src/modules/auth";
import { buildOpenApiDocument } from "../../src/openapi/document";
import { createRedisClient } from "../../src/redis";
import {
  appDatabaseFor,
  createFullTenant,
  createTestDatabase,
  integrationEnabled,
  migrateDatabase,
  mintTestToken,
  TEST_JWT_AUDIENCE,
  TEST_JWT_ISSUER,
} from "../harness";
import { fakeStorage } from "../harness/fake-storage";
import { FakeStripeProvider } from "../mocks/fake-stripe-provider";

import type { AppEnv } from "../../src/middleware";
import type { AuthContext } from "../../src/middleware/authContext";
import type { LlmProvider } from "../../src/modules/ai/llm/provider";
import type { RedisClient } from "../../src/redis";
import type { TenantFixture, TestDatabase } from "../harness";
import type { OpenAPIHono } from "@hono/zod-openapi";

// Redis too: the AI routes (and the entitlement/feature gates in front of them) are only mounted
// when the app has Redis, and an unmounted route would read as "no permission decision".
const redisUrl = process.env.TEST_REDIS_URL;
const describeDb = integrationEnabled && redisUrl ? describe : describe.skip;
if (integrationEnabled && !redisUrl && process.env.REQUIRE_DB_TESTS === "1") {
  throw new Error("route-guard-coverage needs TEST_REDIS_URL as well as TEST_DATABASE_URL");
}

// ---------------------------------------------------------------------------
// The two reviewed lists
// ---------------------------------------------------------------------------

/**
 * Operations that are authenticated but make no permission decision, by design. Each reason says
 * what authorises the caller instead. Keep the categories honest: "own rows" means the handler only
 * ever reads or writes rows keyed by the caller's own user id (and RLS enforces it).
 */
const GUARD_EXEMPT: Record<string, string> = {
  "DELETE /api/account/deletion":
    "own rows: acts only on the caller's own records, keyed by the token's user id (RLS-enforced)",
  "POST /api/account/deletion":
    "own rows: acts only on the caller's own records, keyed by the token's user id (RLS-enforced)",
  "POST /api/account/legal-acceptance":
    "own rows: acts only on the caller's own records, keyed by the token's user id (RLS-enforced)",
  "GET /api/account/profile":
    "own rows: acts only on the caller's own records, keyed by the token's user id (RLS-enforced)",
  "GET /api/ai/admin/metrics":
    "role gate: handler admits SUPER_ADMIN only (ai/routes/metrics-routes.ts)",
  "DELETE /api/ai/consent":
    "own rows: acts only on the caller's own records, keyed by the token's user id (RLS-enforced)",
  "GET /api/ai/consent":
    "own rows: acts only on the caller's own records, keyed by the token's user id (RLS-enforced)",
  "PUT /api/ai/consent":
    "own rows: acts only on the caller's own records, keyed by the token's user id (RLS-enforced)",
  "POST /api/ai/students/{studentId}/ask":
    "self gate: aiStudentSelfGate (app.ts) admits only the student whose id is in the path; staff and parents get 403",
  "POST /api/ai/students/{studentId}/concepts":
    "self gate: aiStudentSelfGate (app.ts) admits only the student whose id is in the path; staff and parents get 403",
  "GET /api/ai/students/{studentId}/conversations":
    "self gate: aiStudentSelfGate (app.ts) admits only the student whose id is in the path; staff and parents get 403",
  "GET /api/ai/students/{studentId}/conversations/{conversationId}":
    "self gate: aiStudentSelfGate (app.ts) admits only the student whose id is in the path; staff and parents get 403",
  "POST /api/ai/students/{studentId}/decks":
    "self gate: aiStudentSelfGate (app.ts) admits only the student whose id is in the path; staff and parents get 403",
  "GET /api/ai/students/{studentId}/decks/{deckId}/review":
    "self gate: aiStudentSelfGate (app.ts) admits only the student whose id is in the path; staff and parents get 403",
  "POST /api/ai/students/{studentId}/decks/{deckId}/review":
    "self gate: aiStudentSelfGate (app.ts) admits only the student whose id is in the path; staff and parents get 403",
  "POST /api/ai/students/{studentId}/exams":
    "self gate: aiStudentSelfGate (app.ts) admits only the student whose id is in the path; staff and parents get 403",
  "GET /api/ai/students/{studentId}/exams/{examId}":
    "self gate: aiStudentSelfGate (app.ts) admits only the student whose id is in the path; staff and parents get 403",
  "POST /api/ai/students/{studentId}/exams/{examId}/start":
    "self gate: aiStudentSelfGate (app.ts) admits only the student whose id is in the path; staff and parents get 403",
  "POST /api/ai/students/{studentId}/exams/{examId}/submit":
    "self gate: aiStudentSelfGate (app.ts) admits only the student whose id is in the path; staff and parents get 403",
  "POST /api/ai/students/{studentId}/explain":
    "self gate: aiStudentSelfGate (app.ts) admits only the student whose id is in the path; staff and parents get 403",
  "POST /api/ai/students/{studentId}/generate":
    "self gate: aiStudentSelfGate (app.ts) admits only the student whose id is in the path; staff and parents get 403",
  "POST /api/ai/students/{studentId}/messages/{messageId}/report":
    "self gate: aiStudentSelfGate (app.ts) admits only the student whose id is in the path; staff and parents get 403",
  "POST /api/ai/students/{studentId}/quizzes":
    "self gate: aiStudentSelfGate (app.ts) admits only the student whose id is in the path; staff and parents get 403",
  "POST /api/ai/students/{studentId}/quizzes/{quizId}/grade":
    "self gate: aiStudentSelfGate (app.ts) admits only the student whose id is in the path; staff and parents get 403",
  "POST /api/ai/students/{studentId}/reports":
    "self gate: aiStudentSelfGate (app.ts) admits only the student whose id is in the path; staff and parents get 403",
  "POST /api/ai/students/{studentId}/search":
    "self gate: aiStudentSelfGate (app.ts) admits only the student whose id is in the path; staff and parents get 403",
  "POST /api/ai/students/{studentId}/summarize":
    "self gate: aiStudentSelfGate (app.ts) admits only the student whose id is in the path; staff and parents get 403",
  "GET /api/ai/usage":
    "caller context: describes the caller's own school, session or entitlement, or public-to-all-members data",
  "GET /api/auth/devices":
    "own rows: acts only on the caller's own records, keyed by the token's user id (RLS-enforced)",
  "POST /api/auth/devices":
    "own rows: acts only on the caller's own records, keyed by the token's user id (RLS-enforced)",
  "DELETE /api/auth/devices/{deviceId}":
    "own rows: acts only on the caller's own records, keyed by the token's user id (RLS-enforced)",
  "DELETE /api/auth/devices/{deviceId}/sessions":
    "own rows: acts only on the caller's own records, keyed by the token's user id (RLS-enforced)",
  "POST /api/auth/guardian/children/{studentId}/session":
    "relationship gate: guardian-session-service requires the caller to be a linked guardian of the child",
  "POST /api/auth/password/change":
    "own rows: acts only on the caller's own records, keyed by the token's user id (RLS-enforced)",
  "GET /api/auth/providers":
    "own rows: acts only on the caller's own records, keyed by the token's user id (RLS-enforced)",
  "POST /api/auth/providers/link/start":
    "own rows: acts only on the caller's own records, keyed by the token's user id (RLS-enforced)",
  "DELETE /api/auth/providers/{provider}":
    "own rows: acts only on the caller's own records, keyed by the token's user id (RLS-enforced)",
  "GET /api/auth/sessions":
    "own rows: acts only on the caller's own records, keyed by the token's user id (RLS-enforced)",
  "POST /api/auth/sessions/revoke-others":
    "own rows: acts only on the caller's own records, keyed by the token's user id (RLS-enforced)",
  "DELETE /api/auth/sessions/{sessionId}":
    "own rows: acts only on the caller's own records, keyed by the token's user id (RLS-enforced)",
  "GET /api/finance/online-payments/{paymentId}":
    "object gate: visible only to the payer, or to BILLING_READ holders, checked once the row is found; anyone else gets the same 404 (online-payments/service.ts)",
  "POST /api/finance/reconciliation/run":
    "machine gate: X-Api-Key must equal RECONCILIATION_API_KEY (finance/jobs/reconciliation.routes.ts); no user permission applies",
  "GET /api/invitations":
    "role gate: handler admits only SUPER_ADMIN or ORG_ADMIN (auth/invitation/route.ts), not via the permission matrix",
  "POST /api/invitations":
    "role gate: handler admits only SUPER_ADMIN or ORG_ADMIN (auth/invitation/route.ts), not via the permission matrix",
  "POST /api/invitations/{id}/regenerate":
    "role gate: handler admits only SUPER_ADMIN or ORG_ADMIN (auth/invitation/route.ts), not via the permission matrix",
  "POST /api/invitations/{id}/revoke":
    "role gate: handler admits only SUPER_ADMIN or ORG_ADMIN (auth/invitation/route.ts), not via the permission matrix",
  "GET /api/me/features":
    "own rows: acts only on the caller's own records, keyed by the token's user id (RLS-enforced)",
  "GET /api/me/staff-record":
    "own rows: acts only on the caller's own records, keyed by the token's user id (RLS-enforced)",
  "GET /api/me/staff-record/{fieldId}/document/download":
    "own rows: acts only on the caller's own records, keyed by the token's user id (RLS-enforced)",
  "GET /api/notification-preferences":
    "own rows: acts only on the caller's own records, keyed by the token's user id (RLS-enforced)",
  "PATCH /api/notification-preferences":
    "own rows: acts only on the caller's own records, keyed by the token's user id (RLS-enforced)",
  "GET /api/notification-preferences/quiet-hours":
    "own rows: acts only on the caller's own records, keyed by the token's user id (RLS-enforced)",
  "PUT /api/notification-preferences/quiet-hours":
    "own rows: acts only on the caller's own records, keyed by the token's user id (RLS-enforced)",
  "GET /api/notifications":
    "own rows: acts only on the caller's own records, keyed by the token's user id (RLS-enforced)",
  "POST /api/notifications/read-all":
    "own rows: acts only on the caller's own records, keyed by the token's user id (RLS-enforced)",
  "POST /api/notifications/test":
    "own rows: acts only on the caller's own records, keyed by the token's user id (RLS-enforced)",
  "GET /api/notifications/unread-count":
    "own rows: acts only on the caller's own records, keyed by the token's user id (RLS-enforced)",
  "POST /api/notifications/{notificationId}/read":
    "own rows: acts only on the caller's own records, keyed by the token's user id (RLS-enforced)",
  "GET /api/platform-banners":
    "caller context: describes the caller's own school, session or entitlement, or public-to-all-members data",
  "GET /api/privacy/me/dsr":
    "own rows: acts only on the caller's own records, keyed by the token's user id (RLS-enforced)",
  "POST /api/privacy/me/dsr":
    "own rows: acts only on the caller's own records, keyed by the token's user id (RLS-enforced)",
  "GET /api/realtime/ticket":
    "caller context: describes the caller's own school, session or entitlement, or public-to-all-members data",
  "GET /api/schools/current":
    "caller context: describes the caller's own school, session or entitlement, or public-to-all-members data",
  "GET /api/students/me":
    "own rows: acts only on the caller's own records, keyed by the token's user id (RLS-enforced)",
  "POST /api/subscriptions/ai/checkout":
    "relationship gate: the student must be the caller or the caller's linked child, and enrolled (checkout-service.ts)",
  "GET /api/subscriptions/ai/offer":
    "caller context: describes the caller's own school, session or entitlement, or public-to-all-members data",
  "GET /api/subscriptions/ai/refund-requests":
    "own rows: acts only on the caller's own records, keyed by the token's user id (RLS-enforced)",
  "POST /api/subscriptions/ai/refund-requests":
    "own rows: acts only on the caller's own records, keyed by the token's user id (RLS-enforced)",
  "GET /api/subscriptions/ai/store/config":
    "caller context: describes the caller's own school, session or entitlement, or public-to-all-members data",
  "POST /api/subscriptions/ai/store/purchases":
    "own rows: registers the calling student's own store purchase (store/routes.ts)",
  "GET /api/teachers/me":
    "own rows: acts only on the caller's own records, keyed by the token's user id (RLS-enforced)",
};

/** Findings: operations that should make a permission decision and don't. Value = the QA task. */
const KNOWN_UNGUARDED: Record<string, string> = {
  // QA-008: material writes have no permission or ownership check; reads should require MATERIAL_READ.
  // QA-011: Hono's :expenseId matches one segment, so the expense guard never runs for /attachments.
  // QA-013: the school-plan checkouts only check the web channel.
  // QA-086: RLS-scoped academic and attendance reads with no explicit permission gate (no other
  //         minors' PII today; defence in depth).
  "GET /api/academics/classes": "QA-086",
  "GET /api/academics/classes/{classId}": "QA-086",
  "GET /api/academics/classes/{classId}/ai-materials": "QA-086",
  "GET /api/academics/classes/{classId}/enrollments": "QA-086",
  "GET /api/academics/courses/{courseId}": "QA-086",
  "GET /api/academics/exams": "QA-086",
  "GET /api/academics/exams/{examId}": "QA-086",
  "GET /api/academics/grade-levels": "QA-086",
  "GET /api/academics/materials": "QA-008",
  "POST /api/academics/materials/upload": "QA-008",
  "DELETE /api/academics/materials/{materialId}": "QA-008",
  "GET /api/academics/materials/{materialId}": "QA-008",
  "PATCH /api/academics/materials/{materialId}": "QA-008",
  "PATCH /api/academics/materials/{materialId}/ai-visible": "QA-008",
  "POST /api/academics/materials/{materialId}/confirm": "QA-008",
  "GET /api/academics/rooms": "QA-086",
  "GET /api/academics/sections": "QA-086",
  "GET /api/academics/sections/{sectionId}": "QA-086",
  "GET /api/academics/slots/{slotId}": "QA-086",
  "GET /api/academics/subjects": "QA-086",
  "GET /api/academics/subjects/{subjectId}": "QA-086",
  "GET /api/academics/subjects/{subjectId}/courses": "QA-086",
  "GET /api/academics/terms/{termId}": "QA-086",
  "GET /api/academics/timetable-settings": "QA-086",
  "GET /api/academics/timetable-versions": "QA-086",
  "GET /api/academics/timetable-versions/{versionId}": "QA-086",
  "GET /api/academics/timetable-versions/{versionId}/slots": "QA-086",
  "GET /api/academics/years": "QA-086",
  "GET /api/academics/years/{yearId}": "QA-086",
  "GET /api/academics/years/{yearId}/terms": "QA-086",
  "GET /api/attendance/sessions": "QA-086",
  "GET /api/attendance/sessions/{sessionId}": "QA-086",
  "POST /api/finance/expenses/{expenseId}/attachments": "QA-011",
  "POST /api/subscriptions/checkout": "QA-013",
  "POST /api/subscriptions/school/checkout": "QA-013",
};

// ---------------------------------------------------------------------------
// Request synthesis
// ---------------------------------------------------------------------------

interface JsonSchema {
  $ref?: string;
  type?: string | string[];
  format?: string;
  enum?: unknown[];
  const?: unknown;
  properties?: Record<string, JsonSchema>;
  required?: string[];
  items?: JsonSchema;
  minItems?: number;
  minLength?: number;
  maxLength?: number;
  minimum?: number;
  exclusiveMinimum?: number;
  maximum?: number;
  pattern?: string;
  oneOf?: JsonSchema[];
  anyOf?: JsonSchema[];
  allOf?: JsonSchema[];
  default?: unknown;
  example?: unknown;
}

interface Operation {
  method: string;
  path: string;
  isPublic: boolean;
  parameters: { name: string; in: string; required?: boolean; schema?: JsonSchema }[];
  bodySchema: JsonSchema | undefined;
}

const PLACEHOLDER_UUID = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee";

function makeResolver(components: Record<string, JsonSchema>) {
  return function resolveRef(schema: JsonSchema): JsonSchema {
    if (!schema.$ref) return schema;
    const name = schema.$ref.split("/").pop()!;
    return components[name] ?? {};
  };
}

/** A minimal value the schema accepts: required properties only, smallest valid scalars. */
function synthesise(
  schema: JsonSchema | undefined,
  resolveRef: (s: JsonSchema) => JsonSchema,
  depth = 0,
): unknown {
  if (!schema || depth > 8) return undefined;
  const s = resolveRef(schema);
  if (s.const !== undefined) return s.const;
  if (s.example !== undefined) return s.example;
  if (s.default !== undefined) return s.default;
  if (s.enum?.length) return s.enum[0];
  if (s.allOf?.length) {
    return Object.assign(
      {},
      ...s.allOf.map((part) => synthesise(part, resolveRef, depth + 1) as object),
    );
  }
  const variants = s.oneOf ?? s.anyOf;
  if (variants?.length) {
    const firstNonNull = variants.find((v) => resolveRef(v).type !== "null") ?? variants[0]!;
    return synthesise(firstNonNull, resolveRef, depth + 1);
  }
  const type = Array.isArray(s.type) ? s.type.find((t) => t !== "null") : s.type;
  switch (type) {
    case "object":
    case undefined: {
      if (!s.properties) return type === "object" ? {} : undefined;
      const value: Record<string, unknown> = {};
      for (const key of s.required ?? []) {
        const child = s.properties[key];
        if (child) value[key] = synthesise(child, resolveRef, depth + 1);
      }
      return value;
    }
    case "array":
      return Array.from({ length: Math.max(1, s.minItems ?? 1) }, () =>
        synthesise(s.items, resolveRef, depth + 1),
      );
    case "integer":
    case "number": {
      const floor = s.exclusiveMinimum !== undefined ? s.exclusiveMinimum + 1 : (s.minimum ?? 1);
      return Math.min(Math.max(1, floor), s.maximum ?? Number.MAX_SAFE_INTEGER);
    }
    case "boolean":
      return false;
    case "string":
      return synthesiseString(s);
    default:
      return null;
  }
}

function synthesiseString(s: JsonSchema): string {
  switch (s.format) {
    case "uuid":
      return PLACEHOLDER_UUID;
    case "email":
      return "route-guard@probe.example";
    case "date":
      return "2026-09-01";
    case "date-time":
      return "2026-09-01T08:00:00.000Z";
    case "uri":
    case "url":
      return "https://studafy.example/return";
    default: {
      const base = "probe";
      const min = s.minLength ?? 1;
      const value = base.padEnd(min, "x");
      return s.maxLength !== undefined ? value.slice(0, Math.max(s.maxLength, 1)) : value;
    }
  }
}

function loadOperations(document: Record<string, unknown>): Operation[] {
  const paths = document.paths as Record<string, Record<string, Record<string, unknown>>>;
  const operations: Operation[] = [];
  for (const [path, item] of Object.entries(paths)) {
    for (const method of ["get", "post", "put", "patch", "delete"]) {
      const op = item[method];
      if (!op) continue;
      const security = op.security as unknown[] | undefined;
      const body = op.requestBody as
        { content?: Record<string, { schema?: JsonSchema }> } | undefined;
      operations.push({
        method: method.toUpperCase(),
        path,
        isPublic: Array.isArray(security) && security.length === 0,
        parameters: (op.parameters as Operation["parameters"] | undefined) ?? [],
        bodySchema: body?.content?.["application/json"]?.schema,
      });
    }
  }
  return operations;
}

// ---------------------------------------------------------------------------
// Probe
// ---------------------------------------------------------------------------

/** ROUTE_GUARD_DEBUG=1: record each attempt's status, printed for undecided operations. */
const DEBUG = process.env.ROUTE_GUARD_DEBUG === "1";
const attemptStatuses = new Map<string, string[]>();

let database: TestDatabase | undefined;
let app: OpenAPIHono<AppEnv>;
let keyStore: KeyStore | undefined;
let redis: RedisClient | undefined;
let tenant: TenantFixture;
let operations: Operation[] = [];
let resolveRef: (s: JsonSchema) => JsonSchema = (s) => s;

const PATH_OVERRIDES: Record<string, string> = {
  provider: "google",
  token: "placeholder-token",
  contentClass: "material",
  currencyCode: "USD",
  key: "placeholder",
  featureKey: "placeholder",
  flagName: "placeholder",
};

function buildUrl(op: Operation, synthesiseQuery: boolean): string {
  const path = op.path.replace(/\{([^}]+)\}/g, (_m, name: string) => {
    const param = op.parameters.find((p) => p.in === "path" && p.name === name);
    const fromSchema = param?.schema ? synthesise(param.schema, resolveRef) : undefined;
    return encodeURIComponent(
      PATH_OVERRIDES[name] ?? (typeof fromSchema === "string" ? fromSchema : PLACEHOLDER_UUID),
    );
  });
  if (!synthesiseQuery) return path;
  const query = new URLSearchParams();
  for (const param of op.parameters) {
    if (param.in !== "query" || !param.required) continue;
    query.set(param.name, String(synthesise(param.schema, resolveRef) ?? "probe"));
  }
  const qs = query.toString();
  return qs ? `${path}?${qs}` : path;
}

async function decides(
  op: Operation,
  channel: "web" | "mobile",
  body: unknown,
  synthesiseQuery: boolean,
): Promise<boolean> {
  const token = await mintTestToken(keyStore!, {
    schoolId: tenant.schoolId,
    userId: tenant.users[ROLES.ORG_ADMIN].id,
    roles: [ROLES.ORG_ADMIN],
    channel,
  });
  const headers: Record<string, string> = { Authorization: `Bearer ${token}` };
  const init: RequestInit = { method: op.method, headers };
  if (["POST", "PUT", "PATCH", "DELETE"].includes(op.method) && body !== undefined) {
    headers["Content-Type"] = "application/json";
    init.body = JSON.stringify(body);
  }
  let decided = false;
  observePermissionChecks(() => {
    decided = true;
  });
  try {
    const response = await app.request(buildUrl(op, synthesiseQuery), init);
    const text = await response.text();
    if (DEBUG) {
      const key = `${op.method} ${op.path}`;
      const code = /"code"\s*:\s*"([A-Z0-9_]+)"/.exec(text)?.[1] ?? "";
      attemptStatuses.set(key, [
        ...(attemptStatuses.get(key) ?? []),
        `${channel}${synthesiseQuery ? "+synth" : ""}=${response.status}${code ? `/${code}` : ""}`,
      ]);
    }
  } finally {
    observePermissionChecks(undefined);
  }
  return decided;
}

/** Whether any of the request variants for `op` led to a permission decision. */
async function makesPermissionDecision(op: Operation): Promise<boolean> {
  const synthesised = op.bodySchema ? (synthesise(op.bodySchema, resolveRef) ?? {}) : undefined;
  const empty = op.method === "GET" ? undefined : {};
  const attempts: ["web" | "mobile", unknown, boolean][] = [
    ["web", empty, false],
    ["mobile", empty, false],
    ["web", synthesised, true],
    ["mobile", synthesised, true],
  ];
  for (const [channel, body, withQuery] of attempts) {
    if (await decides(op, channel, body, withQuery)) return true;
  }
  return false;
}

beforeAll(async () => {
  if (!integrationEnabled) return;
  database = await createTestDatabase({ maxConnections: 8 });
  await migrateDatabase(database.url);
  tenant = await createFullTenant(database.sql);

  // Every optional integration the app mounts routes for is present, as stand-ins, so each route
  // is reachable: a route that is never mounted, or answers "not configured" before its guard,
  // would read as unguarded. None of them is ever actually called past its guard here.
  const logger = createLogger({ destination: () => undefined });
  redis = createRedisClient({ url: redisUrl!, logger });
  keyStore = new KeyStore(60_000);
  await keyStore.init();
  const unusedLlm: LlmProvider = {
    generate: () => Promise.reject(new Error("route-guard probe: LLM not available")),
    // eslint-disable-next-line require-yield -- never yields; fails on first pull
    async *stream() {
      throw new Error("route-guard probe: LLM not available");
    },
  };
  resetSecurityConfig();
  app = createApp({
    isReady: () => true,
    tracker: createInflightTracker(),
    logger,
    database: appDatabaseFor(database.sql),
    redis,
    keyStore,
    jwtIssuer: TEST_JWT_ISSUER,
    jwtAudience: TEST_JWT_AUDIENCE,
    rateLimitDisabled: true,
    realtimeTicketSecret: "route-guard-probe-ticket-secret-0123456789",
    aiLlmProvider: unusedLlm,
    storage: fakeStorage(),
    uploadScanEnqueuer: async () => undefined,
    stripeProvider: new FakeStripeProvider(),
  });

  const document = (await buildOpenApiDocument()) as unknown as Record<string, unknown>;
  const components = ((document.components as Record<string, unknown> | undefined)?.schemas ??
    {}) as Record<string, JsonSchema>;
  resolveRef = makeResolver(components);
  operations = loadOperations(document);
}, 120_000);

afterAll(async () => {
  observePermissionChecks(undefined);
  keyStore?.destroy();
  redis?.disconnect();
  await database?.cleanup();
});

describe("permission-decision observer (QA-001)", () => {
  // The coverage test below is only as good as its signal: prove the observer hears each guard form
  // and stays silent for a route without one.
  const fixture = new Hono<AppEnv>();
  fixture.use("*", async (c, next) => {
    c.set("auth", { userId: "u", schoolId: "s", roles: [ROLES.STUDENT] } as unknown as AuthContext);
    await next();
  });
  fixture.use("/middleware-guarded", requirePermission(PERMISSIONS.USER_CREATE));
  fixture.get("/middleware-guarded", (c) => c.text("ok"));
  fixture.get("/handler-guarded", (c) => {
    requirePermissionIn(c, PERMISSIONS.USER_CREATE);
    return c.text("ok");
  });
  fixture.get("/unguarded", (c) => c.text("ok"));

  async function observed(path: string): Promise<boolean> {
    let heard = false;
    observePermissionChecks(() => {
      heard = true;
    });
    try {
      await fixture.request(path);
    } finally {
      observePermissionChecks(undefined);
    }
    return heard;
  }

  test("hears the requirePermission middleware and an in-handler requirePermissionIn", async () => {
    expect(await observed("/middleware-guarded")).toBe(true);
    expect(await observed("/handler-guarded")).toBe(true);
  });

  test("stays silent for a route with no guard", async () => {
    expect(await observed("/unguarded")).toBe(false);
  });
});

describeDb("route guard coverage (QA-001)", () => {
  let undecided: string[] = [];

  test("enumerates the whole live API", async () => {
    // The live document, not openapi.json: a fresh checkout has no generated file.
    expect(operations.length).toBeGreaterThanOrEqual(690);
    const keys = new Set(operations.map((op) => `${op.method} ${op.path}`));
    expect(keys.size).toBe(operations.length);

    undecided = [];
    for (const op of operations) {
      if (op.isPublic) continue;
      if (!(await makesPermissionDecision(op))) undecided.push(`${op.method} ${op.path}`);
    }
    if (DEBUG) {
      for (const key of undecided)
        console.log(`UNDECIDED ${key} :: ${attemptStatuses.get(key)?.join(" ")}`);
    }
  }, 600_000);

  test("every authenticated operation without a permission decision is exempt or a known finding", () => {
    const unexplained = undecided.filter(
      (key) => !(key in GUARD_EXEMPT) && !(key in KNOWN_UNGUARDED),
    );
    if (unexplained.length > 0) {
      throw new Error(
        `${unexplained.length} authenticated operation(s) make no permission decision.\n` +
          "Guard them (requirePermission / requirePermissionIn), or add them to GUARD_EXEMPT with " +
          "the reason they need none:\n  " +
          unexplained.join("\n  "),
      );
    }
  });

  test("the exemption and known-finding lists hold no stale entries", () => {
    const declared = new Set(operations.map((op) => `${op.method} ${op.path}`));
    const undecidedSet = new Set(undecided);
    const stale = [...Object.keys(GUARD_EXEMPT), ...Object.keys(KNOWN_UNGUARDED)].filter(
      (key) => !declared.has(key) || !undecidedSet.has(key),
    );
    expect(stale).toEqual([]);
  });

  test("every exemption gives a reason and every known finding names its QA task", () => {
    for (const [key, reason] of Object.entries(GUARD_EXEMPT)) {
      expect(`${key}: ${reason.length >= 20}`).toBe(`${key}: true`);
    }
    for (const [key, task] of Object.entries(KNOWN_UNGUARDED)) {
      expect(`${key}: ${task}`).toMatch(/: QA-\d{3}$/);
    }
  });
});
