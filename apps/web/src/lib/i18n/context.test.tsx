import { cleanup, fireEvent, render, waitFor } from "@testing-library/react";
// eslint-disable-next-line import-x/no-unresolved -- "bun:test" is a virtual Bun built-in with no resolvable file path
import { afterEach, describe, expect, test } from "bun:test";

import { LocaleProvider, useLocale } from "./context";
import { localeStore } from "./store";

/** Exercises `useLocale` the way a real consumer (the header's `LocaleSwitcher`) would. */
function LocaleProbe() {
  const { locale, dir, setLocale } = useLocale();
  return (
    <div>
      <span data-testid="locale">{locale}</span>
      <span data-testid="dir">{dir}</span>
      <button onClick={() => setLocale("ar")}>switch to ar</button>
      <button onClick={() => setLocale("en")}>switch to en</button>
    </div>
  );
}

afterEach(() => {
  cleanup();
  localeStore.setLocale("en");
});

describe("LocaleProvider", () => {
  test("sets <html lang dir> from the persisted locale on mount", () => {
    render(
      <LocaleProvider>
        <LocaleProbe />
      </LocaleProvider>,
    );

    expect(document.documentElement.lang).toBe("en");
    expect(document.documentElement.dir).toBe("ltr");
  });

  test("switching to Arabic sets dir=rtl and lang=ar, and mirrors back on switching to English", async () => {
    const { getByText } = render(
      <LocaleProvider>
        <LocaleProbe />
      </LocaleProvider>,
    );

    fireEvent.click(getByText("switch to ar"));

    await waitFor(() => {
      expect(document.documentElement.dir).toBe("rtl");
      expect(document.documentElement.lang).toBe("ar");
    });

    fireEvent.click(getByText("switch to en"));

    await waitFor(() => {
      expect(document.documentElement.dir).toBe("ltr");
      expect(document.documentElement.lang).toBe("en");
    });
  });
});
