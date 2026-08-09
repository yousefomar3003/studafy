/**
 * The generic report runner (ST-175), against in-memory fakes.
 *
 * The runner only talks to the `ReportStateStore` and `ReportS3Client` ports, so a unit test needs
 * no database and no network: a fake store records claim/complete/fail, a fake S3 client records
 * put/presign, and the renderer is swapped per test. The acceptance the tests prove is the shared
 * lifecycle — claim before render, artifact uploaded with the definition's headers, ready only
 * after render, failed only on the final BullMQ attempt, signed URL only when the store persists
 * it — plus the async-verified ordering that a concurrent client sees `processing` before render.
 */

// eslint-disable-next-line import-x/no-unresolved -- "bun:test" is a virtual Bun built-in with no resolvable file path
import { describe, expect, test } from "bun:test";
import { z } from "zod";

import { createReportStorage, runReport } from "./report-runner";

import type { ReportClaim, ReportStateStore } from "./report-state-store";
import type {
  ReportJobContext,
  ReportRenderDeps,
  ReportRunnerConfig,
  ReportS3Client,
  ReportTypeDefinition,
  SignedUrlInfo,
} from "./report-types";
import type { Job } from "bullmq";
import type { Sql } from "postgres";

const schema = z.object({
  jobId: z.string(),
  schoolId: z.string(),
  requestedByUserId: z.string(),
});

interface ReportRow {
  format: "csv" | "pdf";
}

class FakeReportS3 implements ReportS3Client {
  puts: {
    key: string;
    artifact: Uint8Array;
    contentType: string;
    contentDisposition: string;
  }[] = [];
  removed: string[] = [];
  presigned: string[] = [];

  async put(
    key: string,
    artifact: Uint8Array,
    options: { contentType: string; contentDisposition: string },
  ): Promise<void> {
    this.puts.push({
      key,
      artifact,
      contentType: options.contentType,
      contentDisposition: options.contentDisposition,
    });
  }

  async remove(key: string): Promise<void> {
    this.removed.push(key);
  }

  async presignGet(key: string): Promise<string> {
    this.presigned.push(key);
    return `https://signed.example/${key}`;
  }
}

class FakeReportStore implements ReportStateStore<ReportRow> {
  persistsSignedUrl = false;
  claimResult: ReportClaim<ReportRow> = { state: "new", record: { format: "csv" } };
  claims: ReportJobContext[] = [];
  completed: { context: ReportJobContext; storageKey: string; signedUrl?: SignedUrlInfo }[] = [];
  failed: ReportJobContext[] = [];

  async claim(_sql: Sql, context: ReportJobContext): Promise<ReportClaim<ReportRow>> {
    this.claims.push(context);
    return this.claimResult;
  }

  async complete(
    _sql: Sql,
    context: ReportJobContext,
    storageKey: string,
    signedUrl?: SignedUrlInfo,
  ): Promise<void> {
    this.completed.push({ context, storageKey, signedUrl });
  }

  async fail(_sql: Sql, context: ReportJobContext): Promise<void> {
    this.failed.push(context);
  }
}

const config: ReportRunnerConfig = { primaryDatabaseUrl: "postgres://test.example" };

function makeJob(data: unknown, attempts: { attemptsMade?: number; attempts?: number } = {}): Job {
  return {
    id: "1",
    name: "test-report",
    data,
    attemptsMade: attempts.attemptsMade ?? 0,
    opts: { attempts: attempts.attempts ?? 3 },
  } as unknown as Job;
}

const context: ReportJobContext = {
  jobId: "job-1",
  schoolId: "school-1",
  requestedByUserId: "user-1",
};

function setup(
  render: (deps: ReportRenderDeps<ReportJobContext, ReportRow>) => Promise<Uint8Array> = async (
    _deps,
  ) => new Uint8Array([1, 2, 3]),
) {
  const store = new FakeReportStore();
  const s3 = new FakeReportS3();
  const renderCalls: ReportRenderDeps<ReportJobContext, ReportRow>[] = [];

  const definition: ReportTypeDefinition<ReportJobContext, ReportRow> = {
    jobName: "test-report",
    schema,
    store,
    render: (deps) => {
      renderCalls.push(deps);
      return render(deps);
    },
    storageKey: (data, record) =>
      `reports/${data.schoolId}/${data.jobId}/report.${record?.format ?? "csv"}`,
    contentType: (_data, record) => (record?.format === "pdf" ? "application/pdf" : "text/csv"),
    contentDisposition: (data) => `attachment; filename="report.${data.jobId}"`,
  };

  return { store, s3, renderCalls, definition };
}

