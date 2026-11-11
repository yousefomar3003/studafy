/**
 * In-app purchases of the AI add-on through the shared billing pipeline, against a real database.
 *
 * The stores are fakes at their adapter boundary (what Apple's verifier or the Play Developer API
 * would answer); everything after that -- the claim, attribution, the state machine, RLS and audit
 * rows -- is the same processor the Stripe and Tap suites drive.
 */

import { createHash } from "node:crypto";

import { OpenAPIHono } from "@hono/zod-openapi";
import { DOMAIN_EVENTS, ERROR_CODES, LEGAL_DOCUMENT_VERSIONS, ROLES } from "@studafy/constants";
// eslint-disable-next-line import-x/no-unresolved -- "bun:test" is a virtual Bun built-in with no resolvable file path
import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";

import { integrationEnabled } from "../../../../tests/harness";
import { CodedHttpException } from "../../../coded-http-exception";
import { errorHandlerMiddleware } from "../../../middleware/errorHandler";
import { openApiValidationHook } from "../../../openapi/hook";
import { AUTH_CHANNELS } from "../../auth/channels";
import { aiStoreRoutes } from "../store/routes";
import {
  handleAppleNotification,
  handleGooglePlayNotification,
  registerStorePurchase,
} from "../store/service";
import { StoreVerificationError } from "../store/types";

import {
  createBillingDatabase,
  createBillingFixture,
  readAiSubscriptionStatuses,
  readBillingEvents,
  resetBillingEvents,
  silentLogger,
} from "./webhook-fixture";

import type { BillingFixture } from "./webhook-fixture";
import type { TestDatabase } from "../../../../tests/harness";
import type { AppEnv } from "../../../middleware/requestId";
import type { AppleNotification } from "../store/apple";
import type { GoogleNotification } from "../store/google";
import type { StoreBilling, StoreWithdrawalWaiver } from "../store/service";
import type { StoreSubscription } from "../store/types";

const integrationTest = test.skipIf(!integrationEnabled);
const PRODUCT = "studafy_ai_monthly";

let database: TestDatabase | null = null;

beforeAll(async () => {
  if (!integrationEnabled) return;
  database = await createBillingDatabase();
}, 60_000);

afterAll(async () => {
  await database?.cleanup();
  database = null;
});

afterEach(async () => {
  if (database) await resetBillingEvents(database);
});

let sequence = 0;

function subscriptionFor(
  f: BillingFixture,
  overrides: Partial<StoreSubscription> = {},
): StoreSubscription {
  sequence += 1;
  const now = Date.now();
  return {
    platform: "apple",
    storeRef: `2000000${sequence}`,
    transactionId: `2000000${sequence}`,
    productId: PRODUCT,
    studentId: f.studentId,
    schoolId: null,
    state: "active",
    periodStart: new Date(now - 60_000),
    periodEnd: new Date(now + 30 * 86_400_000),
    environment: "Sandbox",
    ...overrides,
  };
}

/** A store setup whose Apple and Google sides answer with exactly what the test hands them. */
function fakeStores(
  answers: {
    transaction?: StoreSubscription | Error;
    appleNotification?: AppleNotification;
    google?: StoreSubscription;
    googleNotification?: GoogleNotification;
  } = {},
) {
  const acknowledged: string[] = [];
  const store: StoreBilling = {
    productId: PRODUCT,
    apple: {
      verifyTransaction: async () => {
        if (!answers.transaction) throw new StoreVerificationError("no transaction");
        if (answers.transaction instanceof Error) throw answers.transaction;
        return answers.transaction;
      },
      verifyNotification: async () => {
        if (!answers.appleNotification) throw new StoreVerificationError("unsigned");
        return answers.appleNotification;
      },
    },
    google: {
      getSubscription: async () => {
        if (!answers.google) throw new StoreVerificationError("unknown token");
        return answers.google;
      },
      acknowledge: async (_productId, token) => {
        acknowledged.push(token);
      },
      cancel: async () => {
        throw new Error("store purchase processing never cancels");
      },
      parseNotification: () => {
        if (!answers.googleNotification) throw new StoreVerificationError("not a push");
        return answers.googleNotification;
      },
    },
    googleNotificationToken: "rtdn-token-0123456789",
  };
  return { store, acknowledged };
}

