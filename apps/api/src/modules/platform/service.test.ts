// eslint-disable-next-line import-x/no-unresolved -- "bun:test" is a virtual Bun built-in with no resolvable file path
import { describe, expect, test } from "bun:test";

import { aiBillingEffect, allowedTransitions, canTransition, retryEffect } from "./service";

import type { SchoolStatus } from "./schemas";

const ALL: readonly SchoolStatus[] = ["registered", "pending", "active", "suspended", "archived"];

describe("school lifecycle transitions", () => {
  test("match the table in docs/database/global-tables.md", () => {
    expect(allowedTransitions("registered")).toEqual(["active", "archived"]);
    expect(allowedTransitions("pending")).toEqual(["active", "archived"]);
    expect(allowedTransitions("active")).toEqual(["suspended", "archived"]);
    expect(allowedTransitions("suspended")).toEqual(["active", "archived"]);
  });

  test("archived is terminal", () => {
    for (const to of ALL) expect(canTransition("archived", to)).toBe(false);
  });

  test("a pending school cannot be suspended before it was ever active", () => {
    expect(canTransition("pending", "suspended")).toBe(false);
  });

  test("no state transitions to itself (re-sending is a retry, handled separately)", () => {
    for (const status of ALL) expect(canTransition(status, status)).toBe(false);
  });
});

describe("AI billing effect of a status change", () => {
  test("suspending or archiving a live school pauses AI billing", () => {
    expect(aiBillingEffect("active", "suspended")).toBe("pause");
    expect(aiBillingEffect("active", "archived")).toBe("pause");
    expect(aiBillingEffect("suspended", "archived")).toBe("pause");
    expect(aiBillingEffect("pending", "archived")).toBe("pause");
  });

  test("only reactivation from suspended resumes it", () => {
    expect(aiBillingEffect("suspended", "active")).toBe("resume");
    // A first activation has nothing paused to resume.
    expect(aiBillingEffect("pending", "active")).toBeNull();
  });

  test("a retry replays the direction the current status implies", () => {
    expect(retryEffect("suspended")).toBe("pause");
    expect(retryEffect("archived")).toBe("pause");
    expect(retryEffect("active")).toBe("resume");
    expect(retryEffect("pending")).toBeNull();
  });
});
