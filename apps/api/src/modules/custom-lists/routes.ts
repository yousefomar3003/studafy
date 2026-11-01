import { createRoute, OpenAPIHono } from "@hono/zod-openapi";
import { PERMISSIONS } from "@studafy/constants";

import { withTenantTx } from "../../db/tenant-tx";
import { auditAction } from "../../middleware/auditEmitter";
import { requireAuth } from "../../middleware/authContext";
import { hasPermission, requirePermission } from "../../middleware/authz";
import { requireChannel } from "../../middleware/channelGuard";
import { onlyMethods } from "../../middleware/only-methods";
import { openApiValidationHook } from "../../openapi/hook";
import { requestIdHeaders, standardResponses } from "../../openapi/responses";
import { AUTH_CHANNELS } from "../auth/channels";

import { applyImport, previewImport } from "./import-service";
import {
  MAX_COLUMNS_PER_LIST,
  MAX_LISTS_PER_SCHOOL,
  MAX_ROWS_PER_LIST,
  MAX_ROWS_PER_SCHOOL,
} from "./limits";
import {
  addColumn,
  createList,
  deleteList,
  getListDetail,
  listLists,
  reorderColumns,
  updateColumn,
  updateList,
} from "./list-service";
import {
  createRow,
  deleteRow,
  exportCsv,
  linkCandidates,
  linkedRows,
  listRows,
  revealCell,
  updateRow,
} from "./row-service";
import {
  applyCustomListImportBodySchema,
  cellParamSchema,
  columnParamSchema,
  createCustomListBodySchema,
  createCustomListRowBodySchema,
  customListDetailSchema,
  customListExportQuerySchema,
  customListImportBodySchema,
  customListImportPreviewSchema,
  customListImportResultSchema,
  customListLinkCandidatesSchema,
  customListLinkedSchema,
  customListListSchema,
  customListRowPageSchema,
  customListRowSchema,
  customListRowsQuerySchema,
  customListsQuerySchema,
  linkCandidatesQuerySchema,
  linkedParamSchema,
  listIdParamSchema,
  newCustomListColumnSchema,
  reorderCustomListColumnsBodySchema,
  revealedCustomListCellSchema,
  rowParamSchema,
  updateCustomListBodySchema,
  updateCustomListColumnBodySchema,
  updateCustomListRowBodySchema,
} from "./schemas";

import type { CustomListActor } from "./list-service";
import type { Database } from "../../db/client";
import type { AppEnv } from "../../middleware/requestId";
import type { RecordKeyring } from "@studafy/records";
import type { Context } from "hono";

const TAG = "Custom lists";

const AUDIENCE_NOTE =
  "Only lists whose audience includes the caller exist for them: any other list answers 404.";

// ---------------------------------------------------------------------------
// Routes
// ---------------------------------------------------------------------------

const listCustomListsRoute = createRoute({
  method: "get",
  path: "/api/custom-lists",
  tags: [TAG],
  operationId: "listCustomLists",
  summary: "List custom lists",
  description: `The school's custom lists the caller may use, with the caps. ${AUDIENCE_NOTE}`,
  security: [{ bearerAuth: [] }],
  request: { query: customListsQuerySchema },
  responses: standardResponses(
    { 200: { description: "The lists.", schema: customListListSchema } },
    [400, 401, 403, 500],
  ),
});

const createCustomListRoute = createRoute({
  method: "post",
  path: "/api/custom-lists",
  tags: [TAG],
  operationId: "createCustomList",
  summary: "Create a custom list",
  description:
    "A new list with its audience, the link kinds its rows may carry, and optionally its first " +
    "columns. The audience must include the caller. At most 50 lists per school (409 " +
    "CUSTOM_LIST_LIMIT_REACHED); names are unique per school (409 CUSTOM_LIST_NAME_TAKEN).",
  security: [{ bearerAuth: [] }],
  request: {
    body: {
      required: true,
      content: { "application/json": { schema: createCustomListBodySchema } },
    },
  },
  responses: standardResponses(
    { 201: { description: "The new list.", schema: customListDetailSchema } },
    [400, 401, 403, 409, 422, 429, 500],
  ),
});