function register(
  f: BillingFixture,
  store: StoreBilling,
  platform: "apple" | "google" = "apple",
  withdrawalWaiver?: StoreWithdrawalWaiver,
) {
  return registerStorePurchase(f.db.sql, store, silentLogger, {
    schoolId: f.schoolId,
    userId: f.studentUserId,
    platform,
    verificationData: "signed-or-token",
    locale: "en",
    withdrawalWaiver,
  });
}

async function rejectionCode(promise: Promise<unknown>): Promise<string> {
  try {
    await promise;
  } catch (error) {
    if (error instanceof CodedHttpException) return error.code;
    throw error;
  }
  throw new Error("expected a rejection");
}

describe("registering a purchase", () => {
  integrationTest("turns the student's AI add-on on, once", async () => {
    const f = await createBillingFixture(database!);
    const transaction = subscriptionFor(f);
    const { store } = fakeStores({ transaction });

    const first = await register(f, store);
    // The app reports again after a crash, and again from "restore purchases".
    await register(f, store);
    await register(f, store);

    expect(first.active).toBe(true);
    expect(first.expiresAt).toBe(transaction.periodEnd!.toISOString());
    expect(await readAiSubscriptionStatuses(f)).toEqual(["active"]);
    const events = await readBillingEvents(f);
    expect(events).toEqual([
      expect.objectContaining({
        provider_event_id: `apple:purchase:${transaction.transactionId}`,
        status: "processed",
      }),
    ]);
  });

  integrationTest("acknowledges a Google Play purchase after recording it", async () => {
    const f = await createBillingFixture(database!);
    const google = subscriptionFor(f, { platform: "google", schoolId: f.schoolId });
    const { store, acknowledged } = fakeStores({ google });

    await register(f, store, "google");

    expect(acknowledged).toEqual([google.storeRef]);
    expect(await readAiSubscriptionStatuses(f)).toEqual(["active"]);
  });

  integrationTest("refuses a receipt that is not for this student", async () => {
    const f = await createBillingFixture(database!);
    const { store } = fakeStores({
      transaction: subscriptionFor(f, { studentId: crypto.randomUUID() }),
    });

    expect(await rejectionCode(register(f, store))).toBe(
      ERROR_CODES.STORE_PURCHASE_ACCOUNT_MISMATCH,
    );
    expect(await readAiSubscriptionStatuses(f)).toEqual([]);
  });

  integrationTest("refuses a receipt with no account id at all", async () => {
    const f = await createBillingFixture(database!);
    const { store } = fakeStores({ transaction: subscriptionFor(f, { studentId: null }) });

    expect(await rejectionCode(register(f, store))).toBe(
      ERROR_CODES.STORE_PURCHASE_ACCOUNT_MISMATCH,
    );
  });

  integrationTest("refuses another product, a lapsed purchase, and a forged one", async () => {
    const f = await createBillingFixture(database!);

    expect(
      await rejectionCode(
        register(f, fakeStores({ transaction: subscriptionFor(f, { productId: "other" }) }).store),
      ),
    ).toBe(ERROR_CODES.STORE_PURCHASE_INVALID);
    expect(
      await rejectionCode(
        register(f, fakeStores({ transaction: subscriptionFor(f, { state: "expired" }) }).store),
      ),
    ).toBe(ERROR_CODES.STORE_PURCHASE_NOT_ACTIVE);
    expect(
      await rejectionCode(
        register(f, fakeStores({ transaction: new StoreVerificationError("bad signature") }).store),
      ),
    ).toBe(ERROR_CODES.STORE_PURCHASE_INVALID);
    expect(await readAiSubscriptionStatuses(f)).toEqual([]);
  });

  integrationTest("refuses a purchase already registered to another student", async () => {
    const owner = await createBillingFixture(database!);
    const other = await createBillingFixture(database!);
    const transaction = subscriptionFor(owner);
    await register(owner, fakeStores({ transaction }).store);

    // The other student's app presents the same store purchase, stamped with their own id.
    const replayed = { ...transaction, studentId: other.studentId };

    expect(await rejectionCode(register(other, fakeStores({ transaction: replayed }).store))).toBe(
      ERROR_CODES.STORE_PURCHASE_ALREADY_CLAIMED,
    );
    expect(await readAiSubscriptionStatuses(other)).toEqual([]);
  });

  integrationTest("is refused to a user who is not a student", async () => {
    const f = await createBillingFixture(database!);
    const { store } = fakeStores({ transaction: subscriptionFor(f) });

    const code = await rejectionCode(
      registerStorePurchase(f.db.sql, store, silentLogger, {
        schoolId: f.schoolId,
        userId: crypto.randomUUID(),
        platform: "apple",
        verificationData: "x",
        locale: "en",
      }),
    );

    expect(code).toBe(ERROR_CODES.STORE_PURCHASE_ACCOUNT_MISMATCH);
  });
});

