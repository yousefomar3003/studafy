/**
 * Sealing sensitive record values (ADR-019). The only code in the repository that touches the
 * records keyring or a value_ciphertext: AES-256-GCM, a fresh 96-bit nonce per value, and the row
 * identity as additional authenticated data so a ciphertext copied to another student, field or
 * school fails to open instead of decrypting there.
 *
 * Wire format: version byte (0x01) || nonce (12) || ciphertext || tag (16).
 */

import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";

import { maskRecordValue } from "./mask";

import type { RecordFieldType, RecordSubjectKind } from "./fields";
import type { RecordValue } from "./values";

const FORMAT_V1 = 0x01;
const NONCE_BYTES = 12;
const TAG_BYTES = 16;
const KEY_BYTES = 32;

export interface RecordKeyring {
  readonly currentKeyId: string;
  readonly keys: ReadonlyMap<string, Uint8Array>;
}

/** Where a sealed value belongs. Bound into the ciphertext as AAD. */
export interface RecordSealContext {
  schoolId: string;
  subjectKind: RecordSubjectKind;
  subjectId: string;
  fieldId: string;
}

export interface SealedRecordValue {
  ciphertext: Uint8Array;
  keyId: string;
  mask: string;
}

/** A key id the keyring does not hold, or a keyring that is not configured. Fails closed. */
export class RecordKeyUnavailableError extends Error {
  constructor(keyId: string) {
    super(`Record encryption key ${keyId} is not available`);
    this.name = "RecordKeyUnavailableError";
  }
}

/** A ciphertext that fails authentication: tampered with, truncated, or moved to another row. */
export class RecordSealBrokenError extends Error {
  constructor() {
    super("Sealed record value failed authentication");
    this.name = "RecordSealBrokenError";
  }
}

/**
 * Development and test only. env.ts refuses to boot a staging or production tier whose keyring
 * holds this key, so a deployment can never seal real data with a key that is in the repository.
 */
export const DEVELOPMENT_RECORD_KEY_ID = "dev-1";
export const DEVELOPMENT_RECORD_KEYS_JSON = JSON.stringify({
  [DEVELOPMENT_RECORD_KEY_ID]: Buffer.from("studafy-development-only-key-v1!").toString("base64"),
});

/**
 * Parse RECORDS_ENCRYPTION_KEYS ({"<key id>": "<base64 32 bytes>"}) and
 * RECORDS_ENCRYPTION_CURRENT_KEY_ID. Throws a message naming the variable, never a key.
 */
export function parseRecordKeyring(keysJson: string, currentKeyId: string): RecordKeyring {
  let parsed: unknown;
  try {
    parsed = JSON.parse(keysJson);
  } catch {
    throw new Error("RECORDS_ENCRYPTION_KEYS must be a JSON object of key id -> base64 key");
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("RECORDS_ENCRYPTION_KEYS must be a JSON object of key id -> base64 key");
  }
  const keys = new Map<string, Uint8Array>();
  for (const [keyId, encoded] of Object.entries(parsed as Record<string, unknown>)) {
    if (!/^[A-Za-z0-9._-]{1,64}$/.test(keyId)) {
      throw new Error("RECORDS_ENCRYPTION_KEYS has an invalid key id");
    }
    const bytes = typeof encoded === "string" ? Buffer.from(encoded, "base64") : Buffer.alloc(0);
    if (bytes.length !== KEY_BYTES) {
      throw new Error(`RECORDS_ENCRYPTION_KEYS key ${keyId} must decode to ${KEY_BYTES} bytes`);
    }
    keys.set(keyId, new Uint8Array(bytes));
  }
  if (!keys.has(currentKeyId)) {
    throw new Error("RECORDS_ENCRYPTION_CURRENT_KEY_ID must name a key in RECORDS_ENCRYPTION_KEYS");
  }
  return { currentKeyId, keys };
}

/** True when the keyring holds the in-repository development key under any id. */
export function keyringHoldsDevelopmentKey(keyring: RecordKeyring): boolean {
  const development = parseRecordKeyring(
    DEVELOPMENT_RECORD_KEYS_JSON,
    DEVELOPMENT_RECORD_KEY_ID,
  ).keys.get(DEVELOPMENT_RECORD_KEY_ID)!;
  for (const key of keyring.keys.values()) {
    if (Buffer.from(key).equals(Buffer.from(development))) return true;
  }
  return false;
}

