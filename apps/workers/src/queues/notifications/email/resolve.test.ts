import { DOMAIN_EVENTS } from "@studafy/constants";
// eslint-disable-next-line import-x/no-unresolved -- "bun:test" is a virtual Bun built-in with no resolvable file path
import { describe, expect, test } from "bun:test";

import { EMAIL_EVENT_NAMES, resolveEmail } from "./resolve";

import type { ClaimedOutboxRow } from "./resolve";

const context = { frontendUrl: "https://app.studafy.test", schoolName: "Hill <School>" };

function row(event_name: string, payload: Record<string, unknown>): ClaimedOutboxRow {
  return {
    id: "1",
    school_id: "00000000-0000-4000-8000-000000000001",
    event_name,
    payload,
    created_at: "2026-09-27T00:00:00.000Z",
  };
}

describe("account deletion emails", () => {
  test("both events are claimed by the email dispatcher", () => {
    expect(EMAIL_EVENT_NAMES).toContain(DOMAIN_EVENTS.ACCOUNT_DELETION_REQUESTED);
    expect(EMAIL_EVENT_NAMES).toContain(DOMAIN_EVENTS.ACCOUNT_DELETED);
  });

  test("the verification link opens the confirm page with the token in the fragment", () => {
    const email = resolveEmail(
      row(DOMAIN_EVENTS.ACCOUNT_DELETION_REQUESTED, {
        email: "parent@example.com",
        token: "a".repeat(64),
        expiresAt: "2026-09-27T01:00:00.000Z",
        schoolNames: ["Hill <School>", "Lake Academy"],
      }),
      context,
    );

    expect(email.template).toBe("account-deletion-verification");
    expect(email.recipient).toBe("parent@example.com");
    expect(email.content.text).toContain(
      `https://app.studafy.test/legal/delete-account/confirm#token=${"a".repeat(64)}`,
    );
    expect(email.content.text).toContain("Hill <School>, Lake Academy");
    expect(email.content.html).toContain("Hill &lt;School&gt;, Lake Academy");
    expect(email.content.html).not.toContain("<School>");
  });

  test("the confirmation names the school and the erasure deadline", () => {
    const email = resolveEmail(
      row(DOMAIN_EVENTS.ACCOUNT_DELETED, {
        userId: "00000000-0000-4000-8000-000000000002",
        email: "parent@example.com",
        completesBy: "2026-10-27T00:00:00.000Z",
      }),
      context,
    );

    expect(email.template).toBe("account-deletion-confirmation");
    expect(email.recipient).toBe("parent@example.com");
    expect(email.content.subject).toBe("Your Studafy account has been deleted");
    expect(email.content.text).toContain("Your Studafy account at Hill <School> has been deleted");
    expect(email.content.text).toContain(new Date("2026-10-27T00:00:00.000Z").toUTCString());
    expect(email.content.html).not.toContain("<School>");
  });
});