describe("store notifications", () => {
  function appleNotification(
    eventId: string,
    kind: AppleNotification["kind"],
    subscription: StoreSubscription,
  ): AppleNotification {
    return { eventId, kind, subscription, signedAt: new Date() };
  }

  integrationTest("an Apple refund ends access the purchase turned on", async () => {
    const f = await createBillingFixture(database!);
    const transaction = subscriptionFor(f);
    await register(f, fakeStores({ transaction }).store);

    const outcome = await handleAppleNotification(
      f.db.sql,
      fakeStores({ appleNotification: appleNotification("uuid-refund", "ended", transaction) })
        .store,
      silentLogger,
      "signed",
    );

    expect(outcome).toBe("processed");
    expect(await readAiSubscriptionStatuses(f)).toEqual(["canceled"]);
  });

  integrationTest(
    "a renewal and a billing failure keep access; a redelivery is a duplicate",
    async () => {
      const f = await createBillingFixture(database!);
      const transaction = subscriptionFor(f);
      await register(f, fakeStores({ transaction }).store);
      const renewed = fakeStores({
        appleNotification: appleNotification("uuid-renew", "renewed", transaction),
      }).store;

      expect(await handleAppleNotification(f.db.sql, renewed, silentLogger, "s")).toBe("processed");
      expect(await handleAppleNotification(f.db.sql, renewed, silentLogger, "s")).toBe("duplicate");

      const failed = fakeStores({
        appleNotification: appleNotification("uuid-fail", "payment_failed", transaction),
      }).store;
      await handleAppleNotification(f.db.sql, failed, silentLogger, "s");

      expect(await readAiSubscriptionStatuses(f)).toEqual(["past_due"]);
    },
  );

  integrationTest(
    "a notification can only move the student who registered the purchase",
    async () => {
      const owner = await createBillingFixture(database!);
      const other = await createBillingFixture(database!);
      const transaction = subscriptionFor(owner);
      await register(owner, fakeStores({ transaction }).store);

      // Apple's payload names someone else (it cannot, since Apple signs it -- but the claim, not the
      // payload, is what attribution trusts).
      const misnamed = { ...transaction, studentId: other.studentId };
      await handleAppleNotification(
        owner.db.sql,
        fakeStores({ appleNotification: appleNotification("uuid-x", "ended", misnamed) }).store,
        silentLogger,
        "s",
      );

      expect(await readAiSubscriptionStatuses(owner)).toEqual(["canceled"]);
      expect(await readAiSubscriptionStatuses(other)).toEqual([]);
    },
  );

  integrationTest(
    "an Apple notification for a purchase not yet registered is skipped",
    async () => {
      const f = await createBillingFixture(database!);

      const outcome = await handleAppleNotification(
        f.db.sql,
        fakeStores({
          appleNotification: appleNotification("uuid-early", "purchased", subscriptionFor(f)),
        }).store,
        silentLogger,
        "s",
      );

      expect(outcome).toBe("unattributed");
      expect(await readBillingEvents(f)).toEqual([]);
    },
  );

  integrationTest("an unsigned Apple notification is refused", async () => {
    const f = await createBillingFixture(database!);

    expect(
      await rejectionCode(handleAppleNotification(f.db.sql, fakeStores().store, silentLogger, "x")),
    ).toBe(ERROR_CODES.STORE_WEBHOOK_INVALID);
  });

  integrationTest(
    "a Google purchase reported first by RTDN is attributed by its own ids",
    async () => {
      const f = await createBillingFixture(database!);
      const google = subscriptionFor(f, { platform: "google", schoolId: f.schoolId });

      const outcome = await handleGooglePlayNotification(
        f.db.sql,
        fakeStores({
          google,
          googleNotification: {
            eventId: "pubsub-1",
            kind: "purchased",
            purchaseToken: google.storeRef,
            sentAt: new Date(),
          },
        }).store,
        silentLogger,
        {},
      );

      expect(outcome).toBe("processed");
      expect(await readAiSubscriptionStatuses(f)).toEqual(["active"]);
    },
  );

  integrationTest("a Google notification of no consequence is ignored", async () => {
    const f = await createBillingFixture(database!);

    const outcome = await handleGooglePlayNotification(
      f.db.sql,
      fakeStores({
        googleNotification: { eventId: "p", kind: null, purchaseToken: "t", sentAt: new Date() },
      }).store,
      silentLogger,
      {},
    );

    expect(outcome).toBe("ignored");
  });

  integrationTest("buying again after access ended starts a new paid period", async () => {
    const f = await createBillingFixture(database!);
    const first = subscriptionFor(f);
    await register(f, fakeStores({ transaction: first }).store);
    await handleAppleNotification(
      f.db.sql,
      fakeStores({ appleNotification: appleNotification("uuid-exp", "ended", first) }).store,
      silentLogger,
      "s",
    );

    // Apple keeps the original transaction id across a resubscription; the transaction is new.
    sequence += 1;
    const again = { ...first, transactionId: `3000000${sequence}`, periodStart: new Date() };
    await register(f, fakeStores({ transaction: again }).store);

    expect(await readAiSubscriptionStatuses(f)).toEqual(["active"]);
  });
});

