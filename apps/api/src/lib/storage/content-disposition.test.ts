// eslint-disable-next-line import-x/no-unresolved -- "bun:test" is a virtual Bun built-in with no resolvable file path
import { describe, expect, test } from "bun:test";

import { attachmentContentDisposition, isInlineSafeContentType } from "./client";

describe("attachmentContentDisposition", () => {
  test("an ASCII name keeps its plain filename and gets the encoded form too", () => {
    expect(attachmentContentDisposition("week-3 problems.pdf")).toBe(
      "attachment; filename=\"week-3 problems.pdf\"; filename*=UTF-8''week-3%20problems.pdf",
    );
  });

  test("an Arabic name is ASCII-only in the header, with the real name percent-encoded", () => {
    const value = attachmentContentDisposition("فلسطين كما خلقها الله.docx");
    // Every byte of a header value must be ASCII.
    expect(/^[\x20-\x7e]*$/.test(value)).toBe(true);
    const encoded = value.split("filename*=UTF-8''")[1]!;
    expect(decodeURIComponent(encoded)).toBe("فلسطين كما خلقها الله.docx");
    expect(value).toContain('filename="______ ___ _____ ____.docx"');
  });

  test("quotes and backslashes cannot break out of the quoted fallback", () => {
    const value = attachmentContentDisposition('a"b\\c.txt');
    expect(value).toContain('filename="a_b_c.txt"');
    expect(value).toContain("filename*=UTF-8''a%22b%5Cc.txt");
  });

  test("an empty name falls back to download", () => {
    expect(attachmentContentDisposition("")).toContain('filename="download"');
  });

  test("inline keeps the same encoded file name", () => {
    expect(attachmentContentDisposition("a.pdf", "inline")).toBe(
      "inline; filename=\"a.pdf\"; filename*=UTF-8''a.pdf",
    );
  });
});

describe("isInlineSafeContentType", () => {
  test("documents, pictures and plain text may be shown in place", () => {
    for (const type of [
      "application/pdf",
      "image/jpeg",
      "text/plain; charset=utf-8",
      "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
      "APPLICATION/VND.MS-EXCEL",
    ]) {
      expect(isInlineSafeContentType(type)).toBe(true);
    }
  });

  test("anything a browser could run stays a download", () => {
    for (const type of [
      "text/html",
      "image/svg+xml",
      "application/xhtml+xml",
      "text/xml",
      "application/javascript",
      "application/octet-stream",
    ]) {
      expect(isInlineSafeContentType(type)).toBe(false);
    }
  });
});
