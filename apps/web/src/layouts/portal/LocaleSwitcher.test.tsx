import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
// eslint-disable-next-line import-x/no-unresolved -- "bun:test" is a virtual Bun built-in with no resolvable file path
import { afterEach, describe, expect, test } from "bun:test";

import { localeStore } from "../../lib/i18n";
import { expectNoA11yViolations } from "../../lib/test/axe";

import { LocaleSwitcher } from "./LocaleSwitcher";

afterEach(() => {
  cleanup();
  localeStore.setLocale("en");
});

describe("LocaleSwitcher", () => {
  test("reflects the persisted locale and offers both supported locales by their own name", () => {
    render(<LocaleSwitcher />);

    const select = screen.getByRole("combobox", { name: "Language" }) as HTMLSelectElement;
    expect(select.value).toBe("en");
    expect(screen.getByRole("option", { name: "English" })).toBeTruthy();
    expect(screen.getByRole("option", { name: "العربية" })).toBeTruthy();
  });

  test("choosing Arabic persists the choice", async () => {
    render(<LocaleSwitcher />);

    fireEvent.change(screen.getByRole("combobox", { name: "Language" }), {
      target: { value: "ar" },
    });

    await waitFor(() => {
      expect(localeStore.getLocale()).toBe("ar");
    });
  });

  test("has no accessibility violations", async () => {
    const { container } = render(<LocaleSwitcher />);
    await expectNoA11yViolations(container);
  });
});
