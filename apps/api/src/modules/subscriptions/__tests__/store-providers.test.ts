/**
 * The App Store and Google Play adapters and the event mapping, without a store or a database.
 *
 * Google is driven through its injected request function (the Play Developer API's responses are
 * plain JSON). Apple's verification is Apple's own library over Apple's root certificates; a real
 * signed transaction cannot be minted here, so its tests pin the refusal of anything unsigned.
 */

import { X509Certificate } from "node:crypto";

// eslint-disable-next-line import-x/no-unresolved -- "bun:test" is a virtual Bun built-in with no resolvable file path
import { describe, expect, test } from "bun:test";

import { createAppleStore } from "../store/apple";
import {
  APPLE_INC_ROOT,
  APPLE_ROOT_CA_G2,
  APPLE_ROOT_CA_G3,
} from "../store/apple-root-certificates";
import { storeBillingEvent } from "../store/events";
import { createGooglePlayStore } from "../store/google";
import { StoreVerificationError } from "../store/types";

import type { StoreSubscription } from "../store/types";

const PACKAGE = "com.studafy.studafy_mobile";
const STUDENT = "6f1c9d52-3b7a-4c1e-9a55-0d2b8e4f7a10";
const SCHOOL = "1a2b3c4d-5e6f-4a1b-8c2d-3e4f5a6b7c8d";

function subscription(overrides: Partial<StoreSubscription> = {}): StoreSubscription {
  return {
    platform: "google",
    storeRef: "token-1",
    transactionId: "GPA.1234-5678",
    productId: "studafy_ai_monthly",
    studentId: STUDENT,
    schoolId: SCHOOL,
    state: "active",
    periodStart: new Date("2026-10-01T00:00:00Z"),
    periodEnd: new Date("2026-11-01T00:00:00Z"),
    environment: "production",
    ...overrides,
  };
}

describe("storeBillingEvent", () => {
  test.each([
    ["purchased", "checkout.session.completed"],
    ["renewed", "invoice.paid"],
    ["payment_failed", "invoice.payment_failed"],
    ["ended", "customer.subscription.deleted"],
  ] as const)("%s becomes %s", (kind, type) => {
    const event = storeBillingEvent({
      eventId: "google:notification:1",
      kind,
      subscription: subscription(),
      schoolId: SCHOOL,
      studentId: STUDENT,
      effectiveAt: new Date("2026-10-01T00:00:00Z"),
    });

    expect(event.type).toBe(type);
    expect(event.provider).toBe("google");
    expect(event.data.metadata).toEqual({ school_id: SCHOOL, student_id: STUDENT });
    expect(event.data.store_ref).toBe("token-1");
    // Never mistakable for a Stripe subscription id, and never tied to a provider customer.
    expect(event.data.id).toBe("store:token-1");
    expect(event.data.customer).toBeNull();
  });

  test("only a purchase or renewal carries the paid period", () => {
    const base = {
      eventId: "e",
      subscription: subscription(),
      schoolId: SCHOOL,
      studentId: STUDENT,
      effectiveAt: new Date(),
    };

    expect(storeBillingEvent({ ...base, kind: "renewed" }).data).toMatchObject({
      period_start: 1_790_812_800,
      period_end: 1_793_491_200,
    });
    expect(storeBillingEvent({ ...base, kind: "ended" }).data).not.toHaveProperty("period_end");
    expect(storeBillingEvent({ ...base, kind: "payment_failed" }).data).not.toHaveProperty(
      "period_start",
    );
  });
});

