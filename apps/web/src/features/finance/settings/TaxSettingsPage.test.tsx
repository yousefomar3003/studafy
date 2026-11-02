import { cleanup, fireEvent, screen, waitFor } from "@testing-library/react";
// eslint-disable-next-line import-x/no-unresolved -- "bun:test" is a virtual Bun built-in with no resolvable file path
import { afterEach, describe, expect, mock, test } from "bun:test";

import { callTo, renderFinance } from "../test-utils";

const SETTINGS = {
  configured: false,
  is_enabled: false,
  tax_name: "VAT",
  rate: 0,
  erpnext_account_head: null,
  registration_number: null,
  prices_include_tax: false,
  exempt_fee_categories: [],
  updated_by: null,
  updated_at: null,
};

const getMock = mock((_path: string, _init?: unknown) => Promise.resolve({ data: SETTINGS }));
const putMock = mock((_path: string, init?: { body: Record<string, unknown> }) =>
  Promise.resolve({ data: { ...SETTINGS, ...init?.body, configured: true } }),
);

mock.module("../../../lib/api", () => ({ api: { GET: getMock, PUT: putMock } }));

afterEach(() => {
  cleanup();
  getMock.mockClear();
  putMock.mockClear();
});

const load = async () => (await import("./TaxSettingsPage")).default;

describe("TaxSettingsPage", () => {
  test("a school admin turns VAT on with a rate, account, number and exempt fees", async () => {
    const Page = await load();
    await renderFinance(<Page />, { roles: ["ORG_ADMIN"] });

    fireEvent.click(await screen.findByLabelText("Charge tax on new invoices"));
    // Turning tax on without a rate and an account is refused here first.
    expect(screen.getByText(/needs a rate above 0/)).toBeTruthy();

    fireEvent.change(screen.getByLabelText(/^Rate/), { target: { value: "5" } });
    fireEvent.change(screen.getByLabelText(/ERPNext tax account/), {
      target: { value: "VAT 5% - SCH" },
    });
    fireEvent.change(screen.getByLabelText(/Tax registration number/), {
      target: { value: "100234567800003" },
    });
    fireEvent.change(screen.getByLabelText("Exempt fee categories"), {
      target: { value: "Tuition\n Books ,\n" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Save tax settings" }));

    await waitFor(() => expect(putMock).toHaveBeenCalledTimes(1));
    expect(callTo(putMock.mock.calls, "/api/finance/tax-settings")?.body).toEqual({
      is_enabled: true,
      tax_name: "VAT",
      rate: 5,
      erpnext_account_head: "VAT 5% - SCH",
      registration_number: "100234567800003",
      prices_include_tax: false,
      exempt_fee_categories: ["Tuition", "Books"],
    });
    expect(await screen.findByText("Tax settings saved")).toBeTruthy();
  });

  test("finance reads the settings but cannot change them", async () => {
    const Page = await load();
    await renderFinance(<Page />, { roles: ["FINANCE"] });
    expect(await screen.findByText("Only a school admin can change these settings.")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Save tax settings" })).toBeNull();
    // Disabled through its fieldset, which the property does not reflect.
    expect(screen.getByLabelText("Charge tax on new invoices").matches(":disabled")).toBe(true);
  });
});
