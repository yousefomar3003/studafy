/**
 * Dead-lettering (ST-139).
 *
 * Everything here is pure and needs neither Redis nor a database. That is by design: the BullMQ
 * wiring in `createBullmqWorker` is a two-line adapter, and the decisions worth testing —
 * *is this failure terminal*, and *what gets recorded* — are in plain functions it calls.
 *
 * The end-to-end path (a dead-letter row plus its outbox event) is covered in
 * __tests__/dispatcher.test.ts, where a real database is already stood up.
 */

// eslint-disable-next-line import-x/no-unresolved -- "bun:test" is a virtual Bun built-in with no resolvable file path
import { describe, expect, test } from "bun:test";

import {
  deadLetterListener,
  describeError,
  isTerminalFailure,
  MAX_ERROR_MESSAGE_LENGTH,
  schoolIdFromJobData,
  truncate,
} from "./dead-letter";

import type { DeadLetterLogger, FailedJobLike } from "./dead-letter";

function job(overrides: Partial<FailedJobLike> = {}): FailedJobLike {
  return {
    id: "job-1",
    name: "dispatch-notification",
    data: { schoolId: "11111111-1111-4111-8111-111111111111" },
    attemptsMade: 5,
    ...overrides,
  };
}

function recordingLogger(): DeadLetterLogger & { lines: { level: string; event: unknown }[] } {
  const lines: { level: string; event: unknown }[] = [];
  return {
    lines,
    warn: (fields) => lines.push({ level: "warn", event: fields.event }),
    error: (fields) => lines.push({ level: "error", event: fields.event }),
  };
}

describe("isTerminalFailure", () => {
  test("a job with finishedOn is terminal", () => {
    expect(isTerminalFailure(job({ finishedOn: Date.now() }))).toBe(true);
  });

  test("an intermediate attempt is not", () => {
    // BullMQ emits `failed` on every attempt; only the last one sets finishedOn.
    expect(isTerminalFailure(job({ attemptsMade: 2 }))).toBe(false);
  });

  test("a stalled-out job is terminal even below the attempt limit", () => {
    // The case an in-processor `attemptsMade + 1 >= attempts` check cannot see at all: BullMQ fails
    // a stalled job as UnrecoverableError without ever invoking the processor, at an attempt count
    // well under the limit. finishedOn is set, so this is still terminal.
    expect(isTerminalFailure(job({ attemptsMade: 2, finishedOn: Date.now() }))).toBe(true);
  });

  test("an undefined job is not terminal", () => {
    expect(isTerminalFailure(undefined)).toBe(false);
  });
});

describe("truncate", () => {
  test("leaves a short value alone", () => {
    expect(truncate("short", 100)).toBe("short");
  });

  test("respects the limit exactly", () => {
    const result = truncate("x".repeat(500), 100);
    expect(result).toHaveLength(100);
  });

  test("marks that it truncated", () => {
    expect(truncate("x".repeat(50), 10).endsWith("…")).toBe(true);
  });
});

describe("describeError", () => {
  test("carries the constructor name, not the message", () => {
    class ProviderTimeout extends Error {}
    const { errorClass } = describeError(new ProviderTimeout("upstream took too long"));
    expect(errorClass).toBe("ProviderTimeout");
  });

  test("an empty message still produces a non-blank one", () => {
    // error_message is NOT NULL with a non-blank CHECK, so "" would abort the transaction that is
    // trying to record the failure.
    expect(describeError(new Error("")).message).toBe("(no message)");
    expect(describeError(new Error("   ")).message).toBe("(no message)");
  });

  test("an overlong message is truncated to the column limit", () => {
    const { message } = describeError(new Error("y".repeat(5000)));
    expect(message).toHaveLength(MAX_ERROR_MESSAGE_LENGTH);
  });
});

describe("schoolIdFromJobData", () => {
  test("reads schoolId from well-formed job data", () => {
    expect(schoolIdFromJobData({ schoolId: "abc" })).toBe("abc");
  });

  test("returns null for anything it cannot attribute", () => {
    // app.notification_dead_letters.school_id is NOT NULL with a foreign key, so there is no row to
    // write and no tenant transaction to open. The caller logs instead.
    expect(schoolIdFromJobData(null)).toBeNull();
    expect(schoolIdFromJobData("a string")).toBeNull();
    expect(schoolIdFromJobData({})).toBeNull();
    expect(schoolIdFromJobData({ schoolId: "" })).toBeNull();
    expect(schoolIdFromJobData({ schoolId: 42 })).toBeNull();
  });
});

describe("deadLetterListener", () => {
  test("ignores an intermediate failure without touching the database", () => {
    const log = recordingLogger();
    // An unreachable URL: if the listener tried to connect, this would surface as a logged write
    // failure rather than silence.
    const listener = deadLetterListener("postgres://127.0.0.1:1/nope", log);

    listener(job({ attemptsMade: 1 }), new Error("transient"));

    expect(log.lines).toEqual([]);
  });

  test("logs and does not throw when the job cannot be attributed to a school", async () => {
    const log = recordingLogger();
    const listener = deadLetterListener("postgres://127.0.0.1:1/nope", log);

    listener(job({ data: {}, finishedOn: Date.now() }), new Error("boom"));
    await Promise.resolve();

    expect(log.lines.map((line) => line.event)).toEqual([
      "notification_dispatch_dead_lettered",
      "notification_dead_letter_unattributable",
    ]);
  });

  test("swallows a failing write rather than becoming an unhandled rejection", async () => {
    // BullMQ does not await its listeners, so a rejected promise here would take down the worker
    // process over a failure it was only trying to record.
    const log = recordingLogger();
    const listener = deadLetterListener("postgres://127.0.0.1:1/definitely-not-a-database", log);

    expect(() => {
      listener(job({ finishedOn: Date.now() }), new Error("boom"));
    }).not.toThrow();

    // Give the swallowed rejection a chance to land before asserting.
    await new Promise((resolve) => setTimeout(resolve, 250));

    expect(log.lines[0]?.event).toBe("notification_dispatch_dead_lettered");
    expect(log.lines.map((line) => line.event)).toContain("notification_dead_letter_write_failed");
  });
});
