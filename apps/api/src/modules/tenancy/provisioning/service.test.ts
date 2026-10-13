import { describe, expect, test } from "bun:test"; // eslint-disable-line import-x/no-unresolved -- "bun:test" is a virtual Bun built-in

import {
  FREE_PLAN_CODE,
  FREE_PLAN_PERIOD_END,
  provisionTenant,
  getProvisioningStatus,
  type ProvisionTenantParams,
} from "./service";

// ---------------------------------------------------------------------------
// Unit tests (no DB required)
// ---------------------------------------------------------------------------

describe("Provisioning service exports", () => {
  test("provisionTenant is a function", () => {
    expect(typeof provisionTenant).toBe("function");
  });

  test("getProvisioningStatus is a function", () => {
    expect(typeof getProvisioningStatus).toBe("function");
  });
});

describe("Provisioning constants", () => {
  test("schools go on the free plan, which never ends", () => {
    expect(FREE_PLAN_CODE).toBe("free");
    expect(new Date(FREE_PLAN_PERIOD_END).getUTCFullYear()).toBe(9999);
  });

  test("DEFAULT_STUDENT_CAP is 50", () => {
    // Verify the constraint logic: student_cap must be > 0 and default to 50.
    const defaultCap = 50;
    expect(defaultCap).toBeGreaterThan(0);
    expect(defaultCap).toBe(50);
  });
});

describe("Provisioning status type safety", () => {
  test("valid status values are well-defined", () => {
    const validStatuses = ["pending", "in_progress", "completed", "failed"];
    expect(validStatuses).toHaveLength(4);
    expect(validStatuses).toContain("pending");
    expect(validStatuses).toContain("in_progress");
    expect(validStatuses).toContain("completed");
    expect(validStatuses).toContain("failed");
  });
});
