/**
 * Out-of-order convergence, as a property (ST-132).
 *
 * The acceptance criterion is "an out-of-order event sequence converges to the correct final state".
 * The property that makes that true is stronger and simpler to state:
 *
 *   For any set of events for one subscription, the folded state depends only on the set and its
 *   effective-time ordering -- never on the order the events were delivered in.
 *
 * `foldStatus` takes an already-ordered sequence, so at this level the property is that sorting by
 * `(effectiveAt, id)` is what the caller's ordering reduces to. These tests therefore shuffle the
 * *arrival* order, sort exactly as `loadFoldSequence`'s ORDER BY does, and assert the fold is
 * identical every time. `webhook-ordering.test.ts` in apps/api asserts the same property end to end
 * through the database.
 *
 * ## Why exhaustive permutations rather than a property-testing library
 *
 * The repository has no `fast-check` dependency, and for a fixed five-event sequence it would not
 * help: 5! is 120, so enumerating every permutation is both cheap and *complete*. Random sampling
 * would be strictly weaker -- it can miss the one ordering that breaks -- and shrinking has nothing
 * to do when the failing case is already minimal. A generator earns its keep over a space too large
 * to enumerate; this one is not.
 */

// eslint-disable-next-line import-x/no-unresolved -- "bun:test" is a virtual Bun built-in with no resolvable file path
import { describe, expect, test } from "bun:test";

import { foldStatus } from "../state-machine";

import type { SubscriptionKind } from "../state-machine";

interface TimedEvent {
  id: string;
  eventType: string;
  effectiveAt: number;
  payload: Record<string, unknown>;
}

/** Every ordering of `items`. Heap-free and readable; n is 5, so the cost is irrelevant. */
function permutations<T>(items: readonly T[]): T[][] {
  if (items.length <= 1) return [[...items]];

  const result: T[][] = [];
  for (let i = 0; i < items.length; i++) {
    const rest = [...items.slice(0, i), ...items.slice(i + 1)];
    for (const tail of permutations(rest)) {
      result.push([items[i]!, ...tail]);
    }
  }
  return result;
}

/**
 * Exactly the ordering `loadFoldSequence` asks PostgreSQL for: effective time, then provider event
 * id as the tiebreaker. Duplicated here on purpose -- if the SQL ORDER BY changes and this does not,
 * these tests should stop agreeing with production, and that is the signal worth having.
 */
function inEffectiveOrder(events: readonly TimedEvent[]): TimedEvent[] {
  return [...events].sort((a, b) =>
    a.effectiveAt === b.effectiveAt ? a.id.localeCompare(b.id) : a.effectiveAt - b.effectiveAt,
  );
}

function foldInArrivalOrder(kind: SubscriptionKind, arrival: readonly TimedEvent[]) {
  return foldStatus(
    kind,
    inEffectiveOrder(arrival).map((e) => ({
      id: e.id,
      eventType: e.eventType,
      payload: e.payload,
    })),
  );
}

/**
 * A five-event lifecycle: trial, activation, a failed charge, dunning exhaustion, lockout.
 *
 * Chosen because it is not order-insensitive by accident. It ends in a terminal state, and three of
 * the five events are illegal from that state -- so a fold that let arrival order decide would give
 * different answers, which is exactly the watermark failure documented in
 * docs/database/stripe-webhook-state-machine.md.
 */
const LIFECYCLE: TimedEvent[] = [
  {
    id: "evt_1",
    eventType: "customer.subscription.created",
    effectiveAt: 1_700_000_100,
    payload: { status: "trialing" },
  },
  { id: "evt_2", eventType: "invoice.paid", effectiveAt: 1_700_000_200, payload: {} },
  { id: "evt_3", eventType: "invoice.payment_failed", effectiveAt: 1_700_000_300, payload: {} },
  {
    id: "evt_4",
    eventType: "customer.subscription.updated",
    effectiveAt: 1_700_000_400,
    payload: { status: "unpaid" },
  },
  {
    id: "evt_5",
    eventType: "invoice.marked_uncollectible",
    effectiveAt: 1_700_000_500,
    payload: {},
  },
];

describe("out-of-order convergence", () => {
  const orderings = permutations(LIFECYCLE);

  test("the fixture really does exercise every permutation", () => {
    expect(orderings).toHaveLength(120);
    expect(new Set(orderings.map((o) => o.map((e) => e.id).join(","))).size).toBe(120);
  });

  test("every arrival order converges to the same final state", () => {
    const expected = foldInArrivalOrder("school", LIFECYCLE);
    expect(expected.status).toBe("closed");

    for (const arrival of orderings) {
      const actual = foldInArrivalOrder("school", arrival);
      expect({ order: arrival.map((e) => e.id).join(","), status: actual.status }).toEqual({
        order: arrival.map((e) => e.id).join(","),
        status: expected.status,
      });
    }
  });

  test("every arrival order also agrees on what was skipped", () => {
    const expected = foldInArrivalOrder("school", LIFECYCLE);
    for (const arrival of orderings) {
      expect(foldInArrivalOrder("school", arrival).skipped).toEqual(expected.skipped);
    }
  });

  test("AI subscriptions converge identically", () => {
    const expected = foldInArrivalOrder("ai", LIFECYCLE);
    for (const arrival of orderings) {
      expect(foldInArrivalOrder("ai", arrival).status).toBe(expected.status);
    }
  });

  // The sequence whose in-order and out-of-order results a watermark design would disagree on: a
  // cancellation followed by a renewal that cannot legally follow it. Convergence here is the whole
  // reason the fold replays from genesis instead of patching the current value.
  test("a renewal delivered after a cancellation cannot resurrect it, whichever arrives first", () => {
    const cancelThenRenew: TimedEvent[] = [
      {
        id: "evt_cancel",
        eventType: "customer.subscription.deleted",
        effectiveAt: 1_700_000_100,
        payload: {},
      },
      { id: "evt_renew", eventType: "invoice.paid", effectiveAt: 1_700_000_200, payload: {} },
    ];

    for (const arrival of permutations(cancelThenRenew)) {
      const result = foldInArrivalOrder("school", arrival);
      expect(result.status).toBe("canceled");
      expect(result.skipped.map((s) => s.id)).toEqual(["evt_renew"]);
    }
  });

  // Two events in the same Stripe `created` second. Without the provider-event-id tiebreaker the
  // ordering would not be total and the fold would stop being a function of the set.
  test("events sharing an effective second still order totally", () => {
    const sameSecond: TimedEvent[] = [
      { id: "evt_a", eventType: "invoice.paid", effectiveAt: 1_700_000_100, payload: {} },
      {
        id: "evt_b",
        eventType: "invoice.payment_failed",
        effectiveAt: 1_700_000_100,
        payload: {},
      },
    ];

    const results = permutations(sameSecond).map((o) => foldInArrivalOrder("school", o).status);
    expect(new Set(results).size).toBe(1);
    // evt_a sorts first by id, so the failure is applied last.
    expect(results[0]).toBe("past_due");
  });
});
