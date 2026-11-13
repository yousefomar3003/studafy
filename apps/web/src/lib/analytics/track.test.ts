// eslint-disable-next-line import-x/no-unresolved -- "bun:test" is a virtual Bun built-in with no resolvable file path
import { afterEach, describe, expect, test } from "bun:test";

import { track } from "./track";

afterEach(() => {
  delete window.dataLayer;
});

describe("track", () => {
  test("pushes the event and its properties onto window.dataLayer", () => {
    window.dataLayer = [];

    track("registration_started", { step: "school" });

    expect(window.dataLayer).toEqual([{ event: "registration_started", step: "school" }]);
  });

  test("pushes an event with no properties as just the event name", () => {
    window.dataLayer = [];

    track("registration_started");

    expect(window.dataLayer).toEqual([{ event: "registration_started" }]);
  });

  test("does not throw when no dataLayer has been installed", () => {
    expect(() => track("registration_started")).not.toThrow();
  });
});
