/**
 * The report type registry (ST-175).
 *
 * The registry is the single source of truth for what the reports queue knows how to do, so the
 * unit tests pin its shape: exactly the attendance and finance entries, lookups that resolve by
 * job name (and nothing else), a full report-type surface per entry (schema, store, renderer,
 * storage key, content headers), and the two short-circuit paths of `processReportJob` that need
 * no database: an unknown job resolves unprocessed, and a known job with an unparseable payload
 * resolves unprocessed before any pool is queried.
 */

import { attendanceExportJobDataSchema } from "@studafy/attendance-reporting";
import { JOB_NAMES } from "@studafy/constants";
import { financeExportJobDataSchema } from "@studafy/finance-reporting";
// eslint-disable-next-line import-x/no-unresolved -- "bun:test" is a virtual Bun built-in with no resolvable file path
import { describe, expect, test } from "bun:test";

import { lookupReportType, processReportJob, REPORT_TYPE_REGISTRY } from "./report-registry";

import type { ReportRunnerConfig } from "./report-types";
import type { Job } from "bullmq";

const attendancePayload = attendanceExportJobDataSchema.parse({
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

const financePayload = financeExportJobDataSchema.parse({
  version: 1,
  jobId: "f1eb83c0-ae1f-4b3a-962d-6db28640d68a",
  schoolId: "5f417184-d876-4e6a-88cb-9fd589141b54",
  requestedByUserId: "c9dac2e9-8b48-416f-a0dd-e21f6d6c1dac",
});

describe("REPORT_TYPE_REGISTRY", () => {
  test("registers exactly the attendance and finance report types", () => {
    expect(REPORT_TYPE_REGISTRY.map((entry) => entry.jobName).sort()).toEqual(
      [JOB_NAMES.GENERATE_ATTENDANCE_EXPORT, JOB_NAMES.GENERATE_FINANCE_REPORT].sort(),
    );
  });

  test("lookup resolves both report types by job name and nothing else", () => {
    expect(lookupReportType(JOB_NAMES.GENERATE_ATTENDANCE_EXPORT)).toBe(REPORT_TYPE_REGISTRY[0]);
    expect(lookupReportType(JOB_NAMES.GENERATE_FINANCE_REPORT)).toBe(REPORT_TYPE_REGISTRY[1]);
    expect(lookupReportType("no-such-report")).toBeUndefined();
    // The purge sweep is a scheduled job, not a report type, so it is dispatched by name outside
    // the registry rather than living in it.
    expect(lookupReportType(JOB_NAMES.PURGE_EXPIRED_REPORTS)).toBeUndefined();
  });

  test("every entry is a complete report type: schema, store, renderer, key and headers", () => {
    for (const entry of REPORT_TYPE_REGISTRY) {
      const payload =
        entry.jobName === JOB_NAMES.GENERATE_ATTENDANCE_EXPORT ? attendancePayload : financePayload;

      expect(entry.schema.safeParse(payload).success).toBe(true);
      expect(typeof entry.render).toBe("function");
      expect(typeof entry.store.claim).toBe("function");
      expect(typeof entry.store.complete).toBe("function");
      expect(typeof entry.store.fail).toBe("function");
      expect(typeof entry.store.persistsSignedUrl).toBe("boolean");

      expect(entry.storageKey(payload)).toMatch(/\/?reports\//);
      expect(entry.contentType(payload)).toBeTruthy();
      expect(entry.contentDisposition(payload)).toContain("attachment;");
    }
  });
});

describe("processReportJob", () => {
  test("resolves unprocessed for an unknown job name without opening any ports", async () => {
    const job = { id: "1", name: "no-such-report", data: {} } as unknown as Job;

    await expect(processReportJob(job, {} as ReportRunnerConfig)).resolves.toEqual({
      processed: false,
      reason: "unknown report job",
    });
  });

  test("resolves unprocessed for a known job whose payload does not parse, before any query", async () => {
    const job = {
      id: "1",
      name: JOB_NAMES.GENERATE_ATTENDANCE_EXPORT,
      data: { nope: true },
      attemptsMade: 0,
      opts: {},
    } as unknown as Job;
    const config: ReportRunnerConfig = {
      // Unreachable: the schema parse fails before the runner touches the pool.
      primaryDatabaseUrl: "postgres://localhost:1/unused",
      s3Region: "us-east-1",
      bucket: "unused",
    };

    await expect(processReportJob(job, config)).resolves.toEqual({
      processed: false,
      reason: "invalid job data",
    });
  });
});
