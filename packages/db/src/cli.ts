#!/usr/bin/env bun
import { auditRlsCoverage, formatRlsCoverageReport } from "../../../db/policies/rls-coverage";

import { createClient } from "./client";
import { loadMigrationConfig } from "./config";
import { MigrationError } from "./errors";
import {
  ATTENDANCE_PARTITIONS,
  AUDIT_LOG_PARTITIONS,
  ensureMonthlyPartitions,
  parseMonthsAhead,
} from "./partitions";
import { runMigrationCommand } from "./runner";
import { runSeedCommand, discoverSeedFiles } from "./seed";

import type { PartitionFamily } from "./partitions";
import type { MigrationCommand } from "./types";
import type { CatalogClient } from "../../../db/policies/rls-coverage";

const commands = new Set<MigrationCommand>(["migrate", "status", "validate", "pending"]);

// Each monthly-partitioned table family gets its own subcommand rather than one command that maintains
// everything, so an operator can schedule, retry, or roll back the maintenance of one family without
// touching the other.
const partitionCommands = new Map<string, PartitionFamily>([
  ["attendance-partitions", ATTENDANCE_PARTITIONS],
  ["audit-partitions", AUDIT_LOG_PARTITIONS],
]);

const USAGE =
  "Usage: db-migrate <migrate|status|validate|pending|seed|" +
  "attendance-partitions [months-ahead 0-24]|audit-partitions [months-ahead 0-24]|rls-coverage>";

async function runRlsCoverageCommand(): Promise<number> {
  const config = loadMigrationConfig();
  const client = createClient(config, "studafy-rls-coverage");
  try {
    const report = await auditRlsCoverage(client as unknown as CatalogClient);
    const output = formatRlsCoverageReport(report);
    if (report.compliant) console.log(output);
    else console.error(output);
    return report.compliant ? 0 : 1;
  } finally {
    await client.end({ timeout: 1 });
  }
}

export async function main(args: string[] = Bun.argv.slice(2)): Promise<number> {
  const requested = args[0];
  const rlsCoverage = requested === "rls-coverage";
  const isSeed = requested === "seed";
  const family = requested === undefined ? undefined : partitionCommands.get(requested);
  const command = requested as MigrationCommand | undefined;
  let monthsAhead: number | undefined;

  if (isSeed) {
    if (args.length !== 1) {
      console.error("Usage: db-migrate seed");
      return 2;
    }
  } else if (rlsCoverage) {
    if (args.length !== 1) {
      console.error("Usage: db-migrate rls-coverage");
      return 2;
    }
  } else if (family) {
    monthsAhead = parseMonthsAhead(args.slice(1));
    if (monthsAhead === undefined) {
      console.error(`Usage: db-migrate ${requested} [months-ahead 0-24]`);
      return 2;
    }
  } else if (!command || !commands.has(command) || args.length !== 1) {
    console.error(USAGE);
    return 2;
  }

  try {
    if (isSeed) {
      await runSeedCommand();
    } else if (rlsCoverage) {
      return await runRlsCoverageCommand();
    } else if (family) {
      await ensureMonthlyPartitions(family, monthsAhead!);
    } else {
      await runMigrationCommand(command!);
    }
    return 0;
  } catch (error) {
    if (rlsCoverage) {
      console.error(
        `RlsCoverageExecutionError: ${error instanceof Error ? error.message : "catalog audit failed"}`,
      );
      return 2;
    }
    if (error instanceof MigrationError) {
      console.error(`${error.name}: ${error.message}`);
    } else {
      console.error(
        family
          ? `MigrationExecutionError: ${family.label} partition maintenance failed`
          : "MigrationExecutionError: database migration failed",
      );
    }
    return 1;
  }
}

if (import.meta.main) process.exitCode = await main();
