// eslint-disable-next-line import-x/no-unresolved -- "bun:test" is a virtual Bun built-in with no resolvable file path
import { describe, expect, test } from "bun:test";

import {
  canTransitionReport,
  REPORT_RESPONSE_HOURS,
  REPORT_SNAPSHOT_MAX_CHARS,
  reportPriority,
  reportRespondBy,
  toReportSnapshot,
} from "./reports";

describe("reportPriority", () => {
  test("child safety is urgent, harm is high, accuracy is normal", () => {
    expect(reportPriority("child_safety")).toBe("urgent");
    expect(reportPriority("unsafe")).toBe("high");
    expect(reportPriority("inappropriate")).toBe("high");
    expect(reportPriority("inaccurate")).toBe("normal");
    expect(reportPriority("other")).toBe("normal");
  });
});

describe("reportRespondBy", () => {
  test("adds the priority's response window", () => {
    const now = new Date("2026-09-28T10:00:00Z");
    expect(reportRespondBy("urgent", now).toISOString()).toBe("2026-09-29T10:00:00.000Z");
    expect(reportRespondBy("normal", now).getTime() - now.getTime()).toBe(
      REPORT_RESPONSE_HOURS.normal * 3_600_000,
    );
  });
});

describe("canTransitionReport", () => {
  test("the workflow moves forward only", () => {
    expect(canTransitionReport("pending", "in_review")).toBe(true);
    expect(canTransitionReport("pending", "escalated")).toBe(true);
    expect(canTransitionReport("in_review", "actioned")).toBe(true);
    expect(canTransitionReport("escalated", "actioned")).toBe(true);
    expect(canTransitionReport("in_review", "pending")).toBe(false);
    expect(canTransitionReport("escalated", "in_review")).toBe(false);
  });

  test("closed reports are final", () => {
    for (const to of ["pending", "in_review", "escalated", "actioned", "dismissed"] as const) {
      expect(canTransitionReport("actioned", to)).toBe(false);
      expect(canTransitionReport("dismissed", to)).toBe(false);
    }
  });
});

describe("toReportSnapshot", () => {
  test("keeps text within the column cap untouched", () => {
    expect(toReportSnapshot("short")).toBe("short");
  });

  test("cuts oversized text to the cap and marks the cut", () => {
    const snapshot = toReportSnapshot("x".repeat(REPORT_SNAPSHOT_MAX_CHARS + 10));
    expect(snapshot.length).toBe(REPORT_SNAPSHOT_MAX_CHARS);
    expect(snapshot.endsWith("[... truncated]")).toBe(true);
  });
});
