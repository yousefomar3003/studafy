// eslint-disable-next-line import-x/no-unresolved -- "bun:test" is a virtual Bun built-in
import { describe, expect, test } from "bun:test";

import {
  attendanceExportBodySchema,
  attendanceSummaryQuerySchema,
  attendanceTrendsQuerySchema,
} from "../reports/schemas";

const termId = "6a8df258-15fd-4ac8-af36-c934bdde23e7";

describe("attendance report request schemas", () => {
  test("requires exactly one supported period selector", () => {
    expect(attendanceSummaryQuerySchema.safeParse({}).success).toBe(false);
    expect(attendanceSummaryQuerySchema.safeParse({ term_id: termId }).success).toBe(true);
    expect(
      attendanceSummaryQuerySchema.safeParse({
        start_date: "2026-01-01",
        end_date: "2026-12-31",
      }).success,
    ).toBe(true);
    expect(
      attendanceSummaryQuerySchema.safeParse({
        term_id: termId,
        start_date: "2026-01-01",
        end_date: "2026-01-31",
      }).success,
    ).toBe(false);
  });

  test("requires both range endpoints and caps inclusive ranges at 366 days", () => {
    expect(attendanceTrendsQuerySchema.safeParse({ start_date: "2026-01-01" }).success).toBe(false);
    expect(
      attendanceTrendsQuerySchema.safeParse({
        start_date: "2024-01-01",
        end_date: "2024-12-31",
      }).success,
    ).toBe(true);
    expect(
      attendanceTrendsQuerySchema.safeParse({
        start_date: "2024-01-01",
        end_date: "2025-01-01",
      }).success,
    ).toBe(false);
    expect(
      attendanceTrendsQuerySchema.safeParse({
        start_date: "2026-02-01",
        end_date: "2026-01-01",
      }).success,
    ).toBe(false);
  });

  test("applies summary pagination and grouping defaults", () => {
    const parsed = attendanceSummaryQuerySchema.parse({ term_id: termId });
    expect(parsed).toMatchObject({ group_by: "class", limit: 100, offset: 0 });
    expect(attendanceSummaryQuerySchema.safeParse({ term_id: termId, limit: 501 }).success).toBe(
      false,
    );
  });

  test("validates trend and export enum values", () => {
    expect(attendanceTrendsQuerySchema.parse({ term_id: termId }).interval).toBe("day");
    expect(
      attendanceTrendsQuerySchema.safeParse({ term_id: termId, interval: "quarter" }).success,
    ).toBe(false);
    expect(
      attendanceExportBodySchema.safeParse({
        term_id: termId,
        file_format: "csv",
      }).success,
    ).toBe(false);

    const exportRequest = attendanceExportBodySchema.parse({
      term_id: termId,
      file_format: "xlsx",
    });
    expect(exportRequest).toMatchObject({
      group_by: "class",
      trend_interval: "day",
      file_format: "xlsx",
    });
  });
});
