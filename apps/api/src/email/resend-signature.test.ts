import { createHmac } from "node:crypto";

// eslint-disable-next-line import-x/no-unresolved -- "bun:test" is a virtual Bun built-in with no resolvable file path
import { describe, expect, test } from "bun:test";

import { ResendSignatureError, signResendPayload, verifyResendSignature } from "./resend-signature";

const KEY = Buffer.from("resend-signature-unit-test-key");
const SECRET = `whsec_${KEY.toString("base64")}`;
const NOW = 1_794_000_000;
const BODY = '{"type":"email.delivered","data":{"email_id":"re-1"}}';

function headers(signature: string, timestamp = String(NOW), id = "msg_1") {
  return { id, timestamp, signature };
}

describe("verifyResendSignature", () => {
  test("accepts the Svix scheme: base64 HMAC-SHA256 over id.timestamp.body", () => {
    // Computed independently of signResendPayload, so the two cannot share a bug.
    const digest = createHmac("sha256", KEY).update(`msg_1.${NOW}.${BODY}`).digest("base64");
    expect(() => verifyResendSignature(SECRET, headers(`v1,${digest}`), BODY, NOW)).not.toThrow();
  });

  test("accepts any matching entry, as during a secret rotation", () => {
    const valid = signResendPayload(SECRET, "msg_1", String(NOW), BODY);
    const stale = signResendPayload(
      `whsec_${Buffer.from("old").toString("base64")}`,
      "msg_1",
      String(NOW),
      BODY,
    );
    expect(() =>
      verifyResendSignature(SECRET, headers(`${stale} ${valid}`), BODY, NOW),
    ).not.toThrow();
  });

  test("rejects a different body, id, or timestamp", () => {
    const signature = signResendPayload(SECRET, "msg_1", String(NOW), BODY);
    expect(() => verifyResendSignature(SECRET, headers(signature), `${BODY} `, NOW)).toThrow(
      ResendSignatureError,
    );
    expect(() =>
      verifyResendSignature(SECRET, headers(signature, String(NOW), "msg_2"), BODY, NOW),
    ).toThrow(ResendSignatureError);
    expect(() =>
      verifyResendSignature(SECRET, headers(signature, String(NOW + 1)), BODY, NOW),
    ).toThrow(ResendSignatureError);
  });

  test("rejects a timestamp outside the five-minute window either way", () => {
    for (const offset of [-301, 301]) {
      const timestamp = String(NOW + offset);
      const signature = signResendPayload(SECRET, "msg_1", timestamp, BODY);
      expect(() => verifyResendSignature(SECRET, headers(signature, timestamp), BODY, NOW)).toThrow(
        "replay tolerance",
      );
    }
  });

  test("rejects missing headers, unknown versions, and non-numeric timestamps", () => {
    const signature = signResendPayload(SECRET, "msg_1", String(NOW), BODY);
    expect(() =>
      verifyResendSignature(
        SECRET,
        { id: "msg_1", timestamp: String(NOW), signature: undefined },
        BODY,
        NOW,
      ),
    ).toThrow(ResendSignatureError);
    expect(() =>
      verifyResendSignature(SECRET, headers(signature.replace("v1,", "v2,")), BODY, NOW),
    ).toThrow(ResendSignatureError);
    expect(() => verifyResendSignature(SECRET, headers(signature, "abc"), BODY, NOW)).toThrow(
      ResendSignatureError,
    );
  });
});