const linkedCustomListRowsRoute = createRoute({
  method: "get",
  path: "/api/custom-lists/linked/{subjectKind}/{subjectId}",
  tags: [TAG],
  operationId: "getLinkedCustomListRows",
  summary: "Rows linked to a person or class",
  description:
    "For a student, parent, member of staff or class page: the rows of every list the caller " +
    "may use that link to it (up to 50 per list), sensitive cells masked. Archived lists are " +
    "left out.",
  security: [{ bearerAuth: [] }],
  request: { params: linkedParamSchema },
  responses: standardResponses(
    { 200: { description: "Linked rows, by list.", schema: customListLinkedSchema } },
    [400, 401, 403, 500],
  ),
});

const previewCustomListImportRoute = createRoute({
  method: "post",
  path: "/api/custom-lists/imports/preview",
  tags: [TAG],
  operationId: "previewCustomListImport",
  summary: "Preview a sheet as a new custom list",
  description:
    "Reads a CSV whose first line names its columns and proposes a list: each column's guessed " +
    "type and suggested sensitivity, every invalid cell's line, and -- when a key column is " +
    "chosen -- every row's proposed link or why it has none. Links are by school-issued key only, " +
    "matched exactly. Writes nothing; returns the token the apply call must present.",
  security: [{ bearerAuth: [] }],
  request: {
    body: {
      required: true,
      content: { "application/json": { schema: customListImportBodySchema } },
    },
  },
  responses: standardResponses(
    { 200: { description: "What would be created.", schema: customListImportPreviewSchema } },
    [400, 401, 403, 409, 422, 429, 500],
  ),
});

const applyCustomListImportRoute = createRoute({
  method: "post",
  path: "/api/custom-lists/imports/apply",
  tags: [TAG],
  operationId: "applyCustomListImport",
  summary: "Create the custom list a preview proposed",
  description:
    "The same body as the preview plus its preview_token. Creates the list, its columns and its " +
    "rows exactly as previewed; anything that changed since answers 409 " +
    "CUSTOM_LIST_PREVIEW_STALE and writes nothing. Invalid cells are left empty.",
  security: [{ bearerAuth: [] }],
  request: {
    body: {
      required: true,
      content: { "application/json": { schema: applyCustomListImportBodySchema } },
    },
  },
  responses: standardResponses(
    { 201: { description: "The list was created.", schema: customListImportResultSchema } },
    [400, 401, 403, 409, 422, 429, 500, 503],
  ),
});

const getCustomListRoute = createRoute({
  method: "get",
  path: "/api/custom-lists/{listId}",
  tags: [TAG],
  operationId: "getCustomList",
  summary: "Get a custom list",
  description: `The list and its columns, archived ones flagged. ${AUDIENCE_NOTE}`,
  security: [{ bearerAuth: [] }],
  request: { params: listIdParamSchema },
  responses: standardResponses(
    { 200: { description: "The list.", schema: customListDetailSchema } },
    [400, 401, 403, 404, 500],
  ),
});

const updateCustomListRoute = createRoute({
  method: "patch",
  path: "/api/custom-lists/{listId}",
  tags: [TAG],
  operationId: "updateCustomList",
  summary: "Change a custom list",
  description:
    "Rename it, change its description, audience or link kinds, or archive and restore it. A " +
    "link kind some rows use cannot be turned off.",
  security: [{ bearerAuth: [] }],
  request: {
    params: listIdParamSchema,
    body: {
      required: true,
      content: { "application/json": { schema: updateCustomListBodySchema } },
    },
  },
  responses: standardResponses(
    { 200: { description: "The list after the change.", schema: customListDetailSchema } },
    [400, 401, 403, 404, 409, 422, 429, 500],
  ),
});

const deleteCustomListRoute = createRoute({
  method: "delete",
  path: "/api/custom-lists/{listId}",
  tags: [TAG],
  operationId: "deleteCustomList",
  summary: "Delete a custom list",
  description: "Deletes the list with every column, row and value. Cannot be undone.",
  security: [{ bearerAuth: [] }],
  request: { params: listIdParamSchema },
  responses: {
    204: { description: "Deleted.", headers: requestIdHeaders },
    ...standardResponses({}, [400, 401, 403, 404, 429, 500]),
  },
});

