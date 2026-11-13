import { ToastProvider } from "@studafy/ui";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
// eslint-disable-next-line import-x/no-unresolved -- "bun:test" is a virtual Bun built-in with no resolvable file path
import { afterEach, describe, mock, test } from "bun:test";
import { MemoryRouter, Route, Routes } from "react-router-dom";

import { expectNoA11yViolations } from "../../../lib/test/axe";

import { reportDetailFixture, reportFixture } from "./test-fixtures";

import type { ComponentType } from "react";

/**
 * Automated accessibility audit for the message report review screens, mirroring
 * `discipline/a11y.test.tsx` — one render per representative state inside a `<main>`, matching how
 * `RootLayout` wraps every route.
 */

const getMock = mock((path: string) => {
  if (path === "/api/messaging/reports/{reportId}") {
    return Promise.resolve<unknown>({ data: { report: reportDetailFixture() } });
  }
  return Promise.resolve<unknown>({
    data: { reports: [reportFixture()], total: 1, limit: 25, offset: 0 },
  });
});

mock.module("../../../lib/api", () => ({ api: { GET: getMock } }));

const loadListPage = async (): Promise<ComponentType> =>
  (await import("./MessageReportListPage")).default;
const loadDetailPage = async (): Promise<ComponentType> =>
  (await import("./MessageReportDetailPage")).default;

function renderInMain(Page: ComponentType, path: string, entry: string) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={queryClient}>
      <ToastProvider>
        <MemoryRouter initialEntries={[entry]}>
          <main>
            <Routes>
              <Route path={path} element={<Page />} />
            </Routes>
          </main>
        </MemoryRouter>
      </ToastProvider>
    </QueryClientProvider>,
  );
}

afterEach(() => {
  cleanup();
  getMock.mockClear();
});

describe("message report review accessibility", () => {
  test("report list", async () => {
    const { container } = renderInMain(
      await loadListPage(),
      "/portal/principal/message-reports",
      "/portal/principal/message-reports",
    );
    await screen.findByText("Harassment");

    await expectNoA11yViolations(container);
  });

  test("report detail with transcript and images", async () => {
    const { container } = renderInMain(
      await loadDetailPage(),
      "/portal/principal/message-reports/:reportId",
      "/portal/principal/message-reports/report-1",
    );
    await screen.findByRole("heading", { name: "Harassment" });

    await expectNoA11yViolations(container);
  });

  test("resolution modal open with a validation error", async () => {
    const { container } = renderInMain(
      await loadDetailPage(),
      "/portal/principal/message-reports/:reportId",
      "/portal/principal/message-reports/report-1",
    );
    await screen.findByRole("heading", { name: "Harassment" });

    fireEvent.click(screen.getByRole("button", { name: "Dismiss" }));
    const dialog = await screen.findByRole("dialog", { name: "Dismiss report" });
    fireEvent.click(within(dialog).getByRole("button", { name: "Dismiss report" }));
    await screen.findByText("Enter a resolution note (up to 2000 characters).");

    await expectNoA11yViolations(container);
  });
});
