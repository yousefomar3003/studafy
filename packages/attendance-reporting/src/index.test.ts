// eslint-disable-next-line import-x/no-unresolved -- "bun:test" is a virtual Bun built-in
import { describe, expect, test } from "bun:test";

import { attendanceExportJobDataSchema } from "./index";

const validPayload = {
  version: 1,
  jobId: "f1eb83c0-ae1f-4b3a-962d-6db28640d68a",
  schoolId: "5f417184-d876-4e6a-88cb-9fd589141b54",
  requestedByUserId: "c9dac2e9-8b48-416f-a0dd-e21f6d6c1dac",
  filter: {
    termId: null,
    startDate: "2026-01-01",
    endDate: "2026-01-31",
  },
  groupBy: "class",
  trendInterval: "day",
  fileFormat: "xlsx",
};

describe("attendance export job payload", () => {
  test("accepts the versioned resolved contract", () => {
    expect(attendanceExportJobDataSchema.safeParse(validPayload).success).toBe(true);
  });

  test("rejects unknown versions, formats, and fields", () => {
    expect(attendanceExportJobDataSchema.safeParse({ ...validPayload, version: 2 }).success).toBe(
      false,
    );
    expect(
      attendanceExportJobDataSchema.safeParse({ ...validPayload, fileFormat: "csv" }).success,
    ).toBe(false);
    expect(
      attendanceExportJobDataSchema.safeParse({ ...validPayload, internalError: "secret" }).success,
    ).toBe(false);
  });
});