const addCustomListColumnRoute = createRoute({
  method: "post",
  path: "/api/custom-lists/{listId}/columns",
  tags: [TAG],
  operationId: "addCustomListColumn",
  summary: "Add a column",
  description:
    "A typed column, using the school record field types (all but document) and sensitivities. " +
    "A sensitive column is encrypted at rest, masked in every response, and left out of search " +
    "and CSV export. At most 30 columns per list. Type and sensitivity cannot change later.",
  security: [{ bearerAuth: [] }],
  request: {
    params: listIdParamSchema,
    body: {
      required: true,
      content: { "application/json": { schema: newCustomListColumnSchema } },
    },
  },
  responses: standardResponses(
    { 201: { description: "The list with the new column.", schema: customListDetailSchema } },
    [400, 401, 403, 404, 409, 422, 429, 500],
  ),
});

const updateCustomListColumnRoute = createRoute({
  method: "patch",
  path: "/api/custom-lists/{listId}/columns/{columnId}",
  tags: [TAG],
  operationId: "updateCustomListColumn",
  summary: "Change a column",
  description:
    "Relabel it, make it required or optional, change its choices, or archive and restore it. " +
    "Archiving hides the column and keeps its values.",
  security: [{ bearerAuth: [] }],
  request: {
    params: columnParamSchema,
    body: {
      required: true,
      content: { "application/json": { schema: updateCustomListColumnBodySchema } },
    },
  },
  responses: standardResponses(
    { 200: { description: "The list after the change.", schema: customListDetailSchema } },
    [400, 401, 403, 404, 409, 422, 429, 500],
  ),
});

const reorderCustomListColumnsRoute = createRoute({
  method: "put",
  path: "/api/custom-lists/{listId}/column-order",
  tags: [TAG],
  operationId: "reorderCustomListColumns",
  summary: "Reorder the columns",
  description: "Every column id of the list, archived ones included, in the new order.",
  security: [{ bearerAuth: [] }],
  request: {
    params: listIdParamSchema,
    body: {
      required: true,
      content: { "application/json": { schema: reorderCustomListColumnsBodySchema } },
    },
  },
  responses: standardResponses(
    { 200: { description: "The list after the change.", schema: customListDetailSchema } },
    [400, 401, 403, 404, 422, 429, 500],
  ),
});

const listCustomListRowsRoute = createRoute({
  method: "get",
  path: "/api/custom-lists/{listId}/rows",
  tags: [TAG],
  operationId: "listCustomListRows",
  summary: "List a custom list's rows",
  description:
    "A page of rows with free-text search, one column filter and sorting. Sensitive cells come " +
    "back masked and are never searched, filtered or sorted on.",
  security: [{ bearerAuth: [] }],
  request: { params: listIdParamSchema, query: customListRowsQuerySchema },
  responses: standardResponses(
    { 200: { description: "The rows.", schema: customListRowPageSchema } },
    [400, 401, 403, 404, 422, 500],
  ),
});

const createCustomListRowRoute = createRoute({
  method: "post",
  path: "/api/custom-lists/{listId}/rows",
  tags: [TAG],
  operationId: "createCustomListRow",
  summary: "Add a row",
  description:
    "Cells by column, and optionally a link to a student, parent, member of staff or class the " +
    "list allows (422 CUSTOM_LIST_LINK_INVALID otherwise). At most 5,000 rows per list and " +
    "20,000 per school.",
  security: [{ bearerAuth: [] }],
  request: {
    params: listIdParamSchema,
    body: {
      required: true,
      content: { "application/json": { schema: createCustomListRowBodySchema } },
    },
  },
  responses: standardResponses(
    { 201: { description: "The new row.", schema: customListRowSchema } },
    [400, 401, 403, 404, 409, 422, 429, 500, 503],
  ),
});

const updateCustomListRowRoute = createRoute({
  method: "patch",
  path: "/api/custom-lists/{listId}/rows/{rowId}",
  tags: [TAG],
  operationId: "updateCustomListRow",
  summary: "Edit a row",
  description:
    "Change some cells, or the link. A sensitive cell's audit entry never holds the value.",
  security: [{ bearerAuth: [] }],
  request: {
    params: rowParamSchema,
    body: {
      required: true,
      content: { "application/json": { schema: updateCustomListRowBodySchema } },
    },
  },
  responses: standardResponses(
    { 200: { description: "The row after the edit.", schema: customListRowSchema } },
    [400, 401, 403, 404, 422, 429, 500, 503],
  ),
});

