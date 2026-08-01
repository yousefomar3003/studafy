/**
 * The state machine's own invariants (ST-132).
 *
 * Pure: no database, no Stripe. These are the properties the transition tables must hold for the
 * fold to mean anything, checked against the tables themselves rather than restated by hand -- a
 * test that enumerated the expected edges would just be the table typed twice.
 */

import { SUBSCRIPTION_STATUSES } from "@studafy/constants";
// eslint-disable-next-line import-x/no-unresolved -- "bun:test" is a virtual Bun built-in with no resolvable file path
import { describe, expect, test } from "bun:test";

import {
  AI_TRANSITIONS,
  deriveIntent,
  foldStatus,
  GENESIS_STATUS,
  LIVE_STATUSES,
  resolveAiCascade,
  resolveTransition,
  SCHOOL_TRANSITIONS,
  TERMINAL_STATUSES,
} from "../state-machine";

import type { SubscriptionStatus } from "@studafy/constants";

const ALL_STATUSES = Object.values(SUBSCRIPTION_STATUSES);

const TABLES = [
  ["school", SCHOOL_TRANSITIONS],
  ["ai", AI_TRANSITIONS],
] as const;

describe("transition tables", () => {
  test.each(TABLES)("%s: every key names a real status and a real intent", (_kind, table) => {
    for (const key of Object.keys(table)) {
      const [from, intent] = key.split(":");
      expect(ALL_STATUSES).toContain(from as SubscriptionStatus);
      expect(intent).toBeTruthy();
    }
  });

  test.each(TABLES)("%s: every target is a real status", (_kind, table) => {
    for (const target of Object.values(table)) {
      expect(ALL_STATUSES).toContain(target as SubscriptionStatus);
    }
  });

  // The property the fold depends on. If a terminal state had an outgoing edge, a stray event could
  // resurrect a canceled subscription -- which is the exact scenario ST-132 names as illegal.
  test.each(TABLES)("%s: terminal states are absorbing", (_kind, table) => {
    for (const key of Object.keys(table)) {
      const from = key.split(":")[0] as SubscriptionStatus;
      expect(TERMINAL_STATUSES.has(from)).toBe(false);
    }
  });

  test("live and terminal states partition the enum", () => {
    const union = new Set([...LIVE_STATUSES, ...TERMINAL_STATUSES]);
    expect(union.size).toBe(ALL_STATUSES.length);
    for (const status of ALL_STATUSES) expect(union.has(status)).toBe(true);
    for (const status of LIVE_STATUSES) expect(TERMINAL_STATUSES.has(status)).toBe(false);
  });

  test("genesis is a live state", () => {
    expect(LIVE_STATUSES.has(GENESIS_STATUS)).toBe(true);
  });
});

describe("resolveTransition", () => {
  test("the ticket's required edges exist", () => {
    expect(resolveTransition("school", "trialing", "activated")).toBe("active");
    expect(resolveTransition("school", "active", "payment_failed")).toBe("past_due");
    expect(resolveTransition("school", "past_due", "dunning_exhausted")).toBe("grace_period");
    expect(resolveTransition("school", "grace_period", "grace_exhausted")).toBe("closed");
    // active -> canceled (voluntary) and past_due -> active (payment recovered).
    expect(resolveTransition("school", "active", "canceled")).toBe("canceled");
    expect(resolveTransition("school", "past_due", "activated")).toBe("active");
  });

  test("a stray reactivation of a canceled subscription is illegal", () => {
    expect(resolveTransition("school", "canceled", "activated")).toBeNull();
    expect(resolveTransition("ai", "canceled", "activated")).toBeNull();
    expect(resolveTransition("school", "closed", "activated")).toBeNull();
    expect(resolveTransition("school", "expired", "trial_started")).toBeNull();
  });

  test("every terminal state refuses every intent", () => {
    const intents = ["trial_started", "activated", "payment_failed", "canceled"] as const;
    for (const from of TERMINAL_STATUSES) {
      for (const intent of intents) {
        expect(resolveTransition("school", from, intent)).toBeNull();
        expect(resolveTransition("ai", from, intent)).toBeNull();
      }
    }
  });
});

describe("resolveAiCascade", () => {
  test("leaving a live state drags AI subscriptions with it", () => {
    expect(resolveAiCascade("active", "canceled")).toBe("canceled");
    expect(resolveAiCascade("grace_period", "closed")).toBe("closed");
    expect(resolveAiCascade("trialing", "expired")).toBe("expired");
  });

  test("moving between live states does not cascade", () => {
    expect(resolveAiCascade("active", "past_due")).toBeNull();
    expect(resolveAiCascade("past_due", "grace_period")).toBeNull();
    expect(resolveAiCascade("grace_period", "active")).toBeNull();
  });

  // Recovery is not automatic: re-entitling a student is a billing decision with a price attached.
  test("returning to a live state does not resurrect AI subscriptions", () => {
    expect(resolveAiCascade("canceled", "active")).toBeNull();
    expect(resolveAiCascade("closed", "trialing")).toBeNull();
  });
});

