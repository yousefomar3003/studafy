#!/usr/bin/env bun
import { MigrationError } from "./errors";
import { runMigrationCommand } from "./runner";

import type { MigrationCommand } from "./types";

const commands = new Set<MigrationCommand>(["migrate", "status", "validate", "pending"]);

export async function main(args: string[] = Bun.argv.slice(2)): Promise<number> {
  const command = args[0] as MigrationCommand | undefined;
  if (!command || !commands.has(command) || args.length !== 1) {
    console.error("Usage: db-migrate <migrate|status|validate|pending>");
    return 2;
  }

  try {
    await runMigrationCommand(command);
    return 0;
  } catch (error) {
    if (error instanceof MigrationError) {
      console.error(`${error.name}: ${error.message}`);
    } else {
      console.error("MigrationExecutionError: database migration failed");
    }
    return 1;
  }
}

if (import.meta.main) process.exitCode = await main();
