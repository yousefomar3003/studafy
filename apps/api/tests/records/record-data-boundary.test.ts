/**
 * Where school-defined record data may never go (docs/modules/student-records.md "Where record
 * data never goes"): search, the AI module, notifications and email, reports and CSV/report
 * exports, analytics, the mobile surface, and every worker queue that feeds one of those. A static
 * pin, like audit-coverage.test.ts: none of those directories may name a record table, the sealed
 * column, or the records package. A new reach into record data from one of them fails here and
 * has to be argued for in review, not slipped in.
 */

import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, resolve } from "node:path";

// eslint-disable-next-line import-x/no-unresolved -- "bun:test" is a virtual Bun built-in with no resolvable file path
import { describe, expect, test } from "bun:test";

const APPS = resolve(import.meta.dir, "../../..");

const FORBIDDEN_DIRECTORIES = [
  "api/src/modules/search",
  "api/src/modules/ai",
  "api/src/modules/notifications",
  "api/src/modules/announcements",
  "api/src/modules/reports",
  "api/src/modules/mobile",
  "api/src/modules/messaging",
  "api/src/modules/finance",
  "api/src/email",
  "workers/src/queues/ai-ingestion",
  "workers/src/queues/exam-generation",
  "workers/src/queues/notifications",
  "workers/src/queues/announcements",
  "workers/src/queues/reports",
  "workers/src/queues/outbox-relay",
  "web/src/lib/analytics",
  "mobile/lib",
];

const MARKERS = [
  /\brecord_answers\b/,
  /\brecord_documents\b/,
  /\bvalue_ciphertext\b/,
  /@studafy\/records\b/,
  /\/api\/(students|parents)\/[^"'`]*\/records\b/,
];

function files(dir: string): string[] {
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return [];
  }
  return entries.flatMap((entry) => {
    const path = join(dir, entry);
    // Generated API clients list every endpoint and model by construction; they are the contract,
    // not a consumer, so only hand-written code is scanned.
    if (
      entry === "node_modules" ||
      entry === "dist" ||
      entry === "generated" ||
      entry.startsWith(".")
    ) {
      return [];
    }
    return statSync(path).isDirectory() ? files(path) : [path];
  });
}

describe("record data boundary", () => {
  test("no search, AI, notification, report, export, analytics or mobile code reaches record data", () => {
    const offenders: string[] = [];
    for (const directory of FORBIDDEN_DIRECTORIES) {
      for (const file of files(join(APPS, directory))) {
        if (!/\.(ts|tsx|dart|sql)$/.test(file)) continue;
        const text = readFileSync(file, "utf8");
        for (const marker of MARKERS) {
          if (marker.test(text)) offenders.push(`${relative(APPS, file)} matches ${marker}`);
        }
      }
    }
    expect(offenders).toEqual([]);
  });

  test("the scan actually covers code (a moved directory must update this list)", () => {
    const scanned = FORBIDDEN_DIRECTORIES.filter((directory) =>
      files(join(APPS, directory)).some((file) => /\.(ts|tsx|dart)$/.test(file)),
    );
    expect(scanned.length).toBeGreaterThanOrEqual(FORBIDDEN_DIRECTORIES.length - 2);
  });
});
