/**
 * QA-056: access follows money that has actually arrived, and disputes are not silent.
 *
 * - `checkout.session.completed` activated a subscription whatever its `payment_status`. For a
 *   delayed method (SEPA debit, ACH) that is `unpaid`, so access began before any money arrived and
 *   stayed on if the debit later failed. The session now activates only when `paid` (or
 *   `no_payment_required`); a delayed one activates on `checkout.session.async_payment_succeeded`.
 * - `charge.dispute.*` was unmapped, so every dispute was parked in the dead-letter queue as an
 *   unknown event type. A dispute carries no subscription, so it cannot move a status by itself;
 *   it is now recorded and raised as an alert for a human to act on.
 * - `charge.refunded` stays recorded without a status change until the refund policy is decided.
 */

// eslint-disable-next-line import-x/no-unresolved -- "bun:test" is a virtual Bun built-in
import { describe, expect, test } from "bun:test";

import { deriveIntent, foldStatus } from "../state-machine";

const completed = (payment_status?: string) =>
  ({ id: "evt_c", eventType: "checkout.session.completed", payload: { payment_status } }) as const;

describe("checkout settlement (QA-056)", () => {
  test("a paid or free checkout activates", () => {
    for (const status of ["paid", "no_payment_required"]) {
      expect(deriveIntent("checkout.session.completed", { payment_status: status })).toEqual({
        kind: "transition",
        intent: "activated",
      });
    }
  });

  test("an unpaid (delayed-method) checkout does not activate", () => {
    expect(deriveIntent("checkout.session.completed", { payment_status: "unpaid" })).toEqual({
      kind: "ignored",
    });
    expect(foldStatus("ai", [completed("unpaid")]).status).toBe("trialing");
  });

  test("the delayed payment arriving activates", () => {
    const fold = foldStatus("ai", [
      completed("unpaid"),
      { id: "evt_s", eventType: "checkout.session.async_payment_succeeded", payload: {} },
    ]);
    expect(fold.status).toBe("active");
  });

  test("the delayed payment failing is recorded, not parked", () => {
    expect(deriveIntent("checkout.session.async_payment_failed", {})).toEqual({ kind: "ignored" });
  });
});

describe("disputes (QA-056)", () => {
  test.each([
    ["charge.dispute.created", "dispute_opened"],
    ["charge.dispute.funds_withdrawn", "dispute_funds_withdrawn"],
  ] as const)("%s raises an alert instead of being parked as unknown", (type, alert) => {
    expect(deriveIntent(type, { object: "dispute" })).toEqual({ kind: "alert", alert });
  });

  test("the rest of a dispute's lifecycle is recorded quietly", () => {
    for (const type of [
      "charge.dispute.updated",
      "charge.dispute.closed",
      "charge.dispute.funds_reinstated",
    ]) {
      expect(deriveIntent(type, {})).toEqual({ kind: "ignored" });
    }
  });
});
