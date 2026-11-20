// eslint-disable-next-line import-x/no-unresolved -- "bun:test" is a virtual Bun built-in with no resolvable file path
import { describe, expect, test } from "bun:test";

import { replyLanguageFor, replyLanguageRule, SOURCE_LANGUAGE_RULE } from "./language";

describe("replyLanguageFor", () => {
  test("answers in the script the message is written in", () => {
    expect(replyLanguageFor("اشرح لي الدرس", "en")).toBe("ar");
    expect(replyLanguageFor("Explain the lesson", "ar")).toBe("en");
  });

  test("a mostly Arabic message with an English term is Arabic", () => {
    expect(replyLanguageFor("ما هو photosynthesis في الدرس؟", "en")).toBe("ar");
  });

  test("falls back to the app's language when the message has no letters", () => {
    expect(replyLanguageFor("2 + 2 = ?", "ar")).toBe("ar");
    expect(replyLanguageFor("2 + 2 = ?", "en")).toBe("en");
  });
});

describe("language rules", () => {
  test("pin the language and forbid CJK characters", () => {
    expect(replyLanguageRule("ar")).toContain("Arabic");
    expect(replyLanguageRule("ar")).toContain("never write Chinese, Japanese or Korean");
    expect(replyLanguageRule("en")).toContain("English");
    expect(SOURCE_LANGUAGE_RULE).toContain("same language as the source material");
  });
});
