import { financeExportJobDataSchema } from "@studafy/finance-reporting";
// eslint-disable-next-line import-x/no-unresolved -- "bun:test" is a virtual Bun built-in
import { describe, expect, test } from "bun:test";
import { PDFDocument } from "pdf-lib";

import { financeReportStorageKey, reportsToPdf } from "./finance-export.worker";

const payload = financeExportJobDataSchema.parse({
  version: 1,
  jobId: "f1eb83c0-ae1f-4b3a-962d-6db28640d68a",
  schoolId: "5f417184-d876-4e6a-88cb-9fd589141b54",
  requestedByUserId: "c9dac2e9-8b48-416f-a0dd-e21f6d6c1dac",
});

describe("finance export worker", () => {
  test("uses the deterministic tenant/year/job object key", () => {
    expect(financeReportStorageKey(payload, "csv", new Date("2026-07-30T00:00:00Z"))).toBe(
      `tenant-${payload.schoolId}/reports/2026/${payload.jobId}.csv`,
    );
    expect(financeReportStorageKey(payload, "pdf", new Date("2026-12-31T23:59:59Z"))).toBe(
      `tenant-${payload.schoolId}/reports/2026/${payload.jobId}.pdf`,
    );
  });

  test("renders Arabic and mixed-direction rows with an embedded Arabic font", async () => {
    const bytes = await reportsToPdf([
      {
        title: "كشف حساب الأسرة",
        report: {
          columns: [
            { fieldname: "party", label: "الطالب" },
            { fieldname: "amount", label: "Amount (JOD)" },
          ],
          rows: [{ party: "أسرة أحمد 2026", amount: "12.345" }],
          reportSummary: [],
        },
      },
    ]);
    const document = await PDFDocument.load(bytes);
    expect(document.getPageCount()).toBe(1);
    expect(document.getSubject()).toContain("Noto Sans Arabic");
  });
});
