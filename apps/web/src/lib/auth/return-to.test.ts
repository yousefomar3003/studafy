// eslint-disable-next-line import-x/no-unresolved -- "bun:test" is a virtual Bun built-in with no resolvable file path
import { afterEach, describe, expect, test } from "bun:test";

import { clearReturnTo, consumeReturnTo, getReturnTo, setReturnTo } from "./return-to";

afterEach(clearReturnTo);

describe("return-to routing", () => {
  test("round-trips an internal path", () => {
    setReturnTo("/portal/attendance?week=2026-08");
    expect(getReturnTo()).toBe("/portal/attendance?week=2026-08");
  });

  test("consume reads and clears in one call", () => {
    setReturnTo("/portal");
    expect(consumeReturnTo()).toBe("/portal");
    expect(getReturnTo()).toBeNull();
  });

  test("clear drops the pending route", () => {
    setReturnTo("/portal");
    clearReturnTo();
    expect(getReturnTo()).toBeNull();
  });

  test("rejects absolute URLs — no open redirect", () => {
    setReturnTo("https://evil.example/phish");
    expect(getReturnTo()).toBeNull();
  });

  test("rejects protocol-relative URLs — no open redirect", () => {
    setReturnTo("//evil.example/phish");
    expect(getReturnTo()).toBeNull();
  });

  test("rejects a leading backslash — GHSA-wrjc-x8rr-h8h6 shape", () => {
    setReturnTo("/\\evil.example/phish");
    expect(getReturnTo()).toBeNull();
  });

  test("rejects an embedded backslash", () => {
    setReturnTo("/portal\\@evil.example");
    expect(getReturnTo()).toBeNull();
  });

  test("rejects a control character", () => {
    setReturnTo("/portal\x00evil.example");
    expect(getReturnTo()).toBeNull();
  });

  test("an empty value resolves to null", () => {
    expect(getReturnTo()).toBeNull();
  });
});
