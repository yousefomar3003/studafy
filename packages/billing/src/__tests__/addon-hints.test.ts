/**
 * The metadata hints a storage add-on's events are attributed by (db/migrations/000205): our
 * checkout writes `addon: "storage"` and `price_id` on the session and the subscription, and the
 * invoices carry them under `parent.subscription_details`.
 */

// eslint-disable-next-line import-x/no-unresolved -- "bun:test" is a virtual Bun built-in with no resolvable file path
import { describe, expect, test } from "bun:test";

import { extractAddonHint, extractLocalPriceIdHint } from "../event-mapping";

const PRICE_ID = "6f1c2b8e-3d4a-4b5c-9d6e-7f8a9b0c1d2e";

describe("storage add-on hints", () => {
  test("read from the event's own metadata", () => {
    const payload = { metadata: { addon: "storage", price_id: PRICE_ID } };
    expect(extractAddonHint(payload)).toBe("storage");
    expect(extractLocalPriceIdHint(payload)).toBe(PRICE_ID);
  });

  test("read from an invoice's subscription details", () => {
    const payload = {
      metadata: {},
      parent: { subscription_details: { metadata: { addon: "storage", price_id: PRICE_ID } } },
    };
    expect(extractAddonHint(payload)).toBe("storage");
    expect(extractLocalPriceIdHint(payload)).toBe(PRICE_ID);
  });

  test("absent for a school plan or an AI add-on", () => {
    expect(extractAddonHint({ metadata: { school_id: "s" } })).toBeNull();
    expect(extractAddonHint({ metadata: { student_id: "s", addon: "other" } })).toBeNull();
    expect(extractAddonHint({})).toBeNull();
  });
});
