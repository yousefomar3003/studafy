// eslint-disable-next-line import-x/no-unresolved -- "bun:test" is a virtual Bun built-in with no resolvable file path
import { describe, expect, test } from "bun:test";

import { createLocaleStore } from "./store";

/** Minimal `Storage` fake — enough of the interface for `getItem`/`setItem`. */
function createFakeStorage(initial: Record<string, string> = {}): Storage {
  const data = new Map(Object.entries(initial));
  return {
    getItem: (key) => data.get(key) ?? null,
    setItem: (key, value) => {
      data.set(key, value);
    },
    removeItem: (key) => {
      data.delete(key);
    },
    clear: () => data.clear(),
    key: (index) => [...data.keys()][index] ?? null,
    get length() {
      return data.size;
    },
  };
}

describe("createLocaleStore", () => {
  test("defaults to en with no persisted choice and no matching browser locale", () => {
    const store = createLocaleStore({ storage: createFakeStorage(), detectLocale: () => "fr-FR" });
    expect(store.getLocale()).toBe("en");
  });

  test("prefers the browser locale over the default when nothing is persisted", () => {
    const store = createLocaleStore({ storage: createFakeStorage(), detectLocale: () => "ar-EG" });
    expect(store.getLocale()).toBe("ar");
  });

  test("prefers a persisted locale over the browser locale", () => {
    const store = createLocaleStore({
      storage: createFakeStorage({ "studafy:locale": "ar" }),
      detectLocale: () => "en-US",
    });
    expect(store.getLocale()).toBe("ar");
  });

  test("ignores an unsupported persisted value", () => {
    const store = createLocaleStore({
      storage: createFakeStorage({ "studafy:locale": "fr" }),
      detectLocale: () => undefined,
    });
    expect(store.getLocale()).toBe("en");
  });

  test("setLocale persists the choice and notifies subscribers", () => {
    const storage = createFakeStorage();
    const store = createLocaleStore({ storage, detectLocale: () => undefined });
    let notified = 0;
    store.subscribe(() => {
      notified += 1;
    });

    store.setLocale("ar");

    expect(store.getLocale()).toBe("ar");
    expect(storage.getItem("studafy:locale")).toBe("ar");
    expect(notified).toBe(1);
  });

  test("setLocale is a no-op when the locale is unchanged", () => {
    const store = createLocaleStore({
      storage: createFakeStorage(),
      detectLocale: () => undefined,
    });
    let notified = 0;
    store.subscribe(() => {
      notified += 1;
    });

    store.setLocale("en");

    expect(notified).toBe(0);
  });

  test("unsubscribe stops further notifications", () => {
    const store = createLocaleStore({
      storage: createFakeStorage(),
      detectLocale: () => undefined,
    });
    let notified = 0;
    const unsubscribe = store.subscribe(() => {
      notified += 1;
    });
    unsubscribe();

    store.setLocale("ar");

    expect(notified).toBe(0);
  });
});
