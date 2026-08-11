// eslint-disable-next-line import-x/no-unresolved -- "bun:test" is a virtual Bun built-in
import { describe, expect, test } from "bun:test";

import {
  AUDIT_ACTIONS,
  AUDIT_LOG_CSV_HEADER,
  AuditLogFilterError,
  auditActionSchema,
  auditExportJobDataSchema,
  auditExportParametersSchema,
  auditLogCsvHeader,
  auditLogEntryToCsv,
  decodeAuditCursor,
  encodeAuditCursor,
  resolveAuditLogFilter,
} from "./index";

const FIXED_NOW = new Date("2026-02-01T00:00:00.000Z");
const A_UUID = "a0eebc99-9c0b-4ef8-bb6d-6bb9bd380a11";

describe("resolveAuditLogFilter", () => {
  test("defaults to the trailing 30 days", () => {
    const resolved = resolveAuditLogFilter({}, FIXED_NOW);
    expect(resolved.to).toBe(FIXED_NOW.toISOString());
    expect(resolved.from).toBe("2026-01-02T00:00:00.000Z");
  });

  test("honours an explicit bounded range", () => {
    const resolved = resolveAuditLogFilter(
      { from: "2026-01-01T00:00:00.000Z", to: "2026-01-15T00:00:00.000Z", action: "read" },
      FIXED_NOW,
    );
    expect(resolved.from).toBe("2026-01-01T00:00:00.000Z");
    expect(resolved.to).toBe("2026-01-15T00:00:00.000Z");
    expect(resolved.action).toBe("read");
  });

  test("rejects from after to", () => {
    expect(() =>
      resolveAuditLogFilter(
        { from: "2026-01-15T00:00:00.000Z", to: "2026-01-01T00:00:00.000Z" },
        FIXED_NOW,
      ),
    ).toThrow(AuditLogFilterError);
  });

  test("caps the range at MAX_AUDIT_LOG_RANGE_DAYS", () => {
    expect(() =>
      resolveAuditLogFilter(
        { from: "2025-01-01T00:00:00.000Z", to: FIXED_NOW.toISOString() },
        FIXED_NOW,
      ),
    ).toThrow(/at most 366 days/);
  });

  test("rejects an unknown action", () => {
    expect(() => resolveAuditLogFilter({ action: "teleport" }, FIXED_NOW)).toThrow(
      AuditLogFilterError,
    );
  });

  test("rejects malformed uuids and empty target_table", () => {
    expect(() => resolveAuditLogFilter({ actorId: "nope" }, FIXED_NOW)).toThrow(
      AuditLogFilterError,
    );
    expect(() => resolveAuditLogFilter({ targetId: "nope" }, FIXED_NOW)).toThrow(
      AuditLogFilterError,
    );
    expect(() => resolveAuditLogFilter({ targetTable: "   " }, FIXED_NOW)).toThrow(
      AuditLogFilterError,
    );
  });

  test("trims target_table and omits unset predicates", () => {
    const resolved = resolveAuditLogFilter({ targetTable: "  students  " }, FIXED_NOW);
    expect(resolved.targetTable).toBe("students");
    expect(resolved.actorId).toBeUndefined();
  });
});

describe("audit cursor", () => {
  test("round-trips a position", () => {
    const cursor = encodeAuditCursor(new Date("2026-01-01T00:00:00.000Z"), A_UUID);
    const decoded = decodeAuditCursor(cursor);
    expect(decoded.createdAt.toISOString()).toBe("2026-01-01T00:00:00.000Z");
    expect(decoded.id).toBe(A_UUID);
  });

  test("rejects malformed cursors", () => {
    expect(() => decodeAuditCursor("not-base64url!!")).toThrow(AuditLogFilterError);
    expect(() =>
      decodeAuditCursor(Buffer.from("no-separator", "utf8").toString("base64url")),
    ).toThrow(AuditLogFilterError);
    const badId = Buffer.from("2026-01-01T00:00:00.000Z|nope", "utf8").toString("base64url");
    expect(() => decodeAuditCursor(badId)).toThrow(AuditLogFilterError);
  });
});

function splitCsvRow(row: string): string[] {
  const cells: string[] = [];
  let cell = "";
  let quoted = false;
  for (let i = 0; i < row.length; i++) {
    const ch = row[i]!;
    if (ch === '"') {
      if (quoted && row[i + 1] === '"') {
        cell += '"';
        i++;
      } else {
        quoted = !quoted;
      }
    } else if (ch === "," && !quoted) {
      cells.push(cell);
      cell = "";
    } else {
      cell += ch;
    }
  }
  cells.push(cell);
  return cells;
}

describe("CSV encoding", () => {
  test("header round-trips through csvCell", () => {
    expect(auditLogCsvHeader()).toBe([...AUDIT_LOG_CSV_HEADER].join(","));
  });

  test("escapes quotes, commas and newlines, and blanks nulls", () => {
    const row = auditLogEntryToCsv({
      id: A_UUID,
      created_at: new Date("2026-01-01T00:00:00.000Z"),
      action: "update",
      actor_id: null,
      actor_name: 'O\'Brien, "Big"',
      actor_email: "obrien@school.edu",
      target_table: "students",
      target_id: A_UUID,
      client_ip: null,
      user_agent: "TestAgent/1.0\r\nX",
      request_id: null,
      old_values: { name: 'a"b,c' },
      new_values: null,
    });
    const cells = splitCsvRow(row);
    expect(cells).toEqual([
      "2026-01-01T00:00:00.000Z",
      "update",
      "",
      'O\'Brien, "Big"',
      "obrien@school.edu",
      "students",
      A_UUID,
      "",
      "TestAgent/1.0\r\nX",
      "",
      '{"name":"a\\"b,c"}',
      "",
    ]);
  });
});

describe("job payload", () => {
  test("accepts a valid payload and is strict about extras", () => {
    const payload = {
      version: 1 as const,
      jobId: A_UUID,
      schoolId: A_UUID,
      requestedByUserId: A_UUID,
    };
    expect(auditExportJobDataSchema.parse(payload)).toEqual(payload);
    expect(auditExportJobDataSchema.safeParse({ ...payload, extra: true }).success).toBe(false);
  });
});

describe("auditExportParametersSchema", () => {
  test("accepts the resolved filter shape and is strict about extras", () => {
    const parameters = {
      from: "2026-01-01T00:00:00.000Z",
      to: "2026-01-15T00:00:00.000Z",
      actorId: A_UUID,
      action: "read" as const,
      targetTable: "audit_logs",
      targetId: A_UUID,
    };
    expect(auditExportParametersSchema.parse(parameters)).toEqual(parameters);
    expect(auditExportParametersSchema.safeParse({ ...parameters, extra: true }).success).toBe(
      false,
    );
  });

  test("accepts a bare range and rejects malformed optionals", () => {
    expect(auditExportParametersSchema.parse({ from: "a", to: "b" })).toEqual({
      from: "a",
      to: "b",
    });
    expect(
      auditExportParametersSchema.safeParse({ from: "a", to: "b", actorId: "nope" }).success,
    ).toBe(false);
  });
});

describe("actions contract", () => {
  test("every action is a valid zod enum and 'read' is present", () => {
    expect(AUDIT_ACTIONS).toContain("read");
    for (const action of AUDIT_ACTIONS) {
      expect(auditActionSchema.parse(action)).toBe(action);
    }
  });
});
