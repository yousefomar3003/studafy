import path from "node:path";

// eslint-disable-next-line import-x/no-unresolved -- "bun:test" is a virtual Bun built-in with no resolvable file path
import { describe, expect, test } from "bun:test";

import { buildOpenApiDocument } from "../../src/openapi/document";

/**
 * ST-060: the User and School components must mirror the physical schema.
 *
 * The constraints are read out of the migrations rather than restated here. Asserting
 * `maxLength === 320` against a Zod schema that also hard-codes 320 would be two copies of the same
 * guess checking each other; reading `char_length(email) <= 320` out of the DDL means the assertion
 * fails when the database changes, which is the only failure worth having.
 *
 * ## Limits, stated plainly
 *
 * This is regex over SQL text. It will break if the DDL is reformatted, it assumes every column
 * definition precedes every table constraint (true of these migrations), and it only covers the two
 * tables it names. It needs no database, which is why it runs in the `quality` CI job alongside the
 * unit tests instead of only where Postgres exists.
 *
 * The stronger version of this test queries information_schema and pg_constraint against a real
 * database, and belongs in the `database-migrations` job. That is a follow-up, not this ticket.
 *
 * ## required vs NOT NULL — not the same thing
 *
 * SQL NOT NULL says a value is never null. JSON Schema `required` says a key is always present.
 * These are different claims, and conflating them is how a nullable column ends up wrongly typed.
 * A nullable column is still always serialized — as `null` — so it is `required` *and* its type
 * includes "null". The mapping asserted below is therefore:
 *
 *   every exposed column  -> present in `required`
 *   NOT NULL              -> type excludes "null"
 *   nullable              -> type includes "null"
 */

const MIGRATIONS = path.join(import.meta.dir, "..", "..", "..", "..", "db", "migrations");

const USERS_MIGRATION = path.join(MIGRATIONS, "000007_create_users_and_identity_tables.sql");
const GLOBAL_MIGRATION = path.join(MIGRATIONS, "000004_create_global_tables.sql");

interface Column {
  name: string;
  nullable: boolean;
}

/**
 * Extract the column definitions from a `CREATE TABLE <schema>.<table> ( ... )` block.
 *
 * Stops at the first line that opens a table-level CONSTRAINT: in these migrations every column
 * precedes every constraint, and this keeps the parser from mistaking a multi-line CHECK body for a
 * column. A column is nullable unless it says NOT NULL or is the PRIMARY KEY (app.users declares
 * `id uuid DEFAULT gen_random_uuid() CONSTRAINT pk_users PRIMARY KEY` with no explicit NOT NULL).
 */
function parseColumns(sql: string, table: string): Column[] {
  const body = new RegExp(`CREATE TABLE ${table} \\(([\\s\\S]*?)\\n\\);`).exec(sql);
  if (!body) throw new Error(`no CREATE TABLE ${table} in migration`);

  const columns: Column[] = [];
  for (const rawLine of body[1]!.split("\n")) {
    const line = rawLine.trim();
    if (line === "" || line.startsWith("--")) continue;
    if (line.startsWith("CONSTRAINT")) break;

    const match = /^([a-z_][a-z0-9_]*)\s+(.+?),?$/.exec(line);
    if (!match) continue;

    const definition = match[2]!;
    columns.push({
      name: match[1]!,
      nullable: !/NOT NULL/.test(definition) && !/PRIMARY KEY/.test(definition),
    });
  }

  if (columns.length === 0) throw new Error(`parsed no columns for ${table}`);
  return columns;
}

/** Extract the members of a `CREATE TYPE <name> AS ENUM (...)` declaration, in declaration order. */
function parseEnum(sql: string, typeName: string): string[] {
  const match = new RegExp(`CREATE TYPE ${typeName} AS ENUM \\(([\\s\\S]*?)\\);`).exec(sql);
  if (!match) throw new Error(`no CREATE TYPE ${typeName} in migration`);
  return [...match[1]!.matchAll(/'([^']+)'/g)].map((m) => m[1]!);
}

/** Extract N from a `char_length(<column>) <= N` CHECK. */
function parseMaxLength(sql: string, column: string): number {
  const match = new RegExp(`char_length\\(${column}\\) <= (\\d+)`).exec(sql);
  if (!match) throw new Error(`no char_length CHECK for ${column}`);
  return Number(match[1]);
}

const usersSql = await Bun.file(USERS_MIGRATION).text();
const globalSql = await Bun.file(GLOBAL_MIGRATION).text();

const document = await buildOpenApiDocument();
const schemas = document.components?.schemas as Record<string, Record<string, never>>;

/** Narrow the emitted JSON Schema enough to read without `any` at every access. */
interface JsonSchema {
  type?: string | string[];
  properties?: Record<string, JsonSchema>;
  required?: string[];
  enum?: string[];
  format?: string;
  maxLength?: number;
  minLength?: number;
  pattern?: string;
}

