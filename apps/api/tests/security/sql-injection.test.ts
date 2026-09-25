/**
 * SQL injection probes against the free-text search and filter endpoints (ST-297).
 *
 * A sqlmap-style sweep over the full HTTP path: every endpoint that accepts free text is sent the
 * payload families sqlmap's techniques are built on — boolean-blind, error-based, UNION, stacked
 * queries, and time-blind — and each response is checked for the signal that technique relies on:
 *
 *   - boolean / UNION: a tautology that escaped into SQL returns rows the literal text cannot
 *     match. A canary user, student, and teacher whose names share nothing with any payload are
 *     seeded; seeing a canary id in a probe response is a finding. A positive control proves each
 *     canary *is* reachable by that endpoint and caller, so its absence means something.
 *   - error-based: a quote that broke out of a literal surfaces as a 500 or a Postgres parser
 *     message in the body.
 *   - time-blind: an executed pg_sleep(PROBE_SLEEP_SECONDS) cannot return in under that time, so the
 *     bound is exact rather than a tuned heuristic that CI load could trip.
 *   - stacked: a successful `; UPDATE …` would leave the canary display name behind; the table is
 *     read back after the sweep.
 *
 * Enum filters (status, role) are held to a stricter bar: an injection payload is not a valid enum
 * member, so request validation must reject it with 400 before any SQL runs.
 *
 * Out of scope: POST /api/ai/retrieval/search needs an embedding provider the harness does not
 * wire up; its keyword leg binds the query through the same websearch_to_tsquery(${query}) pattern.
 *
 *   TEST_DATABASE_URL=postgres://... bun test tests/security/sql-injection.test.ts
 */

import { ROLES } from "@studafy/constants";
// eslint-disable-next-line import-x/no-unresolved -- "bun:test" is a virtual Bun built-in with no resolvable file path
import { afterAll, beforeAll, describe, expect, test } from "bun:test";

import {
  authenticatedRequest,
  createFullTenant,
  createStudent,
  createTeacher,
  createTestApp,
  createTestDatabase,
  createUser,
  integrationEnabled,
  migrateDatabase,
} from "../harness";

import type { TestApp, TestAuthContext, TestDatabase } from "../harness";

const describeDb = integrationEnabled ? describe : describe.skip;

const PROBE_SLEEP_SECONDS = 5;
const STACKED_QUERY_MARKER = "sqli-stacked-canary";
const CANARY_SURNAME = "Quillfeather";
const CANARY_EMPLOYEE_NUMBER = "ZQ-CANARY-7";

/** One entry per sqlmap technique; each payload is shaped to escape both `'${x}'` and `'%${x}%'`. */
const INJECTION_PAYLOADS = {
  boolean: ["' OR '1'='1", "' OR 1=1--", "%' OR '%'='", "') OR ('1'='1", '" OR "1"="1'],
  error: [
    // A lone quote, prefixed so it clears /api/search's two-character minimum.
    "x'",
    "''''",
    "\\'",
    "' AND 1=CAST((SELECT version()) AS int)--",
    "'||(SELECT current_user)||'",
  ],
  union: [
    "' UNION SELECT NULL--",
    "' UNION ALL SELECT email, email, email FROM app.users--",
    "') UNION SELECT id::text FROM app.users--",
  ],
  stacked: [
    `'; UPDATE app.users SET display_name = '${STACKED_QUERY_MARKER}'--`,
    `%'; UPDATE app.users SET display_name = '${STACKED_QUERY_MARKER}'; --`,
  ],
  time: [
    `'; SELECT pg_sleep(${PROBE_SLEEP_SECONDS})--`,
    `' AND 1=(SELECT 1 FROM pg_sleep(${PROBE_SLEEP_SECONDS}))--`,
    `' || (SELECT pg_sleep(${PROBE_SLEEP_SECONDS}))::text || '`,
    `$$; SELECT pg_sleep(${PROBE_SLEEP_SECONDS}); $$`,
  ],
} as const;

const ALL_PAYLOADS = Object.values(INJECTION_PAYLOADS).flat();

/** Messages Postgres (or postgres.js) emits when SQL text, rather than a value, went wrong. */
const DATABASE_ERROR_SIGNATURE =
  /syntax error at or near|unterminated quoted|invalid input syntax|does not exist|SQLSTATE|PostgresError/i;

const FREE_TEXT_ENDPOINTS = [
  "/api/search?q=",
  "/api/users?search=",
  "/api/students?search=",
  "/api/teachers?search=",
  "/api/families?search=",
  "/api/invitations?search=",
  "/api/finance/invoices?search=",
];

const ENUM_FILTER_ENDPOINTS = [
  "/api/users?status=",
  "/api/users?role=",
  "/api/students?status=",
  "/api/invitations?status=",
  "/api/finance/invoices?status=",
];

