/**
 * Report type registry and queue dispatch (ST-175).
 *
 * The registry is the single source of truth for what the `reports` queue knows how to do. Each
 * entry is a complete, self-describing report type — payload schema, state store, renderer, storage
 * key and content headers — so adding a third report type is one entry here plus a store/renderer,
 * with no lifecycle code. `processReportJob` is what the queue registry hands a REPORTS job to: it
 * routes the scheduled purge sweep to `purgeExpiredReports` and every known report job to the
 * generic runner, resolving `{ processed: false }` for anything else.
 */

import { attendanceExportJobDataSchema } from "@studafy/attendance-reporting";
import { JOB_NAMES } from "@studafy/constants";
import { financeExportJobDataSchema } from "@studafy/finance-reporting";
import { progressReportJobDataSchema } from "@studafy/progress-reporting";

import { workerLogger } from "../../log";

import {
  attendanceContentDisposition,
  attendanceContentType,
  attendanceReportStorageKey,
  renderAttendanceExport,
} from "./attendance-export.worker";
import { createAttendanceReportStore } from "./attendance-report-store";
import {
  financeContentDisposition,
  financeContentType,
  financeReportStorageKey,
  renderFinanceExport,
} from "./finance-export.worker";
import { createFinanceReportStore } from "./finance-report-store";
import { createProgressReportStore } from "./progress-report-store";
import {
  progressContentDisposition,
  progressContentType,
  progressReportStorageKey,
  renderProgressReport,
} from "./progress-report.worker";
import { purgeExpiredReports } from "./report-expiry-sweep";
import {
  closeReportPorts,
  createPrimaryPool,
  createReportStorage,
  openReportPorts,
  runReport,
} from "./report-runner";

import type { FinanceReportJobRow } from "./finance-report-store";
import type { ReportRunResult, ReportRunnerConfig, ReportTypeDefinition } from "./report-types";
import type { AttendanceExportJobData } from "@studafy/attendance-reporting";
import type { FinanceExportJobData } from "@studafy/finance-reporting";
import type { ProgressReportJobData } from "@studafy/progress-reporting";
import type { Job } from "bullmq";

const attendanceExportDefinition: ReportTypeDefinition<AttendanceExportJobData> = {
  jobName: JOB_NAMES.GENERATE_ATTENDANCE_EXPORT,
  schema: attendanceExportJobDataSchema,
  store: createAttendanceReportStore(),
  render: renderAttendanceExport,
  storageKey: attendanceReportStorageKey,
  contentType: attendanceContentType,
  contentDisposition: attendanceContentDisposition,
};

const financeExportDefinition: ReportTypeDefinition<FinanceExportJobData, FinanceReportJobRow> = {
  jobName: JOB_NAMES.GENERATE_FINANCE_REPORT,
  schema: financeExportJobDataSchema,
  store: createFinanceReportStore(),
  render: renderFinanceExport,
  // The finance storage key and content headers depend on fields only known from the job row
  // (file format, created_at) that the store reads at claim time.
  storageKey: (data, record) =>
    financeReportStorageKey(data, record?.file_format ?? "pdf", record?.created_at ?? new Date()),
  contentType: (_data, record) => financeContentType(record?.file_format ?? "pdf"),
  contentDisposition: (data, record) =>
    financeContentDisposition(data, record?.file_format ?? "pdf"),
};

const progressReportDefinition: ReportTypeDefinition<ProgressReportJobData> = {
  jobName: JOB_NAMES.GENERATE_PROGRESS_REPORT,
  schema: progressReportJobDataSchema,
  store: createProgressReportStore(),
  render: renderProgressReport,
  storageKey: progressReportStorageKey,
  contentType: progressContentType,
  contentDisposition: progressContentDisposition,
};

export const REPORT_TYPE_REGISTRY: readonly ReportTypeDefinition[] = [
  attendanceExportDefinition,
  financeExportDefinition,
  progressReportDefinition,
];

export function lookupReportType(jobName: string): ReportTypeDefinition | undefined {
  return REPORT_TYPE_REGISTRY.find((definition) => definition.jobName === jobName);
}

export async function processReportJob(
  job: Job,
  config: ReportRunnerConfig,
): Promise<ReportRunResult> {
  if (job.name === JOB_NAMES.PURGE_EXPIRED_REPORTS) {
    await purgeExpiredReportArtifacts(config);
    return { processed: true };
  }

  const definition = lookupReportType(job.name);
  if (!definition) return { processed: false, reason: "unknown report job" };

  const ports = openReportPorts(config);
  try {
    return await runReport(job, definition, config, ports);
  } finally {
    await closeReportPorts(ports);
  }
}

async function purgeExpiredReportArtifacts(config: ReportRunnerConfig): Promise<void> {
  const primary = createPrimaryPool(config);
  try {
    await purgeExpiredReports(primary, createReportStorage(config), new Date(), workerLogger);
  } finally {
    await primary.end({ timeout: 5 });
  }
}
