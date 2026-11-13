import { createHash } from "node:crypto";

import { processBillingEvent } from "@studafy/billing";
import { DOMAIN_EVENTS, ERROR_CODES, LEGAL_DOCUMENT_VERSIONS } from "@studafy/constants";
import { z } from "zod";

import { CodedHttpException } from "../../../coded-http-exception";
import { setTenantScope, withSystemTx, withTenantTx } from "../../../db/tenant-tx";
import { emit } from "../../../lib/events";
import { emitAuditLog } from "../../../middleware/auditEmitter";
import { getLocalizedMessage } from "../../../middleware/locale";
import { publishEntitlementChange } from "../entitlements/entitlement-change-publisher";

import { storeBillingEvent } from "./events";
import { StoreVerificationError } from "./types";

import type { AppleStore } from "./apple";
import type { StoreBillingEvent } from "./events";
import type { GooglePlayStore } from "./google";
import type { StoreEventKind, StorePlatform, StoreSubscription } from "./types";
import type { Database, DatabasePools } from "../../../db/client";
import type { Logger } from "../../../logger";
import type { SupportedLocale } from "../../../middleware/locale";
import type { BillingAuditWriter } from "@studafy/billing";
import type { TransactionSql } from "postgres";

/**
 * Turning a store purchase on and off (see ./types.ts for the overall design).
 *
 * - {@link registerStorePurchase}: the student's app reports a completed purchase. This is the one
 *   moment the server knows both the store's reference and the Studafy school and student it is
 *   for, so it is also where that link is recorded (as the purchase's billing event), and where the
 *   student's waiver of the 14-day right of withdrawal is recorded and confirmed
 *   ({@link recordWithdrawalWaiver}).
 * - {@link handleAppleNotification} / {@link handleGooglePlayNotification}: renewals, failures,
 *   expiry and refunds the stores report later, unauthenticated. They are attributed to the
 *   school and student through the purchase's billing event (`store_ref`), so a notification can
 *   only ever move the subscription of the student who registered it.
 */

export interface StoreBilling {
  /** The AI add-on's product id, the same in App Store Connect and the Play Console. */
  productId: string;
  /**
   * Every product id the AI add-on is sold under, in the order the app offers them; the first is
   * {@link productId}. One App Store / Google Play account can hold only one subscription to a
   * product, so a parent buying for a second child on the same phone needs a second product (on
   * the App Store, in its own subscription group). Absent means just {@link productId}.
   */
  productIds?: readonly string[];
  apple: AppleStore | null;
  google: GooglePlayStore | null;
  /** Shared secret in the Pub/Sub push endpoint's URL (`?token=`), authenticating Google's pushes. */
  googleNotificationToken: string | null;
}

export interface StorePurchaseResult {
  active: boolean;
  expiresAt: string | null;
  /** The student the purchase turned AI on for: the one the app stamped on it when it was bought. */
  studentId: string;
}

/** Every product id the add-on is sold under, primary first. */
export function storeProductIds(store: StoreBilling): readonly string[] {
  return store.productIds?.length ? store.productIds : [store.productId];
}

/**
 * Who the caller is to a student, in one school: the student themselves, a parent linked to them,
 * or a brother or sister (another student sharing a linked parent). Through the link rows only --
 * never by name, email, phone or id number. Null when the student is not in this school.
 *
 * Read in a system transaction scoped to the school (`setTenantScope`), with the school also
 * pinned in the query: a student cannot read a sibling's row under their own role scope, and this
 * is exactly the question of whether they are related.
 */
export interface StudentRelation {
  studentId: string;
  firstName: string;
  isSelf: boolean;
  isGuardian: boolean;
  isSibling: boolean;
}

