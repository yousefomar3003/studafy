/**
 * QA-041: a guarded route stays guarded under every spelling of its path.
 *
 * Studafy authorises with path-scoped middleware (`routes.use(path, requirePermission(...))`). Hono
 * advisories fixed in 4.13.x describe exactly that layer being skipped: "RegExpRouter skips wildcard
 * middleware for some route sets and for paths with an encoded line terminator", "mount() can
 * forward a path that bypasses middleware scoped inside the mount prefix", and "serveStatic decodes
 * the request path a second time". This sends each guarded route below under encoded, doubled,
 * trailing-slash and case variants, as a GUEST who holds none of the permissions involved, and
 * requires every answer to be a refusal or a not-found -- never a 2xx and never a 5xx.
 *
 * Requires a live PostgreSQL instance, gated on TEST_DATABASE_URL:
 *
 *   TEST_DATABASE_URL=postgres://... bun test tests/security/path-variant-guard.test.ts
 */

// Imported before src/middleware -- see the note at the top of tests/auth/support.ts.
import "@hono/zod-openapi";

import { ROLES } from "@studafy/constants";
// eslint-disable-next-line import-x/no-unresolved -- "bun:test" is a virtual Bun built-in
import { afterAll, beforeAll, describe, expect, test } from "bun:test";

import {
  createFullTenant,
  createTestApp,
  createTestDatabase,
  integrationEnabled,
  migrateDatabase,
  mintTestToken,
} from "../harness";

import type { TenantFixture, TestApp, TestDatabase } from "../harness";

const describeDb = integrationEnabled ? describe : describe.skip;

let database: TestDatabase | undefined;
let harness: TestApp | undefined;
let tenant: TenantFixture;

beforeAll(async () => {
  if (!integrationEnabled) return;
  database = await createTestDatabase();
  await migrateDatabase(database.url);
  tenant = await createFullTenant(database.sql);
  const created = createTestApp({ database: database.sql });
  await created.ready;
  harness = created;
}, 60_000);

afterAll(async () => {
  harness?.keyStore.destroy();
  await database?.cleanup();
});

/** Guarded routes (permission noted) that GUEST must never reach, whatever the spelling. */
const GUARDED: { method: string; path: string; permission: string }[] = [
  { method: "GET", path: "/api/audit/logs", permission: "auditLog:read" },
  { method: "GET", path: "/api/finance/invoices", permission: "billing:read" },
  { method: "GET", path: "/api/users", permission: "user:read" },
  { method: "POST", path: "/api/users", permission: "user:create" },
  { method: "GET", path: "/api/discipline/incidents", permission: "disciplineIncident:read" },
];

/** Spellings that routers and decoders have historically treated inconsistently. */
function variants(path: string): string[] {
  const segments = path.split("/");
  const last = segments.at(-1)!;
  const encodedFirstLetter = `%${last.charCodeAt(0).toString(16)}${last.slice(1)}`;
  return [
    path,
    `${path}/`,
    `${path}%0a`,
    `${path}%0d`,
    `${path}%0a/`,
    `${path}%2f`,
    `${path}%2F`,
    `/${path}`,
    path.replace("/api/", "/api//"),
    path.replace("/api/", "/api/./"),
    path.replace("/api/", "/api/x/../"),
    path.toUpperCase(),
    path.replace("/api/", "/API/"),
    [...segments.slice(0, -1), encodedFirstLetter].join("/"),
    `${path}%00`,
    `${path};x`,
    `${path}#frag`,
  ];
}

describeDb("guarded routes under path variants (QA-041)", () => {
  for (const route of GUARDED) {
    test(`${route.method} ${route.path} (${route.permission}) is never reachable by GUEST`, async () => {
      const token = await mintTestToken(harness!.keyStore, {
        schoolId: tenant.schoolId,
        userId: tenant.users[ROLES.GUEST].id,
        roles: [ROLES.GUEST],
        channel: "web",
      });
      const breaches: string[] = [];
      for (const path of variants(route.path)) {
        const init: RequestInit = {
          method: route.method,
          headers: { Authorization: `Bearer ${token}` },
        };
        if (route.method !== "GET") {
          (init.headers as Record<string, string>)["Content-Type"] = "application/json";
          init.body = JSON.stringify({
            email: "x@probe.example",
            display_name: "x",
            role: "ORG_ADMIN",
          });
        }
        let status: number;
        try {
          status = (await harness!.app.request(`http://localhost${path}`, init)).status;
        } catch {
          continue; // a malformed URL the client refuses to send is not a bypass
        }
        if (status < 400 || status >= 500) breaches.push(`${path} -> ${status}`);
      }
      expect(breaches).toEqual([]);
    });
  }
});
