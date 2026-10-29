import { inspect } from "node:util";

// eslint-disable-next-line import-x/no-unresolved -- "bun:test" is a virtual Bun built-in with no resolvable file path
import { describe, expect, test } from "bun:test";

import {
  DEVELOPMENT_RECORD_KEYS_JSON,
  DEVELOPMENT_RECORD_KEY_ID,
  RecordKeyUnavailableError,
  RecordSealBrokenError,
  isFieldVisibleTo,
  keyringHoldsDevelopmentKey,
  labelSuggestsSensitive,
  maskRecordValue,
  normalizeRecordValue,
  openRecordValue,
  parseRecordKeyring,
  sealRecordValue,
  visibilitiesFor,
} from "./index";

const keyring = parseRecordKeyring(DEVELOPMENT_RECORD_KEYS_JSON, DEVELOPMENT_RECORD_KEY_ID);
const context = {
  schoolId: "11111111-1111-4111-8111-111111111111",
  subjectKind: "student" as const,
  subjectId: "22222222-2222-4222-8222-222222222222",
  fieldId: "33333333-3333-4333-8333-333333333333",
};

describe("sealing", () => {
  test("round-trips and never exposes the plaintext implicitly", () => {
    const sealed = sealRecordValue(keyring, context, "short_text", "A1234567890");
    expect(Buffer.from(sealed.ciphertext).toString("utf8")).not.toContain("A1234567890");
    expect(sealed.mask).toBe("•••• 7890");

    const opened = openRecordValue(keyring, context, sealed);
    expect(opened.unwrap()).toBe("A1234567890");
    expect(`${opened}`).toBe("•••• 7890");
    expect(JSON.stringify({ opened })).toBe('{"opened":"•••• 7890"}');
    expect(inspect(opened)).not.toContain("A1234567890");
  });

  test("a fresh nonce per value", () => {
    const first = sealRecordValue(keyring, context, "short_text", "same");
    const second = sealRecordValue(keyring, context, "short_text", "same");
    expect(Buffer.from(first.ciphertext).equals(Buffer.from(second.ciphertext))).toBe(false);
  });

  test("a ciphertext moved to another row, field or school does not open", () => {
    const sealed = sealRecordValue(keyring, context, "short_text", "secret");
    for (const moved of [
      { ...context, subjectId: "44444444-4444-4444-8444-444444444444" },
      { ...context, fieldId: "44444444-4444-4444-8444-444444444444" },
      { ...context, schoolId: "44444444-4444-4444-8444-444444444444" },
      { ...context, subjectKind: "parent" as const },
    ]) {
      expect(() => openRecordValue(keyring, moved, sealed)).toThrow(RecordSealBrokenError);
    }
  });

  test("tampering fails authentication", () => {
    const sealed = sealRecordValue(keyring, context, "short_text", "secret");
    const tampered = Buffer.from(sealed.ciphertext);
    tampered[20] = tampered[20]! ^ 0xff;
    expect(() => openRecordValue(keyring, context, { ...sealed, ciphertext: tampered })).toThrow(
      RecordSealBrokenError,
    );
  });

  test("an unknown key id fails closed", () => {
    const sealed = sealRecordValue(keyring, context, "short_text", "secret");
    expect(() => openRecordValue(keyring, context, { ...sealed, keyId: "gone" })).toThrow(
      RecordKeyUnavailableError,
    );
  });

  test("rotation: old ciphertexts still open under a keyring that keeps the old key", () => {
    const sealed = sealRecordValue(keyring, context, "number", 42);
    const rotated = parseRecordKeyring(
      JSON.stringify({
        ...JSON.parse(DEVELOPMENT_RECORD_KEYS_JSON),
        "prod-2": Buffer.alloc(32, 7).toString("base64"),
      }),
      "prod-2",
    );
    expect(openRecordValue(rotated, context, sealed).unwrap()).toBe(42);
    expect(sealRecordValue(rotated, context, "number", 42).keyId).toBe("prod-2");
  });
});

describe("keyring parsing", () => {
  test("rejects malformed configuration without echoing key material", () => {
    expect(() => parseRecordKeyring("not json", "a")).toThrow(/RECORDS_ENCRYPTION_KEYS/);
    expect(() => parseRecordKeyring('{"a":"c2hvcnQ="}', "a")).toThrow(/32 bytes/);
    expect(() =>
      parseRecordKeyring(JSON.stringify({ a: Buffer.alloc(32).toString("base64") }), "b"),
    ).toThrow(/CURRENT_KEY_ID/);
  });

  test("detects the development key", () => {
    expect(keyringHoldsDevelopmentKey(keyring)).toBe(true);
    const real = parseRecordKeyring(
      JSON.stringify({ k: Buffer.alloc(32, 9).toString("base64") }),
      "k",
    );
    expect(keyringHoldsDevelopmentKey(real)).toBe(false);
  });
});