export async function readStudentRelation(
  tx: TransactionSql,
  schoolId: string,
  userId: string,
  studentId: string,
): Promise<StudentRelation | null> {
  const [row] = await tx<
    {
      id: string;
      first_name: string;
      is_self: boolean;
      is_guardian: boolean;
      is_sibling: boolean;
    }[]
  >`
    SELECT s.id,
           s.first_name,
           (s.user_id IS NOT DISTINCT FROM ${userId}::uuid) AS is_self,
           EXISTS (
             SELECT 1 FROM app.parent_child_links l
             WHERE l.school_id = s.school_id
               AND l.student_id = s.id
               AND l.parent_user_id = ${userId}::uuid
           ) AS is_guardian,
           EXISTS (
             SELECT 1
             FROM app.parent_child_links theirs
             JOIN app.parent_child_links mine
               ON mine.school_id = theirs.school_id
              AND mine.parent_user_id = theirs.parent_user_id
             JOIN app.students me
               ON me.id = mine.student_id
              AND me.school_id = mine.school_id
              AND me.user_id = ${userId}::uuid
             WHERE theirs.school_id = s.school_id
               AND theirs.student_id = s.id
           ) AS is_sibling
    FROM app.students s
    WHERE s.id = ${studentId}::uuid
      AND s.school_id = ${schoolId}::uuid
  `;
  return row
    ? {
        studentId: row.id,
        firstName: row.first_name,
        isSelf: row.is_self,
        isGuardian: row.is_guardian,
        isSibling: row.is_sibling,
      }
    : null;
}

/**
 * The student's express request, made in the app before the store's purchase sheet opened, for the
 * AI add-on to start straight away, and their acknowledgement that they lose the 14-day right of
 * withdrawal once it does (Directive 2011/83/EU art. 16(m); Terms of Service 7.7).
 */
export interface StoreWithdrawalWaiver {
  /** When the student ticked the box, by the device's clock. */
  acknowledgedAt: Date;
}

/** How the waiver was confirmed to the student on a durable medium. */
export type WithdrawalWaiverConfirmation = "email" | "in_app";

/** What the app shows of a recorded waiver: the in-app copy of the confirmation. */
export interface StorePurchaseConfirmation {
  acknowledgedAt: string;
  recordedAt: string;
  termsVersion: string;
  confirmation: WithdrawalWaiverConfirmation;
}

const auditWriter: BillingAuditWriter = (tx, entry) => emitAuditLog(tx, entry);

function storeError(
  status: 400 | 403 | 409 | 503,
  code: (typeof ERROR_CODES)[keyof typeof ERROR_CODES],
  locale: SupportedLocale,
) {
  return new CodedHttpException(status, code, getLocalizedMessage(code, locale));
}

/** The school and student a store subscription was registered for, from its first billing event. */
async function findClaim(
  tx: TransactionSql,
  platform: StorePlatform,
  storeRef: string,
): Promise<{ schoolId: string; studentId: string } | null> {
  const [row] = await tx<{ school_id: string | null; student_id: string | null }[]>`
    SELECT payload -> 'metadata' ->> 'school_id' AS school_id,
           payload -> 'metadata' ->> 'student_id' AS student_id
    FROM app.billing_events
    WHERE provider = ${platform}
      AND payload ->> 'store_ref' = ${storeRef}
      AND status = 'processed'
    ORDER BY effective_at DESC
    LIMIT 1
  `;
  return row?.school_id && row.student_id
    ? { schoolId: row.school_id, studentId: row.student_id }
    : null;
}

async function applyStoreEvent(
  database: Database | DatabasePools,
  event: StoreBillingEvent,
  logger: Logger,
  requestId?: string,
): Promise<string> {
  const result = await withSystemTx(database, (tx) =>
    processBillingEvent(tx, event, {
      emitAudit: auditWriter,
      publishEntitlementChange,
      logger,
      requestId,
    }),
  );
  return result.outcome;
}