interface Canaries {
  ids: string[];
  /** Each endpoint whose data includes a canary, with the literal search that must find it. */
  positiveControls: { url: string; expectedId: string }[];
}

let database: TestDatabase | undefined;
let harness: TestApp | undefined;
let auth: TestAuthContext;
let canaries: Canaries;

beforeAll(async () => {
  if (!integrationEnabled) return;
  database = await createTestDatabase();
  await migrateDatabase(database.url);
  const created = createTestApp({ database: database.sql });
  await created.ready;
  harness = created;

  const fixture = await createFullTenant(database.sql);
  // The web channel: user/student admin routes refuse the default API-client channel.
  auth = {
    schoolId: fixture.schoolId,
    userId: fixture.users.ORG_ADMIN.id,
    roles: [ROLES.ORG_ADMIN],
    channel: "web",
  };

  const user = await createUser(database.sql, fixture.schoolId, {
    displayName: `Zephyrine ${CANARY_SURNAME}`,
  });
  const student = await createStudent(database.sql, fixture.schoolId, {
    firstName: "Zephyrine",
    lastName: CANARY_SURNAME,
  });
  const teacher = await createTeacher(database.sql, fixture.schoolId, {
    employeeNumber: CANARY_EMPLOYEE_NUMBER,
  });

  canaries = {
    ids: [user.id, student.id, student.userId, teacher.id, teacher.userId],
    positiveControls: [
      { url: `/api/users?search=${CANARY_SURNAME}`, expectedId: user.id },
      { url: `/api/students?search=${CANARY_SURNAME}`, expectedId: student.id },
      { url: `/api/teachers?search=${CANARY_EMPLOYEE_NUMBER}`, expectedId: teacher.id },
      { url: `/api/search?q=${CANARY_SURNAME}`, expectedId: student.id },
    ],
  };
}, 60_000);

afterAll(async () => {
  harness?.keyStore.destroy();
  await database?.cleanup();
});

interface ProbeResponse {
  status: number;
  body: string;
  elapsedMs: number;
}

async function probe(url: string): Promise<ProbeResponse> {
  const startedAt = performance.now();
  const res = await authenticatedRequest(harness!, "GET", url, auth);
  const body = await res.text();
  return { status: res.status, body, elapsedMs: performance.now() - startedAt };
}

/** Every injection signal one response shows; an empty list is a clean probe. */
function injectionFindings(response: ProbeResponse): string[] {
  const findings: string[] = [];
  if (response.status !== 200) {
    findings.push(`status ${response.status}: ${response.body.slice(0, 300)}`);
  }
  if (DATABASE_ERROR_SIGNATURE.test(response.body)) {
    findings.push("database error text in response body");
  }
  if (canaries.ids.some((id) => response.body.includes(id))) {
    findings.push("returned a canary row the literal text cannot match");
  }
  if (response.elapsedMs >= PROBE_SLEEP_SECONDS * 1000) {
    findings.push(`took ${Math.round(response.elapsedMs)}ms (>= pg_sleep duration)`);
  }
  return findings;
}

describeDb("SQL injection probes", () => {
  test("positive controls: every canary is reachable by a literal search", async () => {
    for (const control of canaries.positiveControls) {
      const response = await probe(control.url);
      expect(`${control.url} -> ${response.status}`).toBe(`${control.url} -> 200`);
      expect(response.body).toContain(control.expectedId);
    }
  });

  test.each(FREE_TEXT_ENDPOINTS)(
    "free-text %s: no payload family produces an injection signal",
    async (endpoint) => {
      const findings: string[] = [];
      for (const payload of ALL_PAYLOADS) {
        const response = await probe(`${endpoint}${encodeURIComponent(payload)}`);
        for (const finding of injectionFindings(response)) {
          findings.push(`${JSON.stringify(payload)}: ${finding}`);
        }
      }
      // Asserted as a list so a regression reports every failing payload at once, scanner-style.
      expect(findings).toEqual([]);
    },
    120_000,
  );

  test.each(ENUM_FILTER_ENDPOINTS)(
    "enum filter %s: injection payloads are rejected by validation",
    async (endpoint) => {
      const statuses = new Set<number>();
      for (const payload of ALL_PAYLOADS) {
        const response = await probe(`${endpoint}${encodeURIComponent(payload)}`);
        statuses.add(response.status);
        expect(response.body).not.toMatch(DATABASE_ERROR_SIGNATURE);
      }
      expect([...statuses]).toEqual([400]);
    },
    120_000,
  );

  test("stacked-query payloads left no side effect", async () => {
    // Runs as the test database's owner, which bypasses RLS, so this sees every tenant's rows.
    const [row] = await database!.sql<{ count: number }[]>`
      SELECT count(*)::int AS count FROM app.users WHERE display_name = ${STACKED_QUERY_MARKER}
    `;
    expect(row!.count).toBe(0);
  });
});
