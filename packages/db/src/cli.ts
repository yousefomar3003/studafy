#!/usr/bin/env bun
import { ensureAttendancePartitions, parseMonthsAhead } from "./attendance-partitions";
import { MigrationError } from "./errors";
import { runMigrationCommand } from "./runner";

import type { MigrationCommand } from "./types";

const commands = new Set<MigrationCommand>(["migrate", "status", "validate", "pending"]);

export async function main(args: string[] = Bun.argv.slice(2)): Promise<number> {
  const requested = args[0];
  const attendanceCommand = requested === "attendance-partitions";
  const command = requested as MigrationCommand | undefined;
  let monthsAhead: number | undefined;

  if (attendanceCommand) {
    monthsAhead = parseMonthsAhead(args.slice(1));
    if (monthsAhead === undefined) {
      console.error("Usage: db-migrate attendance-partitions [months-ahead 0-24]");
      return 2;
    }
  } else if (!command || !commands.has(command) || args.length !== 1) {
    console.error(
      "Usage: db-migrate <migrate|status|validate|pending|attendance-partitions [months-ahead 0-24]>",
    );
    return 2;
  }

  try {
    if (attendanceCommand) {
      await ensureAttendancePartitions(monthsAhead!);
    } else {
      await runMigrationCommand(command!);
    }
    return 0;
  } catch (error) {
    if (error instanceof MigrationError) {
      console.error(`${error.name}: ${error.message}`);
    } else {
      console.error(
        attendanceCommand
          ? "MigrationExecutionError: attendance partition maintenance failed"
          : "MigrationExecutionError: database migration failed",
      );
    }
    return 1;
  }
}

if (import.meta.main) process.exitCode = await main();
