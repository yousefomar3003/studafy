/**
 * An expense attachment key from a request body must be this school's own object, and a stored key
 * from another school is never signed (migration 000197 adds the database floor).
 */

// eslint-disable-next-line import-x/no-unresolved -- "bun:test" is a virtual Bun built-in with no resolvable file path
import { describe, expect, test } from "bun:test";

import { assertOwnAttachmentKey, isOwnAttachmentKey, resolveStorageUrl } from "../service";

import type { StorageService } from "../../../../lib/storage";

const SCHOOL = "11111111-1111-4111-8111-111111111111";
const OTHER = "22222222-2222-4222-8222-222222222222";
const OBJECT = "33333333-3333-4333-8333-333333333333";

const own = `permanent/${SCHOOL}/${OBJECT}/receipt.pdf`;
const ownTemp = `temp/${SCHOOL}/${OBJECT}/receipt.pdf`;
const foreign = `permanent/${OTHER}/${OBJECT}/receipt.pdf`;

const signingStorage = {
  presign: async (key: string) => ({ url: `https://signed.example/${key}`, expiresAt: new Date() }),
} as unknown as StorageService;

describe("expense attachment keys", () => {
  test("only this school's temp/ and permanent/ objects are accepted", () => {
    expect(isOwnAttachmentKey(own, SCHOOL)).toBe(true);
    expect(isOwnAttachmentKey(ownTemp, SCHOOL)).toBe(true);
    expect(isOwnAttachmentKey(foreign, SCHOOL)).toBe(false);
    expect(isOwnAttachmentKey(`quarantine/${SCHOOL}/${OBJECT}/receipt.pdf`, SCHOOL)).toBe(false);
    expect(isOwnAttachmentKey("not-a-key", SCHOOL)).toBe(false);
  });

  test("a foreign key in a request body is refused with 403", () => {
    expect(() => assertOwnAttachmentKey(foreign, SCHOOL)).toThrow(
      "Storage key does not belong to this school",
    );
    expect(() => assertOwnAttachmentKey(own, SCHOOL)).not.toThrow();
    expect(() => assertOwnAttachmentKey(undefined, SCHOOL)).not.toThrow();
  });

  test("a stored key from another school is never signed", async () => {
    expect(await resolveStorageUrl(signingStorage, SCHOOL, foreign)).toBeNull();
    expect(await resolveStorageUrl(signingStorage, SCHOOL, own)).toBe(
      `https://signed.example/${own}`,
    );
  });
});