function aad(context: RecordSealContext): Buffer {
  return Buffer.from(
    `${context.schoolId}|${context.subjectKind}|${context.subjectId}|${context.fieldId}`,
    "utf8",
  );
}

/** Seal one value under the keyring's current key, with its mask computed from the plaintext. */
export function sealRecordValue(
  keyring: RecordKeyring,
  context: RecordSealContext,
  fieldType: RecordFieldType,
  value: RecordValue,
): SealedRecordValue {
  const key = keyring.keys.get(keyring.currentKeyId);
  if (!key) throw new RecordKeyUnavailableError(keyring.currentKeyId);
  const nonce = randomBytes(NONCE_BYTES);
  const cipher = createCipheriv("aes-256-gcm", key, nonce, { authTagLength: TAG_BYTES });
  cipher.setAAD(aad(context));
  const body = Buffer.concat([cipher.update(JSON.stringify(value), "utf8"), cipher.final()]);
  const ciphertext = Buffer.concat([Buffer.from([FORMAT_V1]), nonce, body, cipher.getAuthTag()]);
  return {
    ciphertext: new Uint8Array(ciphertext),
    keyId: keyring.currentKeyId,
    mask: maskRecordValue(fieldType, value),
  };
}

/** Open a sealed value. The plaintext comes back wrapped, so it cannot be logged by accident. */
export function openRecordValue(
  keyring: RecordKeyring,
  context: RecordSealContext,
  sealed: { ciphertext: Uint8Array; keyId: string; mask: string },
): SensitiveValue {
  const key = keyring.keys.get(sealed.keyId);
  if (!key) throw new RecordKeyUnavailableError(sealed.keyId);
  const bytes = Buffer.from(sealed.ciphertext);
  if (bytes.length < 1 + NONCE_BYTES + TAG_BYTES || bytes[0] !== FORMAT_V1) {
    throw new RecordSealBrokenError();
  }
  const nonce = bytes.subarray(1, 1 + NONCE_BYTES);
  const tag = bytes.subarray(bytes.length - TAG_BYTES);
  const body = bytes.subarray(1 + NONCE_BYTES, bytes.length - TAG_BYTES);
  try {
    const decipher = createDecipheriv("aes-256-gcm", key, nonce, { authTagLength: TAG_BYTES });
    decipher.setAAD(aad(context));
    decipher.setAuthTag(tag);
    const plaintext = Buffer.concat([decipher.update(body), decipher.final()]).toString("utf8");
    return new SensitiveValue(JSON.parse(plaintext) as RecordValue, sealed.mask);
  } catch {
    throw new RecordSealBrokenError();
  }
}

/**
 * A decrypted sensitive value in memory. Every implicit conversion -- template strings, JSON,
 * util.inspect (pino, Sentry, console) -- yields the mask; only unwrap() yields the value, and only
 * the reveal and DSR export serializers call it.
 */
export class SensitiveValue {
  readonly #value: RecordValue;
  readonly mask: string;

  constructor(value: RecordValue, mask: string) {
    this.#value = value;
    this.mask = mask;
  }

  unwrap(): RecordValue {
    return this.#value;
  }

  toString(): string {
    return this.mask;
  }

  toJSON(): string {
    return this.mask;
  }

  [Symbol.for("nodejs.util.inspect.custom")](): string {
    return `SensitiveValue(${this.mask})`;
  }
}

/** The development keyring. Both apps' env validation refuses it on a deployed tier. */
export const DEVELOPMENT_RECORD_KEYRING: RecordKeyring = parseRecordKeyring(
  DEVELOPMENT_RECORD_KEYS_JSON,
  DEVELOPMENT_RECORD_KEY_ID,
);

/** The deployment's keyring, or the development one when neither variable is set (dev/test). */
export function resolveRecordKeyring(env: {
  RECORDS_ENCRYPTION_KEYS?: string;
  RECORDS_ENCRYPTION_CURRENT_KEY_ID?: string;
}): RecordKeyring {
  if (
    env.RECORDS_ENCRYPTION_KEYS === undefined ||
    env.RECORDS_ENCRYPTION_CURRENT_KEY_ID === undefined
  ) {
    return DEVELOPMENT_RECORD_KEYRING;
  }
  return parseRecordKeyring(env.RECORDS_ENCRYPTION_KEYS, env.RECORDS_ENCRYPTION_CURRENT_KEY_ID);
}
