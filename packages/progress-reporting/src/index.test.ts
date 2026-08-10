// eslint-disable-next-line import-x/no-unresolved -- "bun:test" is a virtual Bun built-in
import { describe, expect, test } from "bun:test";

import { progressReportJobDataSchema } from "./index";

const valid = {
  version: 1 as const,
  jobId: "f1eb83c0-ae1f-4b3a-962d-6db28640d68a",
  schoolId: "5f417184-d876-4e6a-88cb-9fd589141b54",
  requestedByUserId: "c9dac2e9-8b48-416f-a0dd-e21f6d6c1dac",
  studentId: "0c2b7a5e-9f1d-4e2a-b7c3-6f8d1a2b3c4d",
  termId: "3e7c9d21-5a4b-4c8d-9e2f-1a2b3c4d5e6f",
};

describe("progressReportJobDataSchema", () => {
  test("parses a complete payload", () => {
    expect(progressReportJobDataSchema.parse(valid)).toEqual(valid);
  });

  test("rejects a payload missing a required field", () => {
    const { studentId: _studentId, ...missingStudent } = valid;
    expect(progressReportJobDataSchema.safeParse(missingStudent).success).toBe(false);
  });

  test("rejects an unknown field (strict)", () => {
    expect(progressReportJobDataSchema.safeParse({ ...valid, nope: true }).success).toBe(false);
  });

  test("rejects a non-uuid identifier", () => {
    expect(progressReportJobDataSchema.safeParse({ ...valid, termId: "not-a-uuid" }).success).toBe(
      false,
    );
  });
});