async function verify(
  store: StoreBilling,
  platform: StorePlatform,
  verificationData: string,
  locale: SupportedLocale,
): Promise<StoreSubscription> {
  const client = platform === "apple" ? store.apple : store.google;
  if (!client) throw storeError(503, ERROR_CODES.STORE_BILLING_NOT_CONFIGURED, locale);
  try {
    return platform === "apple"
      ? await store.apple!.verifyTransaction(verificationData)
      : await store.google!.getSubscription(verificationData);
  } catch (error) {
    if (error instanceof StoreVerificationError) {
      throw storeError(400, ERROR_CODES.STORE_PURCHASE_INVALID, locale);
    }
    throw error;
  }
}

/**
 * Record a purchase the app completed, and turn on the AI add-on of the student it was bought for.
 *
 * The purchase must be for one of the configured products, still active, and stamped by the app
 * with a student's id when it was bought. It is credited to that student only, so a receipt can
 * never be moved onto another account; the caller must be that student, a parent linked to them
 * (buying for their child), or a brother or sister whose account is open on the phone the store
 * redelivered it to. A purchase already registered to a different student is refused.
 * Re-registering the same purchase -- a retry, or "restore purchases" -- is idempotent.
 */
export async function registerStorePurchase(
  database: Database | DatabasePools,
  store: StoreBilling,
  logger: Logger,
  params: {
    schoolId: string;
    userId: string;
    requestId?: string;
    platform: StorePlatform;
    verificationData: string;
    locale: SupportedLocale;
    /**
     * The waiver the app sent with the purchase. Absent from app versions that do not ask for it,
     * from "restore purchases", and from a purchase redelivered after the app lost it: recorded as
     * nothing, never refused, because by now the store has taken the money.
     */
    withdrawalWaiver?: StoreWithdrawalWaiver | null;
  },
): Promise<StorePurchaseResult> {
  const { locale } = params;
  const subscription = await verify(store, params.platform, params.verificationData, locale);
  if (!storeProductIds(store).includes(subscription.productId)) {
    throw storeError(400, ERROR_CODES.STORE_PURCHASE_INVALID, locale);
  }
  // Credited to the student the app stamped on the purchase when it was bought, and nobody else.
  // The caller only has to be someone who could have bought it or is holding it on this phone: that
  // student, a linked parent who bought it for them, or a brother or sister signed in on the same
  // phone -- one store account redelivers every purchase it made to whichever account is open.
  const stamped = subscription.studentId;
  const relation = stamped
    ? await withSystemTx(database, async (tx) => {
        await setTenantScope(tx, params.schoolId, params.requestId);
        return readStudentRelation(tx, params.schoolId, params.userId, stamped);
      })
    : null;
  if (!relation || !(relation.isSelf || relation.isGuardian || relation.isSibling)) {
    throw storeError(403, ERROR_CODES.STORE_PURCHASE_ACCOUNT_MISMATCH, locale);
  }
  const student = { id: relation.studentId };
  if (subscription.state === "expired" || subscription.state === "revoked") {
    throw storeError(409, ERROR_CODES.STORE_PURCHASE_NOT_ACTIVE, locale);
  }

  const claim = await withSystemTx(database, (tx) =>
    findClaim(tx, subscription.platform, subscription.storeRef),
  );
  if (claim && claim.studentId !== student.id) {
    throw storeError(409, ERROR_CODES.STORE_PURCHASE_ALREADY_CLAIMED, locale);
  }

  await applyStoreEvent(
    database,
    storeBillingEvent({
      eventId: `${subscription.platform}:purchase:${subscription.transactionId}`,
      kind: "purchased",
      subscription,
      schoolId: params.schoolId,
      studentId: student.id,
      effectiveAt: subscription.periodStart,
    }),
    logger,
    params.requestId,
  );

  // Only whoever bought it gave the waiver: the student, or the parent buying for them. A brother
  // or sister's app passing the purchase on records none.
  await recordWithdrawalWaiver(database, logger, {
    schoolId: params.schoolId,
    userId: params.userId,
    requestId: params.requestId,
    studentId: student.id,
    subscription,
    waiver: relation.isSelf || relation.isGuardian ? (params.withdrawalWaiver ?? null) : null,
  });

  if (subscription.platform === "google") {
    // Play refunds a purchase left unacknowledged for three days. Acknowledging only after the
    // purchase is recorded means a failure here is retried by the app's next report, never lost.
    try {
      await store.google!.acknowledge(subscription.productId, subscription.storeRef);
    } catch (error) {
      logger.warn({ err: error }, "google play acknowledge failed; the next report retries it");
    }
  }

  return {
    active: true,
    expiresAt: subscription.periodEnd?.toISOString() ?? null,
    studentId: student.id,
  };
}