const deleteCustomListRowRoute = createRoute({
  method: "delete",
  path: "/api/custom-lists/{listId}/rows/{rowId}",
  tags: [TAG],
  operationId: "deleteCustomListRow",
  summary: "Delete a row",
  description: "Deletes the row and its cells.",
  security: [{ bearerAuth: [] }],
  request: { params: rowParamSchema },
  responses: {
    204: { description: "Deleted.", headers: requestIdHeaders },
    ...standardResponses({}, [400, 401, 403, 404, 429, 500]),
  },
});

const customListLinkCandidatesRoute = createRoute({
  method: "get",
  path: "/api/custom-lists/{listId}/link-candidates",
  tags: [TAG],
  operationId: "getCustomListLinkCandidates",
  summary: "Find someone or a class to link a row to",
  description:
    "Up to 10 subjects of a kind the list allows, matched by name or by the school's own key, " +
    "that the caller can see: students, parents (holding PARENT), members of staff (holding a " +
    "staff role) or classes. For a person to choose from; nothing is linked automatically.",
  security: [{ bearerAuth: [] }],
  request: { params: listIdParamSchema, query: linkCandidatesQuerySchema },
  responses: standardResponses(
    { 200: { description: "The candidates.", schema: customListLinkCandidatesSchema } },
    [400, 401, 403, 404, 422, 500],
  ),
});

const revealCustomListCellRoute = createRoute({
  method: "post",
  path: "/api/custom-lists/{listId}/rows/{rowId}/cells/{columnId}/reveal",
  tags: [TAG],
  operationId: "revealCustomListCell",
  summary: "Reveal a sensitive cell",
  description:
    "The full value of one sensitive cell. Needs customList:readSensitive and the list's " +
    "audience; every call is audited (who, when, which list, row and column).",
  security: [{ bearerAuth: [] }],
  request: { params: cellParamSchema },
  responses: standardResponses(
    { 200: { description: "The revealed value.", schema: revealedCustomListCellSchema } },
    [400, 401, 403, 404, 409, 429, 500, 503],
  ),
});

const exportCustomListRoute = createRoute({
  method: "get",
  path: "/api/custom-lists/{listId}/export",
  tags: [TAG],
  operationId: "exportCustomList",
  summary: "Export a custom list as CSV",
  description:
    "Every row as CSV (UTF-8 with a byte-order mark), choices by their labels in the chosen " +
    "language. Sensitive columns are always left out. Audited.",
  security: [{ bearerAuth: [] }],
  request: { params: listIdParamSchema, query: customListExportQuerySchema },
  responses: {
    200: {
      description: "The CSV file.",
      headers: requestIdHeaders,
      content: { "text/csv": { schema: { type: "string" } } },
    },
    ...standardResponses({}, [400, 401, 403, 404, 500]),
  },
});

// ---------------------------------------------------------------------------
// Handlers
// ---------------------------------------------------------------------------

const MUTATING = ["POST", "PUT", "PATCH", "DELETE"] as const;

function actorFrom(c: Context<AppEnv>): CustomListActor & { requestId?: string } {
  const auth = requireAuth(c);
  return {
    schoolId: auth.schoolId,
    userId: auth.userId,
    roles: auth.roles,
    canManage: hasPermission(auth.roles, PERMISSIONS.CUSTOM_LIST_MANAGE),
    requestId: c.get("requestId"),
  };
}