const userComponent = schemas.User as JsonSchema;
const schoolComponent = schemas.School as JsonSchema;

const typesOf = (schema: JsonSchema): string[] =>
  Array.isArray(schema.type) ? schema.type : schema.type === undefined ? [] : [schema.type];

/**
 * Columns app.users has that the wire model deliberately does not expose.
 *
 * normalized_email is a lower(btrim(email)) derivation that exists to back the
 * uq_users_school_normalized_email constraint. It tells a client nothing it cannot compute from
 * `email`, so it is not exposed.
 *
 * This list is an allow-list, not a filter: any *other* column added to app.users without being
 * considered here fails the test below. That is the point — the failure is the reminder.
 */
const OMITTED_USER_COLUMNS = new Set(["normalized_email"]);

describe("User component mirrors app.users", () => {
  const columns = parseColumns(usersSql, "app.users");
  const exposed = columns.filter((c) => !OMITTED_USER_COLUMNS.has(c.name));

  test("exposes every column except the documented omissions", () => {
    expect(Object.keys(userComponent.properties ?? {}).sort()).toEqual(
      exposed.map((c) => c.name).sort(),
    );
  });

  test("does not expose the omitted columns", () => {
    for (const omitted of OMITTED_USER_COLUMNS) {
      expect(userComponent.properties).not.toHaveProperty(omitted);
    }
  });

  // Every exposed column is always serialized, so every one is a required key — including the
  // nullable ones, which are serialized as null. See the header on required vs NOT NULL.
  test("marks every exposed column required", () => {
    expect([...(userComponent.required ?? [])].sort()).toEqual(exposed.map((c) => c.name).sort());
  });

  test("mirrors each column's nullability into its type", () => {
    for (const column of exposed) {
      const property = userComponent.properties?.[column.name];
      expect(property, `User.${column.name} is missing`).toBeDefined();

      expect(
        typesOf(property!).includes("null"),
        `app.users.${column.name} is ${column.nullable ? "nullable" : "NOT NULL"}, ` +
          `so User.${column.name} type ${JSON.stringify(property!.type)} is wrong`,
      ).toBe(column.nullable);
    }
  });

  test("types uuid columns as format: uuid", () => {
    expect(userComponent.properties?.id?.format).toBe("uuid");
    expect(userComponent.properties?.school_id?.format).toBe("uuid");
  });

  test("mirrors the ck_users_email length limit", () => {
    expect(userComponent.properties?.email?.maxLength).toBe(parseMaxLength(usersSql, "email"));
  });

  // Catches the drift that actually happens: a status added to the database that the API never
  // learns to report.
  test("mirrors app.user_status exactly, in declaration order", () => {
    expect(userComponent.properties?.status?.enum).toEqual(parseEnum(usersSql, "app.user_status"));
  });
});

describe("School component mirrors app.schools", () => {
  const columns = parseColumns(globalSql, "app.schools");

  test("exposes every column", () => {
    expect(Object.keys(schoolComponent.properties ?? {}).sort()).toEqual(
      columns.map((c) => c.name).sort(),
    );
  });

  test("mirrors each column's nullability into its type", () => {
    for (const column of columns) {
      const property = schoolComponent.properties?.[column.name];
      expect(property, `School.${column.name} is missing`).toBeDefined();
      expect(typesOf(property!).includes("null")).toBe(column.nullable);
    }
  });

  test("mirrors the ck_schools_slug bounds and pattern", () => {
    const bounds = /char_length\(slug\) BETWEEN (\d+) AND (\d+)/.exec(globalSql);
    expect(bounds, "ck_schools_slug no longer declares BETWEEN bounds").not.toBeNull();

    expect(schoolComponent.properties?.slug?.minLength).toBe(Number(bounds![1]));
    expect(schoolComponent.properties?.slug?.maxLength).toBe(Number(bounds![2]));

    const pattern = /slug ~ '\^(.+?)\$'/.exec(globalSql);
    expect(pattern, "ck_schools_slug no longer declares a regex").not.toBeNull();
    expect(schoolComponent.properties?.slug?.pattern).toBe(`^${pattern![1]}$`);
  });

  test("mirrors app.school_status exactly, in declaration order", () => {
    expect(schoolComponent.properties?.status?.enum).toEqual(
      parseEnum(globalSql, "app.school_status"),
    );
  });

  // app.schools is one of the six global tables. It has no school_id and must never grow one: the
  // tenant root cannot be tenant-scoped, and db/policies/rls-coverage.ts enforces that.
  test("has no school_id — it is the tenant root, not a tenant-scoped table", () => {
    expect(schoolComponent.properties).not.toHaveProperty("school_id");
  });
});