interface WaiverRow {
  purchase_ref: string | null;
  acknowledged_at: Date | null;
  terms_version: string | null;
  recorded_at: Date | null;
  confirmation: string | null;
}

async function readWaiver(f: BillingFixture): Promise<WaiverRow | undefined> {
  const [row] = await f.db.sql.begin(async (tx) => {
    await tx.unsafe("SET LOCAL ROLE studafy_admin");
    await tx`SELECT set_config('app.school_id', ${f.schoolId}, true)`;
    return tx<WaiverRow[]>`
      SELECT withdrawal_waiver_purchase_ref AS purchase_ref,
             withdrawal_waiver_acknowledged_at AS acknowledged_at,
             withdrawal_waiver_terms_version AS terms_version,
             withdrawal_waiver_recorded_at AS recorded_at,
             withdrawal_waiver_confirmation AS confirmation
      FROM app.ai_subscriptions WHERE student_id = ${f.studentId}::uuid
    `;
  });
  return row;
}

async function readConfirmationEvents(f: BillingFixture): Promise<Record<string, unknown>[]> {
  const rows = await f.db.sql.begin(async (tx) => {
    await tx.unsafe("SET LOCAL ROLE studafy_admin");
    await tx`SELECT set_config('app.school_id', ${f.schoolId}, true)`;
    return tx<{ payload: Record<string, unknown> }[]>`
      SELECT payload FROM app.outbox_events
      WHERE event_name = ${DOMAIN_EVENTS.AI_STORE_PURCHASE_CONFIRMED}
      ORDER BY id
    `;
  });
  return rows.map((r) => r.payload);
}

