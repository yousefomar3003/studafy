/**
 * Storage key tenant-boundary tests (ST-103).
 *
 * These run without a database or a bucket, and they are the highest-value unit tests in this
 * module: assertSchoolOwnedKey is the single check standing between a caller and another school's
 * objects, and every way past it is a cross-tenant read.
 */

// eslint-disable-next-line import-x/no-unresolved -- "bun:test" is a virtual Bun built-in with no resolvable file path
import { describe, expect, test } from "bun:test";

import { CodedHttpException } from "../../../../coded-http-exception";
import {
  assertSchoolOwnedKey,
  buildPermanentKey,
  buildTempKey,
  parseStorageKey,
} from "../../../../lib/storage/keys";

const SCHOOL = "11111111-1111-4111-8111-111111111111";
const OTHER_SCHOOL = "22222222-2222-4222-8222-222222222222";
const OBJECT = "33333333-3333-4333-8333-333333333333";

describe("key construction", () => {
  test("puts the lifecycle category first, before the school", () => {
    // Not cosmetic: the app-files bucket's expiry rules match a literal `temp/` prefix, so a key
    // that leads with the school id silently misses the rule meant to clean it up.
    expect(buildTempKey(SCHOOL, OBJECT, "notes.pdf")).toBe(`temp/${SCHOOL}/${OBJECT}/notes.pdf`);
    expect(buildPermanentKey(SCHOOL, OBJECT, "notes.pdf")).toBe(
      `permanent/${SCHOOL}/${OBJECT}/notes.pdf`,
    );
  });

  test("rejects a filename containing a path separator", () => {
    expect(() => buildTempKey(SCHOOL, OBJECT, "a/b.pdf")).toThrow(CodedHttpException);
    expect(() => buildTempKey(SCHOOL, OBJECT, "a\\b.pdf")).toThrow(CodedHttpException);
  });

  test("rejects traversal filenames", () => {
    expect(() => buildTempKey(SCHOOL, OBJECT, "..")).toThrow(CodedHttpException);
    expect(() => buildTempKey(SCHOOL, OBJECT, "..%2fescape.pdf")).toThrow(CodedHttpException);
  });

  test("rejects a control character in a filename", () => {
    // Built with fromCharCode rather than written literally: a raw control byte in a source
    // file is invisible in review and easy to lose to an editor or a reformat, which would
    // leave this test passing while asserting nothing.
    const bell = String.fromCharCode(0x07);
    const del = String.fromCharCode(0x7f);

    expect(() => buildTempKey(SCHOOL, OBJECT, `notes${bell}.pdf`)).toThrow(CodedHttpException);
    expect(() => buildTempKey(SCHOOL, OBJECT, `notes${del}.pdf`)).toThrow(CodedHttpException);
  });

  test("keeps ordinary punctuation, including hyphens and dots", () => {
    // Guards a real regression risk: an over-eager unsafe-character class would reject the most
    // common file names there are.
    expect(buildTempKey(SCHOOL, OBJECT, "week-3_problem.set.v2.pdf")).toContain(
      "week-3_problem.set.v2.pdf",
    );
  });
});

describe("parseStorageKey", () => {
  test("decomposes a well-formed key", () => {
    expect(parseStorageKey(`permanent/${SCHOOL}/${OBJECT}/notes.pdf`)).toEqual({
      category: "permanent",
      schoolId: SCHOOL,
      objectId: OBJECT,
      filename: "notes.pdf",
    });
  });

  test("returns null for the wrong number of segments", () => {
    expect(parseStorageKey(`permanent/${SCHOOL}/notes.pdf`)).toBeNull();
    expect(parseStorageKey(`permanent/${SCHOOL}/${OBJECT}/sub/notes.pdf`)).toBeNull();
  });

  test("returns null for an unknown category", () => {
    expect(parseStorageKey(`backups/${SCHOOL}/${OBJECT}/notes.pdf`)).toBeNull();
  });

  test("returns null for surrounding whitespace", () => {
    expect(parseStorageKey(` permanent/${SCHOOL}/${OBJECT}/notes.pdf`)).toBeNull();
  });
});

describe("assertSchoolOwnedKey", () => {
  test("accepts a key in the expected category owned by the school", () => {
    const key = buildTempKey(SCHOOL, OBJECT, "notes.pdf");
    expect(assertSchoolOwnedKey(key, SCHOOL, "temp").objectId).toBe(OBJECT);
  });

  test("rejects another school's key with 403", () => {
    const key = buildTempKey(OTHER_SCHOOL, OBJECT, "notes.pdf");

    try {
      assertSchoolOwnedKey(key, SCHOOL, "temp");
      throw new Error("expected assertSchoolOwnedKey to throw");
    } catch (error) {
      expect(error).toBeInstanceOf(CodedHttpException);
      // 403, not 404: the status code must not tell a prober whether the key exists.
      expect((error as CodedHttpException).status).toBe(403);
      expect((error as CodedHttpException).code).toBe("STORAGE_KEY_FORBIDDEN");
    }
  });

  test("rejects a permanent key where a staged one is required", () => {
    // The confirm endpoint takes a temp/ key. Accepting a permanent/ key there would let a caller
    // re-point an existing attachment's object at a new assignment row.
    const key = buildPermanentKey(SCHOOL, OBJECT, "notes.pdf");
    expect(() => assertSchoolOwnedKey(key, SCHOOL, "temp")).toThrow(CodedHttpException);
  });

  test("rejects a malformed key", () => {
    expect(() => assertSchoolOwnedKey("not-a-key", SCHOOL, "temp")).toThrow(CodedHttpException);
    expect(() => assertSchoolOwnedKey("", SCHOOL, "temp")).toThrow(CodedHttpException);
  });

  test("rejects a key whose school segment merely starts with the caller's school", () => {
    // A prefix comparison instead of an equality check would accept this, and the bucket layout
    // makes such neighbouring ids cheap to construct.
    const key = `temp/${SCHOOL}extra/${OBJECT}/notes.pdf`;
    expect(() => assertSchoolOwnedKey(key, SCHOOL, "temp")).toThrow(CodedHttpException);
  });
});
