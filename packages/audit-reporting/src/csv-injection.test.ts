/**
 * QA-063: an audit export row cannot carry a live spreadsheet formula. The User-Agent and the
 * actor's display name are caller-controlled and land in the CSV verbatim.
 */

// eslint-disable-next-line import-x/no-unresolved -- "bun:test" is a virtual Bun built-in
import { expect, test } from "bun:test";

import { auditLogEntryToCsv } from "./index";

test("a formula in the User-Agent or display name is exported as text (QA-063)", () => {
  const line = auditLogEntryToCsv({
    id: "00000000-0000-4000-8000-000000000001",
    created_at: new Date("2026-11-16T10:00:00Z"),
    action: "update",
    actor_id: null,
    actor_name: "=1+1",
    actor_email: null,
    target_table: "users",
    target_id: "00000000-0000-4000-8000-000000000002",
    client_ip: null,
    user_agent: '=HYPERLINK("https://evil.example","open")',
    request_id: null,
    old_values: null,
    new_values: null,
  });
  expect(line).toContain("'=1+1");
  expect(line).toContain(`"'=HYPERLINK(""https://evil.example"",""open"")"`);
  expect(line).not.toMatch(/(^|,)=/);
});