async function readWaiverAudit(f: BillingFixture): Promise<Record<string, unknown>[]> {
  const rows = await f.db.sql.begin(async (tx) => {
    await tx.unsafe("SET LOCAL ROLE studafy_admin");
    await tx`SELECT set_config('app.school_id', ${f.schoolId}, true)`;
    return tx<{ actor_id: string | null; new_values: Record<string, unknown> }[]>`
      SELECT actor_id::text AS actor_id, new_values FROM app.audit_logs
      WHERE target_table = 'ai_subscriptions'
        AND new_values ? 'withdrawal_waiver_terms_version'
      ORDER BY created_at
    `;
  });
  return rows.map((r) => ({ actor_id: r.actor_id, ...r.new_values }));
}

async function setStudentEmail(f: BillingFixture, email: string | null): Promise<void> {
  await f.db.sql.begin(async (tx) => {
    await tx.unsafe("SET LOCAL ROLE studafy_admin");
    await tx`SELECT set_config('app.school_id', ${f.schoolId}, true)`;
    await tx`
      UPDATE app.users SET email = ${email}, normalized_email = ${email?.toLowerCase() ?? null}
      WHERE id = ${f.studentUserId}::uuid
    `;
  });
}

const purchaseRef = (platform: string, transactionId: string) =>
  `${platform}:${createHash("sha256").update(transactionId).digest("hex")}`;

/** The store routes over the real database, signed in as the fixture's student on the app. */
function storeApp(f: BillingFixture, store: StoreBilling) {
  const app = new OpenAPIHono<AppEnv>({ defaultHook: openApiValidationHook });
  app.use("*", async (c, next) => {
    c.set("auth", {
      userId: f.studentUserId,
      schoolId: f.schoolId,
      roles: [ROLES.STUDENT],
      channel: AUTH_CHANNELS.MOBILE,
      jti: "jti-1",
      exp: Math.floor(Date.now() / 1000) + 900,
      entitlementsVer: 1,
      subscriptionStatus: "active",
    });
    c.set("log", silentLogger);
    c.set("requestId", crypto.randomUUID());
    c.set("locale", "en");
    await next();
  });
  app.route("/", aiStoreRoutes(f.db.sql, store, silentLogger));
  app.onError(errorHandlerMiddleware(silentLogger));
  return app;
}

