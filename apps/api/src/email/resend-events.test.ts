import { createHmac } from "node:crypto";

// eslint-disable-next-line import-x/no-unresolved -- "bun:test" is a virtual Bun built-in with no resolvable file path
import { describe, expect, test } from "bun:test";

import { parseResendEvent, ResendEventError, verifyResendSignature } from "./resend-events";

const SECRET = `whsec_${Buffer.from("resend-test-signing-key").toString("base64")}`;
const NOW = 1_800_000_000;

function sign(body: string, id = "msg_1", timestamp = String(NOW)): string {
  const key = Buffer.from(SECRET.slice(6), "base64");
  return `v1,${createHmac("sha256", key).update(`${id}.${timestamp}.${body}`).digest("base64")}`;
}

describe("verifyResendSignature", () => {
  const body = JSON.stringify({ type: "email.bounced", data: { email_id: "e1" } });
  const headers = { id: "msg_1", timestamp: String(NOW), signature: sign(body) };

  test("accepts Resend's signature over the raw body", () => {
    expect(verifyResendSignature(body, headers, SECRET, NOW)).toBe(true);
  });

  test("accepts it among several signatures, as during a secret rotation", () => {
    const signature = `v1,${Buffer.alloc(32).toString("base64")} ${headers.signature}`;
    expect(verifyResendSignature(body, { ...headers, signature }, SECRET, NOW)).toBe(true);
  });

  test("refuses a changed body, a wrong secret or missing headers", () => {
    expect(verifyResendSignature(`${body} `, headers, SECRET, NOW)).toBe(false);
    const other = `whsec_${Buffer.from("another-key").toString("base64")}`;
    expect(verifyResendSignature(body, headers, other, NOW)).toBe(false);
    expect(verifyResendSignature(body, { ...headers, signature: undefined }, SECRET, NOW)).toBe(
      false,
    );
  });

  test("refuses a delivery more than five minutes old, so it cannot be replayed", () => {
    const old = String(NOW - 301);
    const stale = { id: "msg_1", timestamp: old, signature: sign(body, "msg_1", old) };
    expect(verifyResendSignature(body, stale, SECRET, NOW)).toBe(false);
  });
});

describe("parseResendEvent", () => {
  test("a bounce suppresses the normalized recipients", () => {
    expect(
      parseResendEvent({
        type: "email.bounced",
        data: { email_id: "e1", to: [" Parent@Example.com "], bounce: { type: "Permanent" } },
      }),
    ).toMatchObject({
      eventType: "bounce",
      messageId: "e1",
      suppress: true,
      reason: "bounce",
      recipients: ["parent@example.com"],
    });
  });

  test("a bounce Resend labels transient is recorded but suppresses nobody", () => {
    expect(
      parseResendEvent({
        type: "email.bounced",
        data: { email_id: "e1", to: ["parent@example.com"], bounce: { type: "Transient" } },
      }),
    ).toMatchObject({ eventType: "bounce", suppress: false, reason: null, recipients: [] });
  });

  test("a complaint suppresses; a delivery does not", () => {
    expect(
      parseResendEvent({ type: "email.complained", data: { email_id: "e2", to: ["a@b.co"] } }),
    ).toMatchObject({ eventType: "complaint", suppress: true, recipients: ["a@b.co"] });
    expect(parseResendEvent({ type: "email.delivered", data: { email_id: "e3" } })).toMatchObject({
      eventType: "delivery",
      suppress: false,
    });
  });

  test("other event types are ignored", () => {
    expect(parseResendEvent({ type: "email.opened", data: { email_id: "e4" } })).toBeNull();
  });

  test("an event without an email id or recipient is refused", () => {
    expect(() => parseResendEvent({ type: "email.bounced", data: {} })).toThrow(ResendEventError);
    expect(() => parseResendEvent({ type: "email.bounced", data: { email_id: "e5" } })).toThrow(
      ResendEventError,
    );
  });
});