export function customListRoutes(database: Database, keyring: RecordKeyring): OpenAPIHono<AppEnv> {
  const routes = new OpenAPIHono<AppEnv>({ defaultHook: openApiValidationHook });

  // --- Channel guard: every write is a web session's; reads also serve the mobile app ---
  const webOnly = onlyMethods(MUTATING, requireChannel(AUTH_CHANNELS.WEB));
  routes.use("/api/custom-lists", webOnly);
  routes.use("/api/custom-lists/*", webOnly);

  // --- Permission guards ---
  // customList:use opens every route; the list's audience narrows it (RLS, 000182). Shaping a
  // list -- creating, changing, deleting it, its columns and imports -- is customList:manage; a
  // sensitive cell's reveal is customList:readSensitive.
  routes.use("/api/custom-lists", requirePermission(PERMISSIONS.CUSTOM_LIST_USE));
  routes.use("/api/custom-lists/*", requirePermission(PERMISSIONS.CUSTOM_LIST_USE));
  routes.use(
    "/api/custom-lists",
    onlyMethods(["POST"], requirePermission(PERMISSIONS.CUSTOM_LIST_MANAGE)),
  );
  routes.use("/api/custom-lists/imports/*", requirePermission(PERMISSIONS.CUSTOM_LIST_MANAGE));
  routes.use(
    "/api/custom-lists/:listId",
    onlyMethods(["PATCH", "DELETE"], requirePermission(PERMISSIONS.CUSTOM_LIST_MANAGE)),
  );
  routes.use(
    "/api/custom-lists/:listId/columns",
    requirePermission(PERMISSIONS.CUSTOM_LIST_MANAGE),
  );
  routes.use(
    "/api/custom-lists/:listId/columns/*",
    requirePermission(PERMISSIONS.CUSTOM_LIST_MANAGE),
  );
  routes.use(
    "/api/custom-lists/:listId/column-order",
    requirePermission(PERMISSIONS.CUSTOM_LIST_MANAGE),
  );
  routes.use(
    "/api/custom-lists/:listId/rows/:rowId/cells/:columnId/reveal",
    requirePermission(PERMISSIONS.CUSTOM_LIST_READ_SENSITIVE),
  );

  // --- Audit declarations ---
  routes.use("/api/custom-lists", auditAction("insert", "custom_lists"));
  routes.use("/api/custom-lists/imports/preview", auditAction("read", "custom_lists"));
  routes.use("/api/custom-lists/imports/apply", auditAction("insert", "custom_lists"));
  routes.use("/api/custom-lists/:listId", auditAction("update", "custom_lists"));
  routes.use("/api/custom-lists/:listId/columns", auditAction("insert", "custom_list_columns"));
  routes.use(
    "/api/custom-lists/:listId/columns/:columnId",
    auditAction("update", "custom_list_columns"),
  );
  routes.use("/api/custom-lists/:listId/column-order", auditAction("update", "custom_lists"));
  routes.use("/api/custom-lists/:listId/rows", auditAction("insert", "custom_list_rows"));
  routes.use("/api/custom-lists/:listId/rows/:rowId", auditAction("update", "custom_list_rows"));
  routes.use(
    "/api/custom-lists/:listId/rows/:rowId/cells/:columnId/reveal",
    auditAction("read", "custom_list_values"),
  );

  // Static paths first: "linked" and "imports" are never a list id.

  routes.openapi(listCustomListsRoute, async (c) => {
    const actor = actorFrom(c);
    const lists = await withTenantTx(database, actor, (tx) =>
      listLists(tx, actor, c.req.valid("query").include_archived),
    );
    return c.json(
      {
        lists,
        limits: {
          lists: MAX_LISTS_PER_SCHOOL,
          columns_per_list: MAX_COLUMNS_PER_LIST,
          rows_per_list: MAX_ROWS_PER_LIST,
          rows_per_school: MAX_ROWS_PER_SCHOOL,
        },
      },
      200,
    );
  });

  routes.openapi(createCustomListRoute, async (c) => {
    const actor = actorFrom(c);
    const list = await withTenantTx(database, actor, async (tx) => {
      const id = await createList(tx, actor, c.req.valid("json"));
      return getListDetail(tx, actor, id);
    });
    return c.json(list, 201);
  });

  routes.openapi(linkedCustomListRowsRoute, async (c) => {
    const actor = actorFrom(c);
    const { subjectKind, subjectId } = c.req.valid("param");
    const linked = await withTenantTx(database, actor, (tx) =>
      linkedRows(tx, actor, subjectKind, subjectId),
    );
    return c.json(linked, 200);
  });

  routes.openapi(previewCustomListImportRoute, async (c) => {
    const actor = actorFrom(c);
    const preview = await withTenantTx(database, actor, (tx) =>
      previewImport(tx, actor, c.req.valid("json")),
    );
    return c.json(preview, 200);
  });

  routes.openapi(applyCustomListImportRoute, async (c) => {
    const actor = actorFrom(c);
    const result = await withTenantTx(database, actor, (tx) =>
      applyImport(tx, actor, keyring, c.req.valid("json")),
    );
    return c.json(result, 201);
  });

  routes.openapi(getCustomListRoute, async (c) => {
    const actor = actorFrom(c);
    const list = await withTenantTx(database, actor, (tx) =>
      getListDetail(tx, actor, c.req.valid("param").listId),
    );
    return c.json(list, 200);
  });

  routes.openapi(updateCustomListRoute, async (c) => {
    const actor = actorFrom(c);
    const { listId } = c.req.valid("param");
    const list = await withTenantTx(database, actor, async (tx) => {
      await updateList(tx, actor, listId, c.req.valid("json"));
      return getListDetail(tx, actor, listId);
    });
    return c.json(list, 200);
  });

  routes.openapi(deleteCustomListRoute, async (c) => {
    const actor = actorFrom(c);
    await withTenantTx(database, actor, (tx) => deleteList(tx, actor, c.req.valid("param").listId));
    return c.body(null, 204);
  });

  routes.openapi(addCustomListColumnRoute, async (c) => {
    const actor = actorFrom(c);
    const { listId } = c.req.valid("param");
    const list = await withTenantTx(database, actor, async (tx) => {
      await addColumn(tx, actor, listId, c.req.valid("json"));
      return getListDetail(tx, actor, listId);
    });
    return c.json(list, 201);
  });

  routes.openapi(updateCustomListColumnRoute, async (c) => {
    const actor = actorFrom(c);
    const { listId, columnId } = c.req.valid("param");
    const list = await withTenantTx(database, actor, async (tx) => {
      await updateColumn(tx, actor, listId, columnId, c.req.valid("json"));
      return getListDetail(tx, actor, listId);
    });
    return c.json(list, 200);
  });

  routes.openapi(reorderCustomListColumnsRoute, async (c) => {
    const actor = actorFrom(c);
    const { listId } = c.req.valid("param");
    const list = await withTenantTx(database, actor, async (tx) => {
      await reorderColumns(tx, actor, listId, c.req.valid("json").column_ids);
      return getListDetail(tx, actor, listId);
    });
    return c.json(list, 200);
  });

  routes.openapi(listCustomListRowsRoute, async (c) => {
    const actor = actorFrom(c);
    const page = await withTenantTx(database, actor, (tx) =>
      listRows(tx, actor, c.req.valid("param").listId, c.req.valid("query")),
    );
    return c.json(page, 200);
  });

  routes.openapi(createCustomListRowRoute, async (c) => {
    const actor = actorFrom(c);
    const row = await withTenantTx(database, actor, (tx) =>
      createRow(tx, actor, keyring, c.req.valid("param").listId, c.req.valid("json")),
    );
    return c.json(row, 201);
  });

  routes.openapi(updateCustomListRowRoute, async (c) => {
    const actor = actorFrom(c);
    const { listId, rowId } = c.req.valid("param");
    const row = await withTenantTx(database, actor, (tx) =>
      updateRow(tx, actor, keyring, listId, rowId, c.req.valid("json")),
    );
    return c.json(row, 200);
  });

  routes.openapi(deleteCustomListRowRoute, async (c) => {
    const actor = actorFrom(c);
    const { listId, rowId } = c.req.valid("param");
    await withTenantTx(database, actor, (tx) => deleteRow(tx, actor, listId, rowId));
    return c.body(null, 204);
  });

  routes.openapi(customListLinkCandidatesRoute, async (c) => {
    const actor = actorFrom(c);
    const found = await withTenantTx(database, actor, (tx) =>
      linkCandidates(tx, actor, c.req.valid("param").listId, c.req.valid("query")),
    );
    return c.json(found, 200);
  });

  routes.openapi(revealCustomListCellRoute, async (c) => {
    const actor = actorFrom(c);
    const { listId, rowId, columnId } = c.req.valid("param");
    const revealed = await withTenantTx(database, actor, (tx) =>
      revealCell(tx, actor, keyring, listId, rowId, columnId),
    );
    c.header("Cache-Control", "no-store");
    return c.json(revealed, 200);
  });

  routes.openapi(exportCustomListRoute, async (c) => {
    const actor = actorFrom(c);
    const { listId } = c.req.valid("param");
    const lang = c.req.valid("query").lang ?? "en";
    const file = await withTenantTx(database, actor, (tx) => exportCsv(tx, actor, listId, lang));
    return new Response(file.csv, {
      status: 200,
      headers: {
        "Content-Type": "text/csv; charset=utf-8",
        "Content-Disposition": `attachment; filename="${file.fileName}"`,
        "Cache-Control": "no-store",
      },
    });
  });

  return routes;
}
