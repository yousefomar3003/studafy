// eslint-disable-next-line import-x/no-unresolved -- "bun:test" is a virtual Bun built-in with no resolvable file path
import { describe, expect, test } from "bun:test";

import { FALLBACK_LOCALE, render, resolveLocale, resolveRoute } from "./renderer";

const GRADE_VARS = {
  courseName: "Biology 101",
  assignmentName: "Lab Report 3",
  grade: "85/100",
};

describe("resolveLocale", () => {
  test("the recipient's own locale wins", () => {
    expect(resolveLocale("ar", "en")).toBe("ar");
  });

  test("falls back to the school's when the recipient has none", () => {
    expect(resolveLocale(null, "ar")).toBe("ar");
    expect(resolveLocale(undefined, "ar")).toBe("ar");
  });

  test("falls back to English when neither is set", () => {
    expect(resolveLocale(null, null)).toBe(FALLBACK_LOCALE);
    expect(resolveLocale(null, null)).toBe("en");
  });

  test("a locale with no templates falls through instead of being trusted", () => {
    // app.school_settings.locale only enforces a BCP-47 shape and the settings API accepts six
    // locales, but templates exist for two. Indexing the template map with `fr` would resolve to
    // undefined and throw at the lookup — one notification at a time, in production only.
    expect(resolveLocale("fr", null)).toBe("en");
    expect(resolveLocale("es", "ar")).toBe("ar");
    expect(resolveLocale("de", "pt")).toBe("en");
  });

  test("a region-tagged locale is not silently accepted", () => {
    // `en-US` is valid per the column CHECK but is not a key in the template map. Falling back is
    // correct; a substring match would be a guess.
    expect(resolveLocale("en-US", null)).toBe("en");
  });
});

describe("render", () => {
  test("substitutes the event variables", () => {
    const { title, body } = render("GRADE_POSTED", "email", "en", GRADE_VARS);
    expect(title).toBe("Grade posted for Lab Report 3: 85/100");
    expect(body).toBe("Your grade for Lab Report 3 in Biology 101 has been posted: 85/100.");
  });

  test("renders Arabic from the same variables", () => {
    const { title, body } = render("GRADE_POSTED", "email", "ar", GRADE_VARS);
    expect(title).toContain("Lab Report 3");
    expect(body).toContain("Biology 101");
    // Arabic script, not a silent fallback to the English template. The substituted variables are
    // Latin in both locales, so the script check is on the template text around them.
    expect(/[؀-ۿ]/.test(body)).toBe(true);
    expect(body).not.toBe(render("GRADE_POSTED", "email", "en", GRADE_VARS).body);
  });

  test("the title is the in_app template regardless of channel", () => {
    const email = render("GRADE_POSTED", "email", "en", GRADE_VARS);
    const push = render("GRADE_POSTED", "push", "en", GRADE_VARS);
    expect(email.title).toBe(push.title);
    expect(email.body).not.toBe(push.body);
  });

  test("an unknown variable is left visible rather than blanked", () => {
    const { body } = render("GRADE_POSTED", "email", "en", { courseName: "Biology 101" });
    expect(body).toContain("{assignmentName}");
  });
});

describe("resolveRoute", () => {
  test("substitutes the ids the catalog route names", () => {
    expect(resolveRoute("GRADE_POSTED", { courseId: "c-1" })).toBe("/courses/c-1/grades");
  });

  test("leaves an unresolved placeholder intact", () => {
    // `/courses//grades` looks plausible and 404s in a client; `/courses/{courseId}/grades` is
    // visibly broken in a log.
    expect(resolveRoute("GRADE_POSTED", {})).toBe("/courses/{courseId}/grades");
  });
});
