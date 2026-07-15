// eslint-disable-next-line import-x/no-unresolved -- "bun:test" is a virtual Bun built-in
import { describe, expect, test } from "bun:test";

import { formatProbeDiagnostic, inspectPlan, quoteIdentifier } from "./probe-support";

describe("cross-tenant probe support", () => {
  test("recursively finds index paths and sequential scans", () => {
    const inspection = inspectPlan({
      "Node Type": "Append",
      Plans: [
        { "Node Type": "Index Scan", "Index Name": "idx_school_id" },
        { "Node Type": "Seq Scan", "Relation Name": "unsafe_partition" },
      ],
    });
    expect(inspection.indexNames).toEqual(["idx_school_id"]);
    expect(inspection.sequentialRelations).toEqual(["unsafe_partition"]);
  });

  test("formats actionable, structured leak diagnostics", () => {
    const output = formatProbeDiagnostic({
      operation: "read",
      relation: "app.users",
      primaryKey: "user-b",
      expectedTenant: "school-a",
      observedTenant: "school-b",
      backendPid: 42,
      rowCount: 1,
      sqlState: "42501",
    });
    expect(output).toContain('"backendPid": 42');
    expect(output).toContain('"observedTenant": "school-b"');
  });

  test("quotes catalog-derived identifiers", () => {
    expect(quoteIdentifier('tenant"table')).toBe('"tenant""table"');
  });
});