describe("deriveIntent", () => {
  test("fixed-intent events do not consult the payload", () => {
    expect(deriveIntent("invoice.payment_failed", {})).toEqual({
      kind: "transition",
      intent: "payment_failed",
    });
    expect(deriveIntent("customer.subscription.deleted", {})).toEqual({
      kind: "transition",
      intent: "canceled",
    });
  });

  test("status-bearing events take their meaning from the payload", () => {
    expect(deriveIntent("customer.subscription.updated", { status: "active" })).toEqual({
      kind: "transition",
      intent: "activated",
    });
    expect(deriveIntent("customer.subscription.updated", { status: "past_due" })).toEqual({
      kind: "transition",
      intent: "payment_failed",
    });
    expect(deriveIntent("customer.subscription.updated", { status: "unpaid" })).toEqual({
      kind: "transition",
      intent: "dunning_exhausted",
    });
  });

  // One event name, four meanings — the reason the tables are keyed on intent rather than on the
  // Stripe event type.
  test("one event type resolves to different intents by payload status", () => {
    const intents = ["active", "past_due", "canceled", "unpaid"].map((status) =>
      deriveIntent("customer.subscription.updated", { status }),
    );
    const distinct = new Set(intents.map((r) => (r.kind === "transition" ? r.intent : r.kind)));
    expect(distinct.size).toBe(4);
  });

  test("an abandoned checkout carries no state meaning", () => {
    expect(deriveIntent("customer.subscription.updated", { status: "incomplete" })).toEqual({
      kind: "ignored",
    });
  });

  test("known-but-uninteresting events are ignored, not parked", () => {
    expect(deriveIntent("customer.created", {})).toEqual({ kind: "ignored" });
    expect(deriveIntent("charge.succeeded", {})).toEqual({ kind: "ignored" });
  });

  // The point of the allowlist: a genuinely new Stripe event must be distinguishable from one we
  // decided not to care about.
  test("an unrecognised event type is unmapped", () => {
    expect(deriveIntent("entitlements.active_entitlement_summary.updated", {})).toEqual({
      kind: "unmapped",
    });
    expect(deriveIntent("customer.subscription.updated", { status: "quantum" })).toEqual({
      kind: "unmapped",
    });
    expect(deriveIntent("customer.subscription.updated", {})).toEqual({ kind: "unmapped" });
  });
});

describe("foldStatus", () => {
  const event = (id: string, eventType: string, payload: Record<string, unknown> = {}) => ({
    id,
    eventType,
    payload,
  });

  test("an empty history folds to genesis", () => {
    expect(foldStatus("school", []).status).toBe(GENESIS_STATUS);
  });

  test("a happy path folds to active", () => {
    const result = foldStatus("school", [
      event("evt_1", "customer.subscription.created", { status: "trialing" }),
      event("evt_2", "checkout.session.completed"),
      event("evt_3", "invoice.paid"),
    ]);
    expect(result.status).toBe("active");
    expect(result.skipped).toEqual([]);
  });

  test("ignored events do not disturb the fold", () => {
    const result = foldStatus("school", [
      event("evt_1", "invoice.paid"),
      event("evt_2", "customer.created"),
      event("evt_3", "charge.succeeded"),
    ]);
    expect(result.status).toBe("active");
    expect(result.skipped).toEqual([]);
  });

  test("an event after a terminal state is skipped, and named", () => {
    const result = foldStatus("school", [
      event("evt_1", "customer.subscription.deleted"),
      event("evt_2", "invoice.paid"),
    ]);
    expect(result.status).toBe("canceled");
    expect(result.skipped).toHaveLength(1);
    expect(result.skipped[0]).toMatchObject({
      id: "evt_2",
      from: "canceled",
      intent: "activated",
    });
  });

  test("dunning to lockout", () => {
    const result = foldStatus("school", [
      event("evt_1", "invoice.paid"),
      event("evt_2", "invoice.payment_failed"),
      event("evt_3", "customer.subscription.updated", { status: "unpaid" }),
      event("evt_4", "invoice.marked_uncollectible"),
    ]);
    expect(result.status).toBe("closed");
  });

  test("payment recovered inside the grace window returns to active", () => {
    const result = foldStatus("school", [
      event("evt_1", "invoice.paid"),
      event("evt_2", "invoice.payment_failed"),
      event("evt_3", "customer.subscription.paused"),
      event("evt_4", "invoice.paid"),
    ]);
    expect(result.status).toBe("active");
  });
});