/**
 * Which store purchase a waiver belongs to: the platform and the SHA-256 of the transaction id. The
 * transaction, not the subscription's stable reference: an Apple resubscription keeps its
 * originalTransactionId but is a new contract with a new right of withdrawal. Hashed because Google
 * falls back to the purchase token -- a credential for the purchase -- when Play reports no order
 * id, and app.ai_subscriptions is readable at tenant level (000195).
 */
function waiverPurchaseRef(subscription: StoreSubscription): string {
  const digest = createHash("sha256").update(subscription.transactionId).digest("hex");
  return `${subscription.platform}:${digest}`;
}

const deliverableEmail = z.string().email();

/**
 * Record the student's withdrawal waiver on their AI add-on row, and confirm it to them on a durable
 * medium: an email when the account has a deliverable address, otherwise the copy the app shows
 * from the store config (`purchaseConfirmation`) -- a member-ID student has no email (000141).
 *
 * Once per purchase: a report of a purchase whose waiver is already recorded (a retry) changes
 * nothing and sends nothing. A report without a waiver -- "restore purchases", or an app version
 * that does not ask -- records nothing, and leaves an earlier purchase's waiver in place: it is still
 * true, and says which purchase it was for. The audit log keeps every one recorded.
 */
async function recordWithdrawalWaiver(
  database: Database | DatabasePools,
  logger: Logger,
  params: {
    schoolId: string;
    userId: string;
    requestId?: string;
    studentId: string;
    subscription: StoreSubscription;
    waiver: StoreWithdrawalWaiver | null;
  },
): Promise<void> {
  const { waiver } = params;
  if (!waiver) return;
  const purchaseRef = waiverPurchaseRef(params.subscription);
  await withTenantTx(
    database,
    { schoolId: params.schoolId, userId: params.userId, requestId: params.requestId },
    async (tx) => {
      const [row] = await tx<{ id: string; purchase_ref: string | null }[]>`
        SELECT id, withdrawal_waiver_purchase_ref AS purchase_ref
        FROM app.ai_subscriptions
        WHERE student_id = ${params.studentId}::uuid
        FOR UPDATE
      `;
      if (!row) {
        logger.warn(
          { student_id: params.studentId, platform: params.subscription.platform },
          "store purchase registered without an AI add-on row; withdrawal waiver not recorded",
        );
        return;
      }
      if (row.purchase_ref === purchaseRef) return;

      const [user] = await tx<{ email: string | null }[]>`
        SELECT email FROM app.users WHERE id = ${params.userId}::uuid
      `;
      const email = deliverableEmail.safeParse(user?.email ?? null);
      const confirmation: WithdrawalWaiverConfirmation = email.success ? "email" : "in_app";
      const termsVersion = LEGAL_DOCUMENT_VERSIONS.terms;

      // The device's clock, but never later than the server's: the waiver cannot postdate the
      // purchase it was given for.
      const [recorded] = await tx<{ acknowledged_at: Date; recorded_at: Date }[]>`
        UPDATE app.ai_subscriptions
           SET withdrawal_waiver_purchase_ref = ${purchaseRef},
               withdrawal_waiver_acknowledged_at =
                 LEAST(${waiver.acknowledgedAt}::timestamptz, CURRENT_TIMESTAMP),
               withdrawal_waiver_terms_version = ${termsVersion},
               withdrawal_waiver_recorded_at = CURRENT_TIMESTAMP,
               withdrawal_waiver_confirmation = ${confirmation}
         WHERE id = ${row.id}::uuid
        RETURNING withdrawal_waiver_acknowledged_at AS acknowledged_at,
                  withdrawal_waiver_recorded_at AS recorded_at
      `;
      const acknowledgedAt = recorded!.acknowledged_at.toISOString();
      const recordedAt = recorded!.recorded_at.toISOString();

      await emitAuditLog(tx, {
        action: "update",
        targetTable: "ai_subscriptions",
        targetId: row.id,
        oldValues: { withdrawal_waiver_purchase_ref: row.purchase_ref },
        newValues: {
          withdrawal_waiver_purchase_ref: purchaseRef,
          withdrawal_waiver_acknowledged_at: acknowledgedAt,
          withdrawal_waiver_terms_version: termsVersion,
          withdrawal_waiver_recorded_at: recordedAt,
          withdrawal_waiver_confirmation: confirmation,
        },
      });

      if (email.success) {
        await emit(tx, DOMAIN_EVENTS.AI_STORE_PURCHASE_CONFIRMED, {
          schoolId: params.schoolId,
          aiSubscriptionId: row.id,
          studentId: params.studentId,
          email: email.data,
          platform: params.subscription.platform,
          acknowledgedAt,
          recordedAt,
          termsVersion,
        });
      }
    },
  );
}

