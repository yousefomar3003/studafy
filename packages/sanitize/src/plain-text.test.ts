/* eslint-disable import-x/no-unresolved -- "bun:test" is a virtual Bun built-in */
import { describe, expect, test } from "bun:test";
/* eslint-enable import-x/no-unresolved */

import { sanitizePlainText } from "./plain-text";

describe("sanitizePlainText", () => {
  test("leaves plain text untouched", () => {
    expect(sanitizePlainText("Field trip permission slips due Monday.")).toBe(
      "Field trip permission slips due Monday.",
    );
  });

  test("preserves newlines within otherwise plain text", () => {
    expect(sanitizePlainText("Line one\nLine two")).toBe("Line one\nLine two");
  });

  test("trims leading and trailing whitespace", () => {
    expect(sanitizePlainText("  padded  ")).toBe("padded");
  });

  // ---------------------------------------------------------------------------
  // Stored XSS probe corpus (ST-296 acceptance criteria: script/img/onerror payloads).
  // ---------------------------------------------------------------------------

  test("neutralizes a <script> payload without dropping the surrounding text", () => {
    const out = sanitizePlainText("Reminder: <script>alert(document.cookie)</script> bring a pen.");
    expect(out).not.toContain("<script>");
    expect(out).not.toContain("</script>");
    expect(out).toContain("Reminder:");
    expect(out).toContain("bring a pen.");
  });

  test("neutralizes an <img onerror> payload", () => {
    const out = sanitizePlainText("<img src=x onerror=alert(1)>");
    expect(out).not.toContain("<img");
    expect(out).not.toContain("onerror");
    expect(out).not.toMatch(/<[a-z]/i);
  });

  test("neutralizes an <svg onload> payload", () => {
    const out = sanitizePlainText("<svg/onload=alert(document.domain)>");
    expect(out).not.toContain("<svg");
    expect(out).not.toContain("onload");
  });

  test("neutralizes an anchor carrying a javascript: URI", () => {
    const out = sanitizePlainText('<a href="javascript:alert(1)">click here</a>');
    expect(out).not.toContain("<a ");
    expect(out).not.toContain("</a>");
    expect(out).toContain("click here");
  });

  test("neutralizes a broken/unclosed tag", () => {
    const out = sanitizePlainText("<script>alert(1)//");
    expect(out).not.toContain("<script>");
  });

  test("neutralizes an iframe payload", () => {
    const out = sanitizePlainText('<iframe src="https://evil.example/"></iframe>');
    expect(out).not.toContain("<iframe");
  });

  test("neutralizes mixed-case and nested tags", () => {
    const out = sanitizePlainText("<ScRiPt><b>x</b>alert(1)</SCRIPT>");
    expect(out).not.toMatch(/<[a-z]/i);
  });

  test("escapes a literal ampersand", () => {
    expect(sanitizePlainText("Grades & attendance")).toBe("Grades &amp; attendance");
  });

  test("is idempotent: sanitizing twice equals sanitizing once", () => {
    const payload = "<script>alert(1)</script> and an & ampersand";
    const once = sanitizePlainText(payload);
    expect(sanitizePlainText(once)).toBe(once);
  });

  test("a legitimate mention of markup survives as inert text, not deleted", () => {
    // The pedagogical case: explaining HTML syntax in a comment must not lose the explanation.
    const out = sanitizePlainText("In HTML, <p> opens a paragraph and </p> closes it.");
    expect(out).toContain("&lt;p&gt;");
    expect(out).toContain("&lt;/p&gt;");
    expect(out).toContain("opens a paragraph");
  });

  test("neutralizes a payload embedded in text extracted from an uploaded document", () => {
    // The apps/workers ai-ingestion parsers walk document XML text nodes, so a payload arrives here
    // as plain text too — same threat shape as a form field, different origin.
    const out = sanitizePlainText(
      "Chapter 3: Web Security\n<script>document.location='https://evil.example'</script>\nNever trust user input.",
    );
    expect(out).not.toContain("<script>");
    expect(out).toContain("Chapter 3: Web Security");
    expect(out).toContain("Never trust user input.");
  });
});
