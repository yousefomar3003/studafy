// eslint-disable-next-line import-x/no-unresolved -- "bun:test" is a virtual Bun built-in with no resolvable file path
import { describe, expect, test } from "bun:test";

import { isUrgent, isWithinQuietHours } from "./quiet-hours";

describe("isWithinQuietHours — same-day window", () => {
  test("inside the window", () => {
    expect(isWithinQuietHours("13:30:00", "12:00:00", "14:00:00")).toBe(true);
  });

  test("before and after the window", () => {
    expect(isWithinQuietHours("11:59:59", "12:00:00", "14:00:00")).toBe(false);
    expect(isWithinQuietHours("14:00:01", "12:00:00", "14:00:00")).toBe(false);
  });

  test("both bounds are inclusive", () => {
    expect(isWithinQuietHours("12:00:00", "12:00:00", "14:00:00")).toBe(true);
    expect(isWithinQuietHours("14:00:00", "12:00:00", "14:00:00")).toBe(true);
  });
});

describe("isWithinQuietHours — window wrapping past midnight", () => {
  // 22:00–07:00 is the shape almost every real quiet-hours setting takes, and the one a naive
  // `now >= start && now <= end` gets exactly backwards — quiet all day except when asked for.
  const start = "22:00:00";
  const end = "07:00:00";

  test("late evening, after the start", () => {
    expect(isWithinQuietHours("23:15:00", start, end)).toBe(true);
  });

  test("early morning, before the end", () => {
    expect(isWithinQuietHours("03:00:00", start, end)).toBe(true);
  });

  test("midday is not quiet", () => {
    expect(isWithinQuietHours("12:00:00", start, end)).toBe(false);
  });

  test("the minute before the window opens is not quiet", () => {
    expect(isWithinQuietHours("21:59:59", start, end)).toBe(false);
  });

  test("the minute after it closes is not quiet", () => {
    expect(isWithinQuietHours("07:00:01", start, end)).toBe(false);
  });

  test("exact midnight is inside", () => {
    expect(isWithinQuietHours("00:00:00", start, end)).toBe(true);
  });
});

describe("isWithinQuietHours — degenerate input", () => {
  test("no window configured means never quiet", () => {
    expect(isWithinQuietHours("03:00:00", null, null)).toBe(false);
  });

  test("half a window is not a window", () => {
    // ck_user_notification_settings_quiet_hours makes this unreachable through the database, but a
    // caller that hand-builds the pair should not get "quiet forever" out of it.
    expect(isWithinQuietHours("03:00:00", "22:00:00", null)).toBe(false);
    expect(isWithinQuietHours("03:00:00", null, "07:00:00")).toBe(false);
  });

  test("a zero-length window suppresses nothing", () => {
    // The alternative reading — a point in time meaning "always" — would mute a user permanently,
    // and nothing downstream could tell that apart from a deliberate setting.
    expect(isWithinQuietHours("00:00:00", "00:00:00", "00:00:00")).toBe(false);
    expect(isWithinQuietHours("09:00:00", "09:00:00", "09:00:00")).toBe(false);
  });
});

describe("isWithinQuietHours — time formats", () => {
  test("HH:MM and HH:MM:SS.mmm compare like-for-like", () => {
    // postgres returns `time` as HH:MM:SS, but a hand-built fixture or a settings form may not.
    expect(isWithinQuietHours("23:15", "22:00", "07:00")).toBe(true);
    expect(isWithinQuietHours("23:15:00.123", "22:00:00", "07:00:00")).toBe(true);
    expect(isWithinQuietHours("09:00", "22:00:00", "07:00:00")).toBe(false);
  });
});

describe("isUrgent", () => {
  test("a published grade is not urgent", () => {
    expect(isUrgent("GRADE_POSTED")).toBe(false);
  });

  test("nothing is urgent yet", () => {
    // Deliberate: this asserts the current product decision rather than an implementation detail.
    // When something becomes urgent, this test is the place that has to say so out loud.
    expect(isUrgent("ATTENDANCE_ALERT")).toBe(false);
    expect(isUrgent("SUPPORT_MESSAGE")).toBe(false);
  });
});
