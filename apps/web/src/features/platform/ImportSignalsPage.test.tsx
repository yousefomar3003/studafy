import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, render, screen, within } from "@testing-library/react";
// eslint-disable-next-line import-x/no-unresolved -- "bun:test" is a virtual Bun built-in with no resolvable file path
import { afterEach, describe, expect, mock, test } from "bun:test";
import { MemoryRouter } from "react-router-dom";

import { expectNoA11yViolations } from "../../lib/test/axe";

let signal: unknown = {
  min_schools: 3,
  headers: [
    { normalized_header: "bloodtype", header: "Blood Type", schools: 7, imports: 9 },
    { normalized_header: "busstop", header: "Bus stop", schools: 3, imports: 3 },
  ],
};

const getMock = mock((_path: string) => Promise.resolve<unknown>({ data: signal }));
mock.module("../../lib/api", () => ({ api: { GET: getMock } }));

async function renderPage() {
  const Page = (await import("./ImportSignalsPage")).default;
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter>
        <main>
          <Page />
        </main>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

afterEach(() => {
  cleanup();
  getMock.mockClear();
});

describe("ImportSignalsPage", () => {
  test("shows header text and counts only, most widely shared first", async () => {
    const { container } = await renderPage();
    const table = await screen.findByRole("table", { name: "Unused column headers" });
    const rows = within(table).getAllByRole("row");
    expect(within(rows[1]!).getByText("Blood Type")).toBeTruthy();
    expect(within(rows[1]!).getByText("7")).toBeTruthy();
    expect(within(rows[2]!).getByText("Bus stop")).toBeTruthy();
    expect(getMock.mock.calls[0]![0]).toBe("/api/platform/import-signals/unmapped-headers");
    await expectNoA11yViolations(container);
  });

  test("says when no header is shared widely enough yet", async () => {
    signal = { min_schools: 3, headers: [] };
    await renderPage();
    expect(await screen.findByText("No unused column is shared by 3 schools yet.")).toBeTruthy();
  });
});