/** The signed-in student's recorded withdrawal waiver, for the app's in-app confirmation. */
export async function readStorePurchaseConfirmation(
  tx: TransactionSql,
  studentId: string,
): Promise<StorePurchaseConfirmation | null> {
  const [row] = await tx<
    {
      acknowledged_at: Date | null;
      recorded_at: Date | null;
      terms_version: string | null;
      confirmation: WithdrawalWaiverConfirmation | null;
    }[]
  >`
    SELECT withdrawal_waiver_acknowledged_at AS acknowledged_at,
           withdrawal_waiver_recorded_at AS recorded_at,
           withdrawal_waiver_terms_version AS terms_version,
           withdrawal_waiver_confirmation AS confirmation
    FROM app.ai_subscriptions
    WHERE student_id = ${studentId}::uuid
  `;
  if (!row?.acknowledged_at || !row.recorded_at || !row.terms_version || !row.confirmation) {
    return null;
  }
  return {
    acknowledgedAt: row.acknowledged_at.toISOString(),
    recordedAt: row.recorded_at.toISOString(),
    termsVersion: row.terms_version,
    confirmation: row.confirmation,
  };
}

/** Why the add-on cannot be bought for a student in the app, for the app to say so. */
export type StoreOfferUnavailableReason =
  /** No store is set up on the server. */
  | "not_configured"
  /** The caller is not a student, nor a parent asking about a child linked to them. */
  | "not_student"
  /** The school's own plan is not live; the add-on only works on top of it. */
  | "school_plan_inactive"
  /** Every product is already held by a brother or sister, so a store account has none left. */
  | "no_free_product";

export interface StoreOffer {
  /** The student the offer is for. */
  studentId: string | null;
  /** Their first name, for "AI for <name>". */
  studentFirstName: string | null;
  /** Whether their AI add-on is on right now (by any route: store, website or school). */
  subscribed: boolean;
  /** The product to offer them: the one they already hold, else the first a sibling does not. */
  productId: string | null;
  unavailableReason: StoreOfferUnavailableReason | null;
}

const LIVE_AI_STATUSES = ["trialing", "active", "past_due", "grace_period"];

/**
 * What to offer in the app for buying the AI add-on for one student: the caller themselves, or --
 * for a parent -- a child linked to them.
 *
 * Which product: a store account (one Apple ID, one Google account) can hold one subscription to a
 * product, and the phone a family shares has one store account. So each child gets the first
 * product none of their brothers and sisters (students sharing a linked parent) holds, and a child
 * who already holds one keeps it. Siblings are found through the link rows only.
 */
