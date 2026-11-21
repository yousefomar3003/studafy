import { NOTIFICATION_TYPES } from "@studafy/constants";
// eslint-disable-next-line import-x/no-unresolved -- "bun:test" is a virtual Bun built-in with no resolvable file path
import { describe, expect, test } from "bun:test";

import { enCatalog } from "../../lib/i18n/locales/catalog";

import { notificationTypeLabel } from "./labels";

describe("notification type labels", () => {
  // A type added to @studafy/constants without a label showed its raw code ("LICENSE_EXPIRING") on
  // the preferences page and in the inbox. The catalog test then keeps Arabic in step with English.
  test("every notification type has an English label", () => {
    const types = (enCatalog as { site: { notifications: { types: Record<string, string> } } }).site
      .notifications.types;
    const missing = Object.values(NOTIFICATION_TYPES).filter((type) => !(type in types));
    expect(missing).toEqual([]);
  });

  test("a label is the translation, never the wire code", () => {
    const t = (key: string) => `translated:${key}`;
    expect(notificationTypeLabel(NOTIFICATION_TYPES.LICENSE_EXPIRING, t)).toBe(
      "translated:site.notifications.types.LICENSE_EXPIRING",
    );
  });
});
