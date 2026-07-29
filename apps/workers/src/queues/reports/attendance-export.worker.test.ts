import { attendanceExportJobDataSchema } from "@studafy/attendance-reporting";
// eslint-disable-next-line import-x/no-unresolved -- "bun:test" is a virtual Bun built-in
import { describe, expect, test } from "bun:test";

import { attendanceReportStorageKey, isFinalExportAttempt } from "./attendance-export.worker";

const payload = attendanceExportJobDataSchema.parse({
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
});

describe("attendance export worker lifecycle", () => {
  test("uses the deterministic tenant/job report key", () => {
    expect(attendanceReportStorageKey(payload)).toBe(
      `reports/${payload.schoolId}/${payload.jobId}/attendance-summary.xlsx`,
    );
    expect(attendanceReportStorageKey({ ...payload, fileFormat: "pdf" })).toBe(
      `reports/${payload.schoolId}/${payload.jobId}/attendance-summary.pdf`,
    );
  });

  test("only treats the last configured attempt as terminal", () => {
    expect(isFinalExportAttempt(0, 3)).toBe(false);
    expect(isFinalExportAttempt(1, 3)).toBe(false);
    expect(isFinalExportAttempt(2, 3)).toBe(true);
    expect(isFinalExportAttempt(0, undefined)).toBe(true);
  });
});
