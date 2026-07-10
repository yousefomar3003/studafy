// eslint-disable-next-line import-x/no-unresolved -- "bun:test" is a virtual Bun built-in with no resolvable file path
import { describe, expect, test } from "bun:test";

import { DOMAIN_EVENTS } from "./events";

describe("DOMAIN_EVENTS", () => {
  test("every event value is unique", () => {
    const values = Object.values(DOMAIN_EVENTS);
    expect(new Set(values).size).toBe(values.length);
  });

  test("every event value follows the resource.pastTenseAction convention", () => {
    const eventPattern = /^[a-z][a-zA-Z]*\.[a-z][a-zA-Z]*$/;

    for (const value of Object.values(DOMAIN_EVENTS)) {
      expect(value).toMatch(eventPattern);
    }
  });
});
