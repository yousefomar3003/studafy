import { DEFAULT_AI_PROGRAMME_SETTINGS } from "@studafy/license-pricing";
import { ToastProvider } from "@studafy/ui";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
// eslint-disable-next-line import-x/no-unresolved -- "bun:test" is a virtual Bun built-in with no resolvable file path
import { afterEach, describe, expect, mock, test } from "bun:test";
import { MemoryRouter } from "react-router-dom";

/**
 * The Student AI programme page (000234): the global editor (prices per currency, tiers you can
 * add and remove, the rules), the store reminder when the in-app price changes, the non-blocking
 * warning when parents pay the licence price or less, validation shared with the API, the version
 * history with a diff, and a school's override editor.
 */

const SCHOOL_ID = "11111111-1111-4111-8111-111111111111";
const V1 = "a1000000-0000-4000-8000-000000000001";
const V2 = "22222222-2222-4222-8222-222222222222";

const v1 = {
  id: V1,
  versionNumber: 1,
  settings: DEFAULT_AI_PROGRAMME_SETTINGS,
  reason: "The approved defaults (2026-11-17).",
  createdBy: { userId: null, name: null },
  createdAt: "2026-11-17T00:00:00.000Z",
};
const v2 = {
  ...v1,
  id: V2,
  versionNumber: 2,
  settings: { ...DEFAULT_AI_PROGRAMME_SETTINGS, nonpaymentGraceDays: 45 },
  reason: "Longer grace",
  createdBy: { userId: "33333333-3333-4333-8333-333333333333", name: "Layla Ops" },
  createdAt: "2026-11-18T09:00:00.000Z",
};

const effective = {
  currencyCode: "USD",
  iapPriceMinor: 600,
  licensePriceMinor: 400,
  parentPriceMinor: 600,
  ...Object.fromEntries(Object.entries(v2.settings).filter(([key]) => key !== "prices")),
  overridden: [],
};

const getMock = mock((path: string, _init?: unknown) => {
  if (path === "/api/platform/ai-programme/versions") {
    return Promise.resolve({ data: { versions: [v2, v1] } });
  }
  if (path === "/api/platform/schools") {
    return Promise.resolve({
      data: { schools: [{ id: SCHOOL_ID, name: "Alpha Academy" }], total: 1 },
    });
  }
  if (path === "/api/platform/schools/{schoolId}/ai-programme") {
    return Promise.resolve({
      data: { schoolId: SCHOOL_ID, currencyCode: "USD", global: v2, override: null, effective },
    });
  }
  if (path === "/api/platform/schools/{schoolId}/ai-programme/overrides") {
    return Promise.resolve({ data: { overrides: [] } });
  }
  throw new Error(`Unhandled GET ${path}`);
});
const postMock = mock((path: string, _init?: { body?: Record<string, unknown> }) => {
  if (path === "/api/platform/ai-programme/versions") return Promise.resolve({ data: v2 });
  throw new Error(`Unhandled POST ${path}`);
});
const putMock = mock((path: string, _init?: { body?: Record<string, unknown> }) => {
  if (path === "/api/platform/schools/{schoolId}/ai-programme/override") {
    return Promise.resolve({ data: {} });
  }
  throw new Error(`Unhandled PUT ${path}`);
});

mock.module("../../../lib/api", () => ({
  api: { GET: getMock, POST: postMock, PUT: putMock },
}));

async function renderPage(url = "/portal/platform/ai-programme") {
  const { default: AiProgrammePage } = await import("./AiProgrammePage");
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={queryClient}>
      <ToastProvider>
        <MemoryRouter initialEntries={[url]}>
          <AiProgrammePage />
        </MemoryRouter>
      </ToastProvider>
    </QueryClientProvider>,
  );
}

const globalCard = async () =>
  within((await screen.findByRole("heading", { name: "Global settings" })).closest("section")!);

afterEach(() => {
  cleanup();
  getMock.mockClear();
  postMock.mockClear();
  putMock.mockClear();
});

