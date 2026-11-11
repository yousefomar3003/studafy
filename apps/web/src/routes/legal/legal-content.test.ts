// eslint-disable-next-line import-x/no-unresolved -- "bun:test" is a virtual Bun built-in with no resolvable file path
import { describe, expect, test } from "bun:test";

import { parseLegalDocument } from "./legal-content";

describe("parseLegalDocument", () => {
  test("splits the title from the body and reads the version date", () => {
    const parsed = parseLegalDocument(
      "# Privacy Policy\n\nLast updated: 2026-11-11\n\n## 1. Who we are\n\nText.\n",
    );
    expect(parsed.title).toBe("Privacy Policy");
    expect(parsed.version).toBe("2026-11-11");
    expect(parsed.body.startsWith("Last updated: 2026-11-11")).toBe(true);
    expect(parsed.body).not.toContain("# Privacy Policy");
  });

  test("reads the date from the Arabic line too", () => {
    expect(parseLegalDocument("# سياسة الخصوصية\n\nآخر تحديث: 2026-11-11\n").version).toBe(
      "2026-11-11",
    );
  });

  test("has no version when the line is missing, and ignores dates further down", () => {
    const parsed = parseLegalDocument("# Terms\n\nIntro.\n\nMore.\n\nSigned 2020-01-01.\n");
    expect(parsed.version).toBeNull();
  });
});