describe("Google Play", () => {
  function playServing(response: unknown | Error) {
    const calls: { method: string; url: string }[] = [];
    const store = createGooglePlayStore({
      packageName: PACKAGE,
      serviceAccountJson: "{}",
      request: async (method, url) => {
        calls.push({ method, url });
        if (response instanceof Error) throw response;
        return response;
      },
    });
    return { store, calls };
  }

  const purchase = {
    subscriptionState: "SUBSCRIPTION_STATE_ACTIVE",
    startTime: "2026-10-01T00:00:00Z",
    latestOrderId: "GPA.1234-5678",
    lineItems: [{ productId: "studafy_ai_monthly", expiryTime: "2026-11-01T00:00:00Z" }],
    externalAccountIdentifiers: {
      obfuscatedExternalAccountId: STUDENT.toUpperCase(),
      obfuscatedExternalProfileId: SCHOOL,
    },
  };

  test("reads the subscription back from the Play Developer API", async () => {
    const { store, calls } = playServing(purchase);

    const result = await store.getSubscription("tok/en");

    expect(calls[0]).toEqual({
      method: "GET",
      url: `https://androidpublisher.googleapis.com/androidpublisher/v3/applications/${PACKAGE}/purchases/subscriptionsv2/tokens/tok%2Fen`,
    });
    expect(result).toEqual({
      platform: "google",
      storeRef: "tok/en",
      transactionId: "GPA.1234-5678",
      productId: "studafy_ai_monthly",
      studentId: STUDENT,
      schoolId: SCHOOL,
      state: "active",
      periodStart: new Date("2026-10-01T00:00:00Z"),
      periodEnd: new Date("2026-11-01T00:00:00Z"),
      environment: "production",
    });
  });

  test.each([
    ["SUBSCRIPTION_STATE_CANCELED", "active"],
    ["SUBSCRIPTION_STATE_IN_GRACE_PERIOD", "grace"],
    ["SUBSCRIPTION_STATE_ON_HOLD", "billing_retry"],
    ["SUBSCRIPTION_STATE_EXPIRED", "expired"],
    ["SUBSCRIPTION_STATE_SOMETHING_NEW", "expired"],
  ])("%s is %s", async (subscriptionState, state) => {
    const { store } = playServing({ ...purchase, subscriptionState });

    expect((await store.getSubscription("t")).state).toBe(state as StoreSubscription["state"]);
  });

  test("a token Play does not recognize is a verification failure", async () => {
    const { store } = playServing(new Error("404 Not Found"));

    expect(store.getSubscription("forged")).rejects.toBeInstanceOf(StoreVerificationError);
  });

  test("acknowledges against the v1 subscriptions endpoint", async () => {
    const { store, calls } = playServing({});

    await store.acknowledge("studafy_ai_monthly", "tok");

    expect(calls[0]).toEqual({
      method: "POST",
      url: `https://androidpublisher.googleapis.com/androidpublisher/v3/applications/${PACKAGE}/purchases/subscriptions/studafy_ai_monthly/tokens/tok:acknowledge`,
    });
  });

  function push(payload: unknown, messageId = "msg-1") {
    return {
      message: {
        messageId,
        data: Buffer.from(JSON.stringify(payload)).toString("base64"),
      },
    };
  }

  test("decodes a Real-time Developer Notification", () => {
    const { store } = playServing({});

    const notification = store.parseNotification(
      push({
        packageName: PACKAGE,
        eventTimeMillis: "1759276800000",
        subscriptionNotification: { notificationType: 13, purchaseToken: "tok" },
      }),
    );

    expect(notification).toEqual({
      eventId: "msg-1",
      kind: "ended",
      purchaseToken: "tok",
      sentAt: new Date(1_759_276_800_000),
    });
  });

  test("an unmapped notification type and a test notification change nothing", () => {
    const { store } = playServing({});

    expect(
      store.parseNotification(
        push({ packageName: PACKAGE, subscriptionNotification: { notificationType: 3 } }),
      ).kind,
    ).toBeNull();
    expect(
      store.parseNotification(push({ packageName: PACKAGE, testNotification: {} })).kind,
    ).toBeNull();
  });

  test("refuses another package's notification and anything that is not a push", () => {
    const { store } = playServing({});

    expect(() => store.parseNotification(push({ packageName: "com.other.app" }))).toThrow(
      StoreVerificationError,
    );
    expect(() => store.parseNotification({ hello: "world" })).toThrow(StoreVerificationError);
  });
});

describe("App Store", () => {
  test.each([
    ["Apple Root CA - G3", APPLE_ROOT_CA_G3, "63:34:3A:BF:B8:9A:6A:03"],
    ["Apple Root CA - G2", APPLE_ROOT_CA_G2, "C2:B9:B0:42:DD:57:83:0E"],
    ["Apple Root CA", APPLE_INC_ROOT, "B0:B1:73:0E:CB:C7:FF:45"],
  ] as const)("%s is embedded as Apple publishes it", (commonName, der, fingerprintStart) => {
    const certificate = new X509Certificate(der);

    expect(certificate.subject.split("\n")).toContain(`CN=${commonName}`);
    expect(certificate.issuer).toBe(certificate.subject);
    // Apple's published SHA-256 fingerprints (https://www.apple.com/certificateauthority/).
    expect(certificate.fingerprint256.startsWith(fingerprintStart)).toBe(true);
  });

  const store = createAppleStore({ bundleId: "com.studafy.studafyMobile", onlineChecks: false });

  // header.payload.signature with no certificate chain: what a forged receipt looks like.
  const unsigned = [
    Buffer.from(JSON.stringify({ alg: "ES256" })).toString("base64url"),
    Buffer.from(
      JSON.stringify({
        originalTransactionId: "1",
        transactionId: "1",
        productId: "studafy_ai_monthly",
        appAccountToken: STUDENT,
        bundleId: "com.studafy.studafyMobile",
      }),
    ).toString("base64url"),
    "c2lnbmF0dXJl",
  ].join(".");

  test("refuses a transaction that is not signed by Apple", async () => {
    expect(store.verifyTransaction(unsigned)).rejects.toBeInstanceOf(StoreVerificationError);
    expect(store.verifyTransaction("not-a-jws")).rejects.toBeInstanceOf(StoreVerificationError);
  });

  test("refuses a notification that is not signed by Apple", async () => {
    expect(store.verifyNotification(unsigned)).rejects.toBeInstanceOf(StoreVerificationError);
  });
});