describe("AiProgrammePage", () => {
  test("shows the version in force and saves a new one with a reason", async () => {
    await renderPage();
    const card = await globalCard();
    expect(card.getByText(/Version 2, saved by Layla Ops/)).toBeTruthy();
    const save = card.getByRole("button", { name: "Save new version" }) as HTMLButtonElement;
    expect(save.disabled).toBe(true);

    fireEvent.change(card.getByLabelText("Minimum seats"), { target: { value: "40" } });
    expect(save.disabled).toBe(true); // no reason yet
    fireEvent.change(card.getByLabelText("Reason for this change"), {
      target: { value: "Bigger minimum" },
    });
    expect(save.disabled).toBe(false);
    fireEvent.click(save);
    await waitFor(() => expect(postMock).toHaveBeenCalled());
    const body = postMock.mock.calls[0]![1]!.body!;
    expect(body).toMatchObject({
      minSeats: 40,
      nonpaymentGraceDays: 45,
      reason: "Bigger minimum",
      basedOnVersionId: V2,
    });
    // The defaults (owner, 2026-11-18): in-app $5.99, licence $4, school-offer price $4.
    expect(body.prices).toEqual([
      { currencyCode: "USD", iapPriceMinor: 599, licensePriceMinor: 400, parentPriceMinor: 400 },
    ]);
  });

  test("changing the in-app price reminds the super admin to update the stores", async () => {
    await renderPage();
    const card = await globalCard();
    expect(card.queryByTestId("store-reminder")).toBeNull();
    fireEvent.change(card.getByLabelText("In-app purchase price"), { target: { value: "7.00" } });
    expect(card.getByTestId("store-reminder").textContent).toContain("App Store Connect");
  });

  test("parents may pay the licence price or less: a warning, never a block", async () => {
    await renderPage();
    const card = await globalCard();
    // The defaults: parents $4 = the licence $4, so the school keeps no margin.
    expect(card.getByTestId("margin-warning").textContent).toContain("keeps no margin");
    fireEvent.change(card.getByLabelText("Price parents see"), { target: { value: "6.00" } });
    expect(card.queryByTestId("margin-warning")).toBeNull();
    fireEvent.change(card.getByLabelText("Price parents see"), { target: { value: "3.00" } });
    expect(card.getByTestId("margin-warning").textContent).toContain("less than the school");
    fireEvent.change(card.getByLabelText("Reason for this change"), {
      target: { value: "Parents pay less" },
    });
    const save = card.getByRole("button", { name: "Save new version" }) as HTMLButtonElement;
    expect(save.disabled).toBe(false);
    fireEvent.click(save);
    await waitFor(() => expect(postMock).toHaveBeenCalled());
    expect(
      (postMock.mock.calls[0]![1]!.body!.prices as { parentPriceMinor: number }[])[0]!
        .parentPriceMinor,
    ).toBe(300);
  });

  test("tiers can be added and removed, and broken tiers block saving", async () => {
    await renderPage();
    const card = await globalCard();
    expect(card.getAllByTestId("conversion-tiers-row")).toHaveLength(6);
    fireEvent.click(card.getAllByRole("button", { name: "Add tier" })[0]!);
    const rows = card.getAllByTestId("conversion-tiers-row");
    expect(rows).toHaveLength(7);
    // 90% -> 11%: lower than the 12% tier before it.
    fireEvent.change(within(rows[6]!).getByLabelText("From conversion"), {
      target: { value: "90" },
    });
    fireEvent.change(within(rows[6]!).getByLabelText("Share"), { target: { value: "11" } });
    fireEvent.change(card.getByLabelText("Reason for this change"), {
      target: { value: "Top tier" },
    });
    expect(card.getByText(/don't lower a share/)).toBeTruthy();
    const save = card.getByRole("button", { name: "Save new version" }) as HTMLButtonElement;
    expect(save.disabled).toBe(true);

    fireEvent.change(within(rows[6]!).getByLabelText("Share"), { target: { value: "16" } });
    expect(card.getByText("This is above the maximum revenue share.")).toBeTruthy();
    fireEvent.change(within(rows[6]!).getByLabelText("Share"), { target: { value: "13" } });
    expect(save.disabled).toBe(false);

    fireEvent.click(within(rows[6]!).getByRole("button", { name: "Remove" }));
    expect(card.getAllByTestId("conversion-tiers-row")).toHaveLength(6);
  });

  test("the version history shows who, when, why and what changed", async () => {
    await renderPage();
    const history = await screen.findByTestId("programme-history");
    const latest = within(history).getAllByRole("listitem")[0]!;
    expect(latest.textContent).toContain("Version 2");
    expect(latest.textContent).toContain("Layla Ops");
    expect(latest.textContent).toContain("Longer grace");
    const diff = within(latest).getByRole("table");
    expect(within(diff).getByText("30 days")).toBeTruthy();
    expect(within(diff).getByText("45 days")).toBeTruthy();
  });

  test("a school's override saves only the fields switched on", async () => {
    await renderPage(`/portal/platform/ai-programme?schoolId=${SCHOOL_ID}`);
    const editor = within(await screen.findByTestId("override-editor"));
    expect(editor.getByText(/This school uses the global settings/)).toBeTruthy();
    const minSeats = editor.getByLabelText("Minimum seats") as HTMLInputElement;
    expect(minSeats.disabled).toBe(true);

    // Parents at the licence price for this school: warned, still saved.
    const priceToggles = editor.getAllByLabelText("Set for this school");
    fireEvent.click(priceToggles[1]!); // parent price
    fireEvent.change(editor.getByLabelText("Price parents see"), { target: { value: "4.00" } });
    expect(editor.getAllByTestId("margin-warning")[0]!.textContent).toContain("keeps no margin");

    fireEvent.click(priceToggles[2]!); // minimum seats
    expect(minSeats.disabled).toBe(false);
    fireEvent.change(minSeats, { target: { value: "50" } });
    fireEvent.change(editor.getByLabelText("Reason for this change"), {
      target: { value: "Pilot" },
    });
    fireEvent.click(editor.getByRole("button", { name: "Save school settings" }));
    await waitFor(() => expect(putMock).toHaveBeenCalled());
    expect(putMock.mock.calls[0]![1]!.body).toMatchObject({
      parentPriceMinor: 400,
      licensePriceMinor: null,
      minSeats: 50,
      maxShareBps: null,
      conversionTiers: null,
      nonpaymentGraceDays: null,
      reason: "Pilot",
      basedOnOverrideId: null,
    });
  });
});