describe("the withdrawal waiver", () => {
  integrationTest(
    "is recorded with the purchase and the terms version, and emailed to the student once",
    async () => {
      const f = await createBillingFixture(database!);
      await setStudentEmail(f, "Student@Example.com");
      const transaction = subscriptionFor(f);
      const { store } = fakeStores({ transaction });
      const acknowledgedAt = new Date(Date.now() - 30_000);

      await register(f, store, "apple", { acknowledgedAt });
      // The app retries after a lost response: nothing new is recorded or sent.
      await register(f, store, "apple", { acknowledgedAt: new Date() });
      // "Restore purchases" sends no waiver, and leaves the recorded one alone.
      await register(f, store);

      const waiver = await readWaiver(f);
      expect(waiver).toEqual({
        purchase_ref: purchaseRef("apple", transaction.transactionId),
        acknowledged_at: acknowledgedAt,
        terms_version: LEGAL_DOCUMENT_VERSIONS.terms,
        recorded_at: expect.any(Date),
        confirmation: "email",
      });
      expect(waiver!.recorded_at!.getTime()).toBeGreaterThanOrEqual(acknowledgedAt.getTime());

      const events = await readConfirmationEvents(f);
      expect(events).toEqual([
        expect.objectContaining({
          studentId: f.studentId,
          email: "Student@Example.com",
          platform: "apple",
          acknowledgedAt: acknowledgedAt.toISOString(),
          recordedAt: waiver!.recorded_at!.toISOString(),
          termsVersion: LEGAL_DOCUMENT_VERSIONS.terms,
        }),
      ]);

      // The history, with the student as the actor.
      expect(await readWaiverAudit(f)).toEqual([
        expect.objectContaining({
          actor_id: f.studentUserId,
          withdrawal_waiver_purchase_ref: purchaseRef("apple", transaction.transactionId),
          withdrawal_waiver_terms_version: LEGAL_DOCUMENT_VERSIONS.terms,
          withdrawal_waiver_confirmation: "email",
        }),
      ]);
    },
  );

  integrationTest(
    "missing from an app version that does not send it: the purchase still goes through",
    async () => {
      const f = await createBillingFixture(database!);
      await setStudentEmail(f, "student@example.com");
      const { store } = fakeStores({ transaction: subscriptionFor(f) });

      const result = await register(f, store);
      // The current app's "restore purchases": the generated client sends unset fields as null.
      const restored = await storeApp(f, store).request("/api/subscriptions/ai/store/purchases", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          platform: "apple",
          verificationData: "signed",
          withdrawalWaiverAcknowledged: null,
          withdrawalWaiverAcknowledgedAt: null,
        }),
      });

      expect(result.active).toBe(true);
      expect(restored.status).toBe(200);
      expect(await readAiSubscriptionStatuses(f)).toEqual(["active"]);
      expect(await readWaiver(f)).toEqual({
        purchase_ref: null,
        acknowledged_at: null,
        terms_version: null,
        recorded_at: null,
        confirmation: null,
      });
      expect(await readConfirmationEvents(f)).toEqual([]);
    },
  );

  integrationTest("is never recorded as given after the server recorded it", async () => {
    const f = await createBillingFixture(database!);
    const { store } = fakeStores({ transaction: subscriptionFor(f) });

    // A device clock an hour fast.
    await register(f, store, "apple", { acknowledgedAt: new Date(Date.now() + 3_600_000) });

    const waiver = await readWaiver(f);
    expect(waiver!.acknowledged_at!.getTime()).toBe(waiver!.recorded_at!.getTime());
  });

  integrationTest("a resubscription is a new contract and records its own waiver", async () => {
    const f = await createBillingFixture(database!);
    await setStudentEmail(f, "student@example.com");
    const first = subscriptionFor(f);
    await register(f, fakeStores({ transaction: first }).store, "apple", {
      acknowledgedAt: new Date(Date.now() - 60_000),
    });

    sequence += 1;
    const again = { ...first, transactionId: `3000000${sequence}` };
    await register(f, fakeStores({ transaction: again }).store, "apple", {
      acknowledgedAt: new Date(),
    });

    expect((await readWaiver(f))!.purchase_ref).toBe(purchaseRef("apple", again.transactionId));
    expect(await readConfirmationEvents(f)).toHaveLength(2);
    expect(await readWaiverAudit(f)).toHaveLength(2);
  });

  integrationTest(
    "a student without an email address gets the confirmation in the app instead",
    async () => {
      const f = await createBillingFixture(database!);
      await setStudentEmail(f, null);
      const google = subscriptionFor(f, { platform: "google", schoolId: f.schoolId });
      const { store } = fakeStores({ google });
      const app = storeApp(f, store);
      const acknowledgedAt = new Date(Date.now() - 30_000).toISOString();

      const before = await app.request("/api/subscriptions/ai/store/config");
      expect(
        ((await before.json()) as { purchaseConfirmation: unknown }).purchaseConfirmation,
      ).toBe(null);

      const res = await app.request("/api/subscriptions/ai/store/purchases", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          platform: "google",
          verificationData: "purchase-token",
          withdrawalWaiverAcknowledged: true,
          withdrawalWaiverAcknowledgedAt: acknowledgedAt,
        }),
      });
      expect(res.status).toBe(200);

      expect(await readConfirmationEvents(f)).toEqual([]);
      const waiver = await readWaiver(f);
      expect(waiver).toEqual(
        expect.objectContaining({
          purchase_ref: purchaseRef("google", google.transactionId),
          acknowledged_at: new Date(acknowledgedAt),
          confirmation: "in_app",
        }),
      );

      const config = await app.request("/api/subscriptions/ai/store/config");
      expect(config.status).toBe(200);
      expect(
        ((await config.json()) as { purchaseConfirmation: unknown }).purchaseConfirmation,
      ).toEqual({
        acknowledgedAt,
        recordedAt: waiver!.recorded_at!.toISOString(),
        termsVersion: LEGAL_DOCUMENT_VERSIONS.terms,
        confirmation: "in_app",
      });
    },
  );
});