describe("masking", () => {
  test("last four only for long ID-like values; everything else fully masked", () => {
    expect(maskRecordValue("short_text", "784-1990-1234567-1")).toBe("•••• 67-1");
    expect(maskRecordValue("phone", "+971501234567")).toBe("•••• 4567");
    expect(maskRecordValue("short_text", "AB12")).toBe("••••");
    expect(maskRecordValue("long_text", "Type 1 diabetes, insulin at lunch")).toBe("••••");
    expect(maskRecordValue("date", "2020-01-01")).toBe("••••");
    expect(maskRecordValue("multi_choice", ["a", "b"])).toBe("••••");
  });
});

describe("visibility", () => {
  test("is a widening ladder, and sensitive fields reach staff only", () => {
    const field = (visibility: "staff_only" | "finance" | "teachers" | "parent") => ({
      visibility,
      sensitivity: "standard" as const,
    });
    expect(isFieldVisibleTo(field("staff_only"), "staff")).toBe(true);
    expect(isFieldVisibleTo(field("staff_only"), "finance")).toBe(false);
    expect(isFieldVisibleTo(field("teachers"), "finance")).toBe(true);
    expect(isFieldVisibleTo(field("finance"), "teachers")).toBe(false);
    expect(isFieldVisibleTo(field("parent"), "parent")).toBe(true);
    expect(isFieldVisibleTo(field("teachers"), "parent")).toBe(false);
    expect(isFieldVisibleTo({ visibility: "parent", sensitivity: "sensitive" }, "parent")).toBe(
      false,
    );
    expect(visibilitiesFor("teachers")).toEqual(["teachers", "parent"]);
  });
});

describe("values", () => {
  const field = (field_type: Parameters<typeof normalizeRecordValue>[0]["field_type"]) => ({
    field_type,
    options: [
      { value: "red", label_en: "Red route", label_ar: "الخط الأحمر" },
      { value: "blue", label_en: "Blue route", label_ar: "الخط الأزرق" },
    ],
  });

  test("empty is no answer, never an error", () => {
    for (const type of ["short_text", "number", "date", "single_choice", "yes_no"] as const) {
      expect(normalizeRecordValue(field(type), "  ")).toEqual({ ok: true, value: null });
    }
  });

  test("accepts CSV cell forms", () => {
    expect(normalizeRecordValue(field("number"), " 12.5 ")).toEqual({ ok: true, value: 12.5 });
    expect(normalizeRecordValue(field("yes_no"), "نعم")).toEqual({ ok: true, value: true });
    expect(normalizeRecordValue(field("single_choice"), "blue route")).toEqual({
      ok: true,
      value: "blue",
    });
    expect(normalizeRecordValue(field("multi_choice"), "red; الخط الأزرق")).toEqual({
      ok: true,
      value: ["red", "blue"],
    });
  });

  test("rejects invalid values", () => {
    expect(normalizeRecordValue(field("date"), "2024-02-30")).toEqual({
      ok: false,
      error: "RECORD_VALUE_INVALID_DATE",
    });
    expect(normalizeRecordValue(field("single_choice"), "green")).toEqual({
      ok: false,
      error: "RECORD_VALUE_INVALID_CHOICE",
    });
    expect(normalizeRecordValue(field("phone"), "12")).toEqual({
      ok: false,
      error: "RECORD_VALUE_INVALID_PHONE",
    });
    expect(normalizeRecordValue(field("document"), "x")).toEqual({
      ok: false,
      error: "RECORD_VALUE_DOCUMENT_FIELD",
    });
  });
});

describe("sensitive label hint", () => {
  test("suggests ID, passport and medical labels in en and ar", () => {
    for (const label of [
      "National ID number",
      "Passport",
      "Medical notes",
      "رقم الهوية",
      "جواز السفر",
      "ملاحظات طبية",
    ]) {
      expect(labelSuggestsSensitive(label)).toBe(true);
    }
    expect(labelSuggestsSensitive("Bus stop")).toBe(false);
  });
});
