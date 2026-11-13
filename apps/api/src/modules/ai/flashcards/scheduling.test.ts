// eslint-disable-next-line import-x/no-unresolved -- "bun:test" is a virtual Bun built-in with no resolvable file path
import { describe, expect, test } from "bun:test";

import { FLASHCARD_DEFAULT_EASE_FACTOR, scheduleCard } from "./scheduling";

import type { FlashcardProgress } from "./scheduling";

const NOW = new Date("2026-01-15T09:00:00.000Z");

describe("scheduleCard (SM-2)", () => {
  test("a fresh card rated good starts the ladder at 1 day", () => {
    const scheduled = scheduleCard(null, "good", NOW);

    expect(scheduled.repetitions).toBe(1);
    expect(scheduled.intervalDays).toBe(1);
    expect(scheduled.easeFactor).toBe(FLASHCARD_DEFAULT_EASE_FACTOR);
    expect(scheduled.dueAt).toEqual(new Date("2026-01-16T09:00:00.000Z"));
  });

  test("a fresh card rated again fails back to 1 day and lowers the ease factor", () => {
    const scheduled = scheduleCard(null, "again", NOW);

    expect(scheduled.repetitions).toBe(0);
    expect(scheduled.intervalDays).toBe(1);
    expect(scheduled.easeFactor).toBe(1.96);
    expect(scheduled.dueAt).toEqual(new Date("2026-01-16T09:00:00.000Z"));
  });

  test("the second pass moves the interval to 6 days", () => {
    const scheduled = scheduleCard(
      { intervalDays: 1, easeFactor: 2.5, repetitions: 1 },
      "good",
      NOW,
    );

    expect(scheduled.repetitions).toBe(2);
    expect(scheduled.intervalDays).toBe(6);
    expect(scheduled.easeFactor).toBe(2.5);
    expect(scheduled.dueAt).toEqual(new Date("2026-01-21T09:00:00.000Z"));
  });

  test("from the third pass on, the interval grows by the ease factor", () => {
    const scheduled = scheduleCard(
      { intervalDays: 6, easeFactor: 2.5, repetitions: 2 },
      "good",
      NOW,
    );

    expect(scheduled.repetitions).toBe(3);
    expect(scheduled.intervalDays).toBe(15);
    expect(scheduled.easeFactor).toBe(2.5);
    expect(scheduled.dueAt).toEqual(new Date("2026-01-30T09:00:00.000Z"));
  });

  test("hard lowers the ease factor but keeps the interval ladder", () => {
    const scheduled = scheduleCard(null, "hard", NOW);

    expect(scheduled.repetitions).toBe(1);
    expect(scheduled.intervalDays).toBe(1);
    expect(scheduled.easeFactor).toBe(2.36);
  });

  test("easy raises the ease factor", () => {
    const scheduled = scheduleCard(
      { intervalDays: 6, easeFactor: 2.5, repetitions: 2 },
      "easy",
      NOW,
    );

    expect(scheduled.easeFactor).toBe(2.6);
    expect(scheduled.intervalDays).toBe(16);
    expect(scheduled.repetitions).toBe(3);
  });

  test("a fail resets a matured card back to 1 day and repetitions 0", () => {
    const scheduled = scheduleCard(
      { intervalDays: 15, easeFactor: 2.5, repetitions: 3 },
      "again",
      NOW,
    );

    expect(scheduled.repetitions).toBe(0);
    expect(scheduled.intervalDays).toBe(1);
    expect(scheduled.easeFactor).toBe(1.96);
    expect(scheduled.dueAt).toEqual(new Date("2026-01-16T09:00:00.000Z"));
  });

  test("the ease factor never drops below the SM-2 floor of 1.3", () => {
    let progress: FlashcardProgress | null = null;
    for (let index = 0; index < 10; index += 1) {
      progress = scheduleCard(progress, "again", NOW);
    }

    expect(progress?.easeFactor).toBe(1.3);
  });

  test("is deterministic: identical inputs always produce identical output", () => {
    const first = scheduleCard(null, "good", NOW);
    const second = scheduleCard(null, "good", NOW);

    expect(second).toEqual(first);
  });

  test("dueAt honors whole days from the review instant, not from epoch", () => {
    const evening = new Date("2026-01-15T23:59:59.000Z");
    const scheduled = scheduleCard(null, "good", evening);

    expect(scheduled.dueAt).toEqual(new Date("2026-01-16T23:59:59.000Z"));
  });
});