export async function readStoreOffer(
  database: Database | DatabasePools,
  store: StoreBilling | null,
  params: { schoolId: string; userId: string; studentId?: string | null },
): Promise<StoreOffer> {
  const none = (reason: StoreOfferUnavailableReason): StoreOffer => ({
    studentId: null,
    studentFirstName: null,
    subscribed: false,
    productId: null,
    unavailableReason: reason,
  });
  if (!store || (store.apple === null && store.google === null)) return none("not_configured");

  return withSystemTx(database, async (tx) => {
    await setTenantScope(tx, params.schoolId);
    let targetId = params.studentId ?? null;
    if (!targetId) {
      const [own] = await tx<{ id: string }[]>`
        SELECT id FROM app.students
        WHERE user_id = ${params.userId}::uuid AND school_id = ${params.schoolId}::uuid
        LIMIT 1
      `;
      targetId = own?.id ?? null;
    }
    if (!targetId) return none("not_student");
    const relation = await readStudentRelation(tx, params.schoolId, params.userId, targetId);
    // A student asks only about themselves, a parent only about a child linked to them.
    if (!relation || !(relation.isSelf || relation.isGuardian)) return none("not_student");

    const [state] = await tx<{ plan_live: boolean; subscribed: boolean }[]>`
      SELECT
        EXISTS (
          SELECT 1 FROM app.subscriptions
          WHERE school_id = ${params.schoolId}::uuid
            AND status IN ('trialing', 'active', 'past_due', 'grace_period')
        ) AS plan_live,
        EXISTS (
          SELECT 1 FROM app.ai_subscriptions
          WHERE school_id = ${params.schoolId}::uuid
            AND student_id = ${relation.studentId}::uuid
            AND status::text IN ${tx(LIVE_AI_STATUSES)}
            AND current_period_end > CURRENT_TIMESTAMP
        ) AS subscribed
    `;

    // The store product each student in the family last bought, for students whose add-on is on.
    const held = await tx<{ student_id: string; product_id: string }[]>`
      WITH family AS (
        SELECT DISTINCT theirs.student_id
        FROM app.parent_child_links mine
        JOIN app.parent_child_links theirs
          ON theirs.school_id = mine.school_id
         AND theirs.parent_user_id = mine.parent_user_id
        WHERE mine.school_id = ${params.schoolId}::uuid
          AND mine.student_id = ${relation.studentId}::uuid
        UNION
        SELECT ${relation.studentId}::uuid
      )
      SELECT DISTINCT ON (e.payload -> 'metadata' ->> 'student_id')
             e.payload -> 'metadata' ->> 'student_id' AS student_id,
             e.payload ->> 'product_id' AS product_id
      FROM app.billing_events e
      JOIN app.ai_subscriptions a
        ON a.school_id = ${params.schoolId}::uuid
       AND a.student_id::text = e.payload -> 'metadata' ->> 'student_id'
       AND a.status::text IN ${tx(LIVE_AI_STATUSES)}
       AND a.current_period_end > CURRENT_TIMESTAMP
      WHERE e.provider IN ('apple', 'google')
        AND e.status = 'processed'
        AND e.payload ->> 'product_id' IS NOT NULL
        AND e.payload -> 'metadata' ->> 'school_id' = ${params.schoolId}
        AND (e.payload -> 'metadata' ->> 'student_id')::uuid IN (SELECT student_id FROM family)
      ORDER BY e.payload -> 'metadata' ->> 'student_id', e.effective_at DESC
    `;
    const own = held.find((row) => row.student_id === relation.studentId)?.product_id ?? null;
    const taken = new Set(
      held.filter((row) => row.student_id !== relation.studentId).map((row) => row.product_id),
    );
    const productIds = storeProductIds(store);
    const productId =
      own && productIds.includes(own) ? own : (productIds.find((id) => !taken.has(id)) ?? null);

    return {
      studentId: relation.studentId,
      studentFirstName: relation.firstName,
      subscribed: state!.subscribed,
      productId,
      unavailableReason: !state!.plan_live
        ? "school_plan_inactive"
        : productId === null
          ? "no_free_product"
          : null,
    };
  });
}

