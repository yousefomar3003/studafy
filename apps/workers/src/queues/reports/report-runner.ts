/**
 * The generic report runner (ST-175).
 *
 * Takes a report type definition and a BullMQ job and sequences the shared lifecycle that the
 * attendance and finance workers previously copy-pasted:
 *
 *   parse payload → claim row (lock + processing) → render artifact → upload to S3
 *   → optionally pre-sign and persist a download URL → mark ready
 *
 * On a failed attempt it rethrows for BullMQ's retry and only marks the row `failed` once the
 * retries are exhausted (the shared `isFinalAttempt` helper). Every postgres pool it opens is
 * closed in `finally` regardless of outcome.
 */

import postgres from "postgres";

import { createReportS3, REPORT_SIGNED_URL_TTL_SECONDS } from "./report-s3";

import type {
  ReportTypeDefinition,
  ReportRunnerConfig,
  ReportRunResult,
  ReportS3Client,
} from "./report-types";
import type { Job } from "bullmq";
import type { Sql } from "postgres";

/** True when this delivery is the last BullMQ attempt, so the row should be marked failed. */
export function isFinalAttempt(attemptsMade: number, attempts: number | undefined): boolean {
  return attemptsMade + 1 >= (attempts ?? 1);
}

/** The database pools and S3 client a report run lives on, opened and closed per job. */
export interface ReportPorts {
  primary: Sql;
  replica?: Sql;
  s3: ReportS3Client;
}

export function createPrimaryPool(config: ReportRunnerConfig): Sql {
  return postgres(config.primaryDatabaseUrl, {
    max: 2,
    idle_timeout: 20,
    prepare: false,
    ...(config.databaseCaCert
      ? { ssl: { ca: config.databaseCaCert, rejectUnauthorized: true } }
      : {}),
  });
}

function createReplicaPool(config: ReportRunnerConfig): Sql | undefined {
  if (!config.readDatabaseUrl) return undefined;
  return postgres(config.readDatabaseUrl, {
    max: 3,
    idle_timeout: 20,
    prepare: false,
    ...(config.databaseCaCert
      ? { ssl: { ca: config.databaseCaCert, rejectUnauthorized: true } }
      : {}),
  });
}

export function openReportPorts(config: ReportRunnerConfig): ReportPorts {
  return {
    primary: createPrimaryPool(config),
    replica: createReplicaPool(config),
    s3: createReportStorage(config),
  };
}

export async function closeReportPorts(ports: ReportPorts): Promise<void> {
  const pools = [ports.primary, ...(ports.replica ? [ports.replica] : [])];
  await Promise.all(pools.map((pool) => pool.end({ timeout: 5 })));
}

/** Validate bucket/region and build the report S3 client, throwing when storage is unconfigured. */
export function createReportStorage(config: ReportRunnerConfig): ReportS3Client {
  const region = config.s3Region;
  const bucket = config.bucket;
  if (!region || !bucket) {
    throw new Error("report storage is not configured");
  }
  return createReportS3({ region, endpoint: config.s3Endpoint, bucket });
}

export async function runReport(
  job: Job,
  definition: ReportTypeDefinition,
  config: ReportRunnerConfig,
  ports: ReportPorts,
): Promise<ReportRunResult> {
  const parsed = definition.schema.safeParse(job.data);
  if (!parsed.success) return { processed: false, reason: "invalid job data" };
  const data = parsed.data;
  const context = {
    jobId: data.jobId,
    schoolId: data.schoolId,
    requestedByUserId: data.requestedByUserId,
  };

  try {
    const claim = await definition.store.claim(ports.primary, context);
    if (claim.state === "terminal") return { processed: true };

    const artifact = await definition.render({
      primary: ports.primary,
      replica: ports.replica,
      context,
      data,
      record: claim.record,
      now: new Date(),
      config,
    });
    const key = definition.storageKey(data, claim.record);
    await ports.s3.put(key, artifact, {
      contentType: definition.contentType(data, claim.record),
      contentDisposition: definition.contentDisposition(data, claim.record),
    });

    let signedUrl: { url: string; expiresAt: Date } | undefined;
    if (definition.store.persistsSignedUrl) {
      signedUrl = {
        url: await ports.s3.presignGet(key),
        expiresAt: new Date(Date.now() + REPORT_SIGNED_URL_TTL_SECONDS * 1000),
      };
    }
    await definition.store.complete(ports.primary, context, key, signedUrl);

    return { processed: true, storageKey: key, bytes: artifact.byteLength };
  } catch (error) {
    if (isFinalAttempt(job.attemptsMade, job.opts.attempts)) {
      await definition.store.fail(ports.primary, context);
    }
    throw error;
  }
}