describe("runReport", () => {
  test("resolves unprocessed when the payload is invalid without touching store or S3", async () => {
    const { store, s3, definition } = setup();
    const job = makeJob({ nope: true });

    const result = await runReport(job, definition, config, {
      primary: {} as unknown as Sql,
      s3,
    });

    expect(result).toEqual({ processed: false, reason: "invalid job data" });
    expect(store.claims).toHaveLength(0);
    expect(s3.puts).toHaveLength(0);
  });

  test("runs claim → render → put → complete and reports the artifact", async () => {
    const { store, s3, renderCalls, definition } = setup();

    const result = await runReport(makeJob(context), definition, config, {
      primary: {} as unknown as Sql,
      s3,
    });

    expect(renderCalls).toHaveLength(1);
    expect(renderCalls[0]!.context).toEqual(context);
    expect(renderCalls[0]!.data).toEqual(context);
    expect(renderCalls[0]!.record).toEqual({ format: "csv" });
    expect(renderCalls[0]!.now).toBeInstanceOf(Date);
    expect(renderCalls[0]!.config).toBe(config);

    expect(s3.puts).toHaveLength(1);
    expect(s3.puts[0]!.key).toBe("reports/school-1/job-1/report.csv");
    expect(s3.puts[0]!.artifact).toEqual(new Uint8Array([1, 2, 3]));
    expect(s3.puts[0]!.contentType).toBe("text/csv");
    expect(s3.puts[0]!.contentDisposition).toBe('attachment; filename="report.job-1"');

    expect(store.completed).toHaveLength(1);
    expect(store.completed[0]!.storageKey).toBe("reports/school-1/job-1/report.csv");
    expect(store.completed[0]!.signedUrl).toBeUndefined();
    expect(store.failed).toHaveLength(0);

    expect(result).toEqual({
      processed: true,
      storageKey: "reports/school-1/job-1/report.csv",
      bytes: 3,
    });
  });

  test("skips render and completion when the row was already terminal", async () => {
    const { store, s3, renderCalls, definition } = setup();
    store.claimResult = { state: "terminal" };

    const result = await runReport(makeJob(context), definition, config, {
      primary: {} as unknown as Sql,
      s3,
    });

    expect(result).toEqual({ processed: true });
    expect(renderCalls).toHaveLength(0);
    expect(s3.puts).toHaveLength(0);
    expect(store.completed).toHaveLength(0);
  });

  test("persists a signed URL when the store asks for it", async () => {
    const { store, s3, definition } = setup();
    store.persistsSignedUrl = true;

    const result = await runReport(makeJob(context), definition, config, {
      primary: {} as unknown as Sql,
      s3,
    });

    expect(s3.presigned).toEqual(["reports/school-1/job-1/report.csv"]);
    expect(store.completed[0]!.signedUrl).toEqual({
      url: "https://signed.example/reports/school-1/job-1/report.csv",
      expiresAt: expect.any(Date),
    });
    const ttl = store.completed[0]!.signedUrl!.expiresAt.getTime() - Date.now();
    expect(ttl).toBeGreaterThan(24 * 60 * 60 * 1000 - 5_000);
    expect(ttl).toBeLessThanOrEqual(24 * 60 * 60 * 1000);
    expect(result.processed).toBe(true);
  });

  test("a non-final failure rethrows and leaves the row unmarked so a retry can pick it up", async () => {
    const { store, s3, definition } = setup(async () => {
      throw new Error("render boom");
    });
    const job = makeJob(context, { attemptsMade: 0, attempts: 3 });

    await expect(
      runReport(job, definition, config, { primary: {} as unknown as Sql, s3 }),
    ).rejects.toThrow("render boom");

    expect(store.failed).toHaveLength(0);
    expect(store.completed).toHaveLength(0);
    expect(s3.puts).toHaveLength(0);
  });

  test("the final attempt marks the row failed and rethrows", async () => {
    const { store, s3, definition } = setup(async () => {
      throw new Error("render boom");
    });
    const job = makeJob(context, { attemptsMade: 2, attempts: 3 });

    await expect(
      runReport(job, definition, config, { primary: {} as unknown as Sql, s3 }),
    ).rejects.toThrow("render boom");

    expect(store.failed).toEqual([context]);
  });

  test("claims the row and starts rendering before the artifact exists (processing visible mid-render)", async () => {
    let resolveRender!: (artifact: Uint8Array) => void;
    const { store, s3, definition } = setup(
      () =>
        new Promise<Uint8Array>((resolve) => {
          resolveRender = resolve;
        }),
    );

    const running = runReport(makeJob(context), definition, config, {
      primary: {} as unknown as Sql,
      s3,
    });

    await new Promise<void>((resolve) => setTimeout(resolve, 0));
    expect(store.claims).toEqual([context]);
    expect(store.completed).toHaveLength(0);

    resolveRender(new Uint8Array([9]));
    const result = await running;
    expect(store.completed).toHaveLength(1);
    expect(s3.puts).toHaveLength(1);
    expect(result.bytes).toBe(1);
  });
});

describe("createReportStorage", () => {
  test("throws when storage is unconfigured", () => {
    expect(() => createReportStorage({ primaryDatabaseUrl: "postgres://test.example" })).toThrow(
      "report storage is not configured",
    );
  });

  test("returns an S3 client once bucket and region are configured", () => {
    const client = createReportStorage({
      primaryDatabaseUrl: "postgres://test.example",
      s3Region: "us-east-1",
      bucket: "reports-bucket",
    });
    expect(typeof client.put).toBe("function");
    expect(typeof client.remove).toBe("function");
    expect(typeof client.presignGet).toBe("function");
  });
});