async function applyNotification(
  database: Database | DatabasePools,
  logger: Logger,
  params: {
    eventId: string;
    kind: StoreEventKind | null;
    subscription: StoreSubscription | null;
    effectiveAt: Date;
  },
): Promise<"ignored" | "unattributed" | string> {
  const { kind, subscription } = params;
  if (!kind || !subscription) return "ignored";

  const claim = await withSystemTx(database, (tx) =>
    findClaim(tx, subscription.platform, subscription.storeRef),
  );
  // A purchase the app has not reported yet (it reports on completion, so this is the window
  // before that, or an app that crashed) is attributed by what the purchase itself carries -- on
  // Google both ids, on Apple only the student, which is not enough to find the school. Unattributed
  // notifications are dropped: the app's report creates the record, and the store resends.
  const schoolId = claim?.schoolId ?? subscription.schoolId;
  const studentId = claim?.studentId ?? subscription.studentId;
  if (!schoolId || !studentId) {
    logger.info(
      { platform: subscription.platform, event_id: params.eventId },
      "store notification for a purchase not yet registered; skipped",
    );
    return "unattributed";
  }

  return applyStoreEvent(
    database,
    storeBillingEvent({
      eventId: `${subscription.platform}:notification:${params.eventId}`,
      kind,
      subscription,
      schoolId,
      studentId,
      effectiveAt: params.effectiveAt,
    }),
    logger,
  );
}

/** App Store Server Notifications V2. Throws CodedHttpException(400) when the signature fails. */
export async function handleAppleNotification(
  database: Database | DatabasePools,
  store: StoreBilling,
  logger: Logger,
  signedPayload: string,
): Promise<string> {
  if (!store.apple) throw storeError(503, ERROR_CODES.STORE_BILLING_NOT_CONFIGURED, "en");
  let notification;
  try {
    notification = await store.apple.verifyNotification(signedPayload);
  } catch (error) {
    if (error instanceof StoreVerificationError) {
      throw storeError(400, ERROR_CODES.STORE_WEBHOOK_INVALID, "en");
    }
    throw error;
  }
  return applyNotification(database, logger, {
    eventId: notification.eventId,
    kind: notification.kind,
    subscription: notification.subscription,
    effectiveAt: notification.signedAt,
  });
}

/** Google Play RTDN through a Pub/Sub push. The caller has already checked the URL token. */
export async function handleGooglePlayNotification(
  database: Database | DatabasePools,
  store: StoreBilling,
  logger: Logger,
  body: unknown,
): Promise<string> {
  if (!store.google) throw storeError(503, ERROR_CODES.STORE_BILLING_NOT_CONFIGURED, "en");
  let notification;
  try {
    notification = store.google.parseNotification(body);
  } catch (error) {
    if (error instanceof StoreVerificationError) {
      throw storeError(400, ERROR_CODES.STORE_WEBHOOK_INVALID, "en");
    }
    throw error;
  }
  if (notification.otherPackage) {
    // Another app's RTDN topic points at this endpoint: Play Console needs fixing, not the payload.
    logger.warn(
      { package: notification.otherPackage, eventId: notification.eventId },
      "google play notification for another package ignored",
    );
    return "ignored";
  }
  if (!notification.kind || !notification.purchaseToken) return "ignored";

  const subscription = await store.google.getSubscription(notification.purchaseToken);
  return applyNotification(database, logger, {
    eventId: notification.eventId,
    kind: notification.kind,
    subscription,
    effectiveAt: notification.sentAt,
  });
}
