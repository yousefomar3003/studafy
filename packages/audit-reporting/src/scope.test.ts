/**
 * QA-040: the shared rule for which audit values a reader may see. Both the explorer
 * (GET /api/audit/logs) and the CSV export (apps/workers audit-export) apply it.
 */

// eslint-disable-next-line import-x/no-unresolved -- "bun:test" is a virtual Bun built-in
import { describe, expect, test } from "bun:test";

import { scopeAuditEntry } from "./index";

import type { AuditLogEntry } from "./index";

const entry = (target_table: string): AuditLogEntry => ({
  id: "00000000-0000-4000-8000-000000000001",
  created_at: new Date("2026-11-16T10:00:00Z"),
  action: "update",
  actor_id: null,
  actor_name: null,
  actor_email: null,
  target_table,
  target_id: "00000000-0000-4000-8000-000000000002",
  client_ip: null,
  user_agent: null,
  request_id: null,
  old_values: { score: 41 },
  new_values: { score: 93 },
});

describe("scopeAuditEntry (QA-040)", () => {
  test("school admins see every value", () => {
    for (const role of ["ORG_ADMIN", "SUPER_ADMIN"]) {
      expect(scopeAuditEntry(entry("grades"), [role]).new_values).toEqual({ score: 93 });
    }
  });

  test("FINANCE sees finance values and not grades, discipline or records", () => {
    expect(scopeAuditEntry(entry("payment_cache"), ["FINANCE"]).new_values).toEqual({ score: 93 });
    for (const table of ["grades", "discipline_incidents", "record_answers", "students"]) {
      const scoped = scopeAuditEntry(entry(table), ["FINANCE"]);
      expect([scoped.old_values, scoped.new_values]).toEqual([null, null]);
    }
  });

  test("SUPPORT_AGENT sees the row but no values", () => {
    const scoped = scopeAuditEntry(entry("payment_cache"), ["SUPPORT_AGENT"]);
    expect(scoped.target_table).toBe("payment_cache");
    expect([scoped.old_values, scoped.new_values]).toEqual([null, null]);
  });
});
