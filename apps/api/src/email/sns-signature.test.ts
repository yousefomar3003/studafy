import { createSign, generateKeyPairSync } from "node:crypto";

// eslint-disable-next-line import-x/no-unresolved -- "bun:test" is a virtual Bun built-in with no resolvable file path
import { describe, expect, test } from "bun:test";

import {
  SnsSignatureError,
  buildSnsCanonicalMessage,
  isAllowedSigningCertUrl,
  regionFromTopicArn,
  verifySnsSignature,
} from "./sns-signature";

import type { SnsEnvelope } from "./sns-signature";

const TOPIC_ARN = "arn:aws:sns:us-east-1:123456789012:studafy-email-events";
const CERT_URL = "https://sns.us-east-1.amazonaws.com/SimpleNotificationService-test.pem";

const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
const PUBLIC_KEY_PEM = publicKey.export({ type: "spki", format: "pem" });

function sign(envelope: SnsEnvelope): SnsEnvelope {
  const signer = createSign("RSA-SHA1");
  signer.update(buildSnsCanonicalMessage(envelope));
  signer.end();
  return { ...envelope, Signature: signer.sign(privateKey, "base64"), SigningCertURL: CERT_URL };
}

function notification(overrides: Partial<SnsEnvelope> = {}): SnsEnvelope {
  return {
    Type: "Notification",
    MessageId: "6b29e1a0-1b2b-4c8e-9a2e-000000000001",
    TopicArn: TOPIC_ARN,
    Message: JSON.stringify({ eventType: "Delivery" }),
    Timestamp: "2026-07-31T00:00:00.000Z",
    SignatureVersion: "1",
    ...overrides,
  };
}

describe("buildSnsCanonicalMessage", () => {
  test("emits the signed fields in the fixed SNS order", () => {
    const envelope = notification();
    const expected = [
      "Message\n",
      JSON.stringify({ eventType: "Delivery" }),
      "\n",
      "MessageId\n6b29e1a0-1b2b-4c8e-9a2e-000000000001\n",
      "Subject\nTest subject\n",
      "Timestamp\n2026-07-31T00:00:00.000Z\n",
      "TopicArn\n",
      TOPIC_ARN,
      "\n",
      "Type\nNotification\n",
    ].join("");

    expect(buildSnsCanonicalMessage({ ...envelope, Subject: "Test subject" })).toBe(expected);
  });

  test("omits an absent Subject", () => {
    expect(buildSnsCanonicalMessage(notification())).not.toContain("Subject");
  });

  test("throws when a required signed field is missing", () => {
    const { MessageId: _removed, ...withoutMessageId } = notification();
    expect(() => buildSnsCanonicalMessage(withoutMessageId)).toThrow(SnsSignatureError);
  });
});

describe("regionFromTopicArn", () => {
  test("parses the region segment", () => {
    expect(regionFromTopicArn(TOPIC_ARN)).toBe("us-east-1");
  });

  test("rejects malformed ARNs", () => {
    expect(regionFromTopicArn("not-an-arn")).toBeNull();
    expect(regionFromTopicArn("arn:aws:sns:us-east-1:12:name")).toBeNull();
  });
});

describe("isAllowedSigningCertUrl", () => {
  test("accepts SNS's regional certificate host", () => {
    expect(isAllowedSigningCertUrl(CERT_URL, TOPIC_ARN)).toBe(true);
  });

  test("accepts the regionless sns.amazonaws.com host", () => {
    expect(
      isAllowedSigningCertUrl(
        "https://sns.amazonaws.com/SimpleNotificationService-test.pem",
        TOPIC_ARN,
      ),
    ).toBe(true);
  });

  test("rejects a certificate host in another region", () => {
    expect(
      isAllowedSigningCertUrl(
        "https://sns.eu-west-1.amazonaws.com/SimpleNotificationService-test.pem",
        TOPIC_ARN,
      ),
    ).toBe(false);
  });

  test("rejects an attacker-controlled host", () => {
    expect(
      isAllowedSigningCertUrl(
        "https://evil.example.com/SimpleNotificationService-test.pem",
        TOPIC_ARN,
      ),
    ).toBe(false);
  });

  test("rejects plain HTTP and non-SNS paths", () => {
    expect(isAllowedSigningCertUrl("http://sns.us-east-1.amazonaws.com/key.pem", TOPIC_ARN)).toBe(
      false,
    );
    expect(isAllowedSigningCertUrl("https://sns.us-east-1.amazonaws.com/evil.pem", TOPIC_ARN)).toBe(
      false,
    );
  });
});

describe("verifySnsSignature", () => {
  test("verifies a genuinely signed notification", async () => {
    const verified = await verifySnsSignature(sign(notification()), {
      fetchCert: async () => PUBLIC_KEY_PEM,
    });
    expect(verified).toBe(true);
  });

  test("rejects a tampered Message", async () => {
    const signed = sign(notification());
    const tampered: SnsEnvelope = { ...signed, Message: JSON.stringify({ eventType: "Bounce" }) };
    const verified = await verifySnsSignature(tampered, { fetchCert: async () => PUBLIC_KEY_PEM });
    expect(verified).toBe(false);
  });

  test("rejects a signature made with a different key", async () => {
    const otherKey = generateKeyPairSync("rsa", { modulusLength: 2048 });
    const signed = sign(notification());
    const verified = await verifySnsSignature(signed, {
      fetchCert: async () => otherKey.publicKey.export({ type: "spki", format: "pem" }),
    });
    expect(verified).toBe(false);
  });

  test("rejects an unsupported SignatureVersion without fetching the certificate", async () => {
    const envelope = notification({ SignatureVersion: "2" });
    let fetched = false;
    await expect(
      verifySnsSignature(envelope, {
        fetchCert: async () => {
          fetched = true;
          return PUBLIC_KEY_PEM;
        },
      }),
    ).rejects.toThrow(SnsSignatureError);
    expect(fetched).toBe(false);
  });

  test("rejects a non-SNS SigningCertURL without fetching it", async () => {
    const signed = {
      ...sign(notification()),
      SigningCertURL: "https://evil.example.com/key.pem",
    };
    let fetched = false;
    await expect(
      verifySnsSignature(signed, {
        fetchCert: async () => {
          fetched = true;
          return PUBLIC_KEY_PEM;
        },
      }),
    ).rejects.toThrow(SnsSignatureError);
    expect(fetched).toBe(false);
  });

  test("propagates a certificate fetch failure", async () => {
    await expect(
      verifySnsSignature(sign(notification()), {
        fetchCert: async () => {
          throw new SnsSignatureError("network unreachable");
        },
      }),
    ).rejects.toThrow(SnsSignatureError);
  });
});
