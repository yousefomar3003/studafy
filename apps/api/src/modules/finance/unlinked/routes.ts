import { createRoute, OpenAPIHono } from "@hono/zod-openapi";
import { PERMISSIONS } from "@studafy/constants";

import { requireAuth } from "../../../middleware/authContext";
import { requirePermission } from "../../../middleware/authz";
import { openApiValidationHook } from "../../../openapi/hook";
import { standardResponses } from "../../../openapi/responses";
import { withStudentIdentityTx } from "../students/service";

import {
  unlinkedListQuerySchema,
  unlinkedParentListSchema,
  unlinkedStudentListSchema,
  unlinkedSummarySchema,
} from "./schemas";
import { countUnlinked, listUnlinkedParents, listUnlinkedStudents } from "./service";

import type { Database } from "../../../db/client";
import type { AppEnv } from "../../../middleware/requestId";

const studentsDef = createRoute({
  method: "get",
  path: "/api/finance/unlinked/students",
  tags: ["Finance"],
  operationId: "listFinanceUnlinkedStudents",
  summary: "List enrolled students with no guardian",
  description:
    "Enrolled students no parent is linked to. They belong to no family, so they get no sibling " +
    "discount, appear in no family account or statement, and no parent can see or pay their " +
    "invoices. Staff fix one from the student's Guardians tab.",
  security: [{ bearerAuth: [] }],
  request: { query: unlinkedListQuerySchema },
  responses: standardResponses(
    { 200: { description: "One page of students.", schema: unlinkedStudentListSchema } },
    [400, 401, 403, 500],
  ),
});

const parentsDef = createRoute({
  method: "get",
  path: "/api/finance/unlinked/parents",
  tags: ["Finance"],
  operationId: "listFinanceUnlinkedParents",
  summary: "List parent accounts with no children",
  description:
    "PARENT accounts (archived ones excluded) linked to no student. They see no child's fees " +
    "and receive no fee notices until staff link them.",
  security: [{ bearerAuth: [] }],
  request: { query: unlinkedListQuerySchema },
  responses: standardResponses(
    { 200: { description: "One page of parents.", schema: unlinkedParentListSchema } },
    [400, 401, 403, 500],
  ),
});

const summaryDef = createRoute({
  method: "get",
  path: "/api/finance/unlinked/summary",
  tags: ["Finance"],
  operationId: "getFinanceUnlinkedSummary",
  summary: "Count unlinked students and parents",
  description: "How many entries each of the two unlinked lists holds.",
  security: [{ bearerAuth: [] }],
  responses: standardResponses(
    { 200: { description: "The counts.", schema: unlinkedSummarySchema } },
    [401, 403, 500],
  ),
});

/**
 * Who finance cannot reach through a family. Read-only and gated on billing:read, like the family
 * accounts list it complements: it is the gap in that list. Finance holds billing:read but not
 * student:read, so the reads run through the identity transaction and return identity columns only.
 */
export function financeUnlinkedRoutes(database: Database): OpenAPIHono<AppEnv> {
  const routes = new OpenAPIHono<AppEnv>({ defaultHook: openApiValidationHook });

  routes.use("/api/finance/unlinked/*", requirePermission(PERMISSIONS.BILLING_READ));

  routes.openapi(studentsDef, async (c) => {
    const { schoolId } = requireAuth(c);
    const result = await withStudentIdentityTx(database, schoolId, (tx) =>
      listUnlinkedStudents(tx, schoolId, c.req.valid("query")),
    );
    return c.json(result, 200);
  });

  routes.openapi(parentsDef, async (c) => {
    const { schoolId } = requireAuth(c);
    const result = await withStudentIdentityTx(database, schoolId, (tx) =>
      listUnlinkedParents(tx, schoolId, c.req.valid("query")),
    );
    return c.json(result, 200);
  });

  routes.openapi(summaryDef, async (c) => {
    const { schoolId } = requireAuth(c);
    const result = await withStudentIdentityTx(database, schoolId, (tx) =>
      countUnlinked(tx, schoolId),
    );
    return c.json(result, 200);
  });

  return routes;
}
