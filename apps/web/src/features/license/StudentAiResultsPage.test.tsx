import { cleanup, screen, within } from "@testing-library/react";
// eslint-disable-next-line import-x/no-unresolved -- "bun:test" is a virtual Bun built-in with no resolvable file path
import { afterEach, describe, expect, mock, test } from "bun:test";

import { expectNoA11yViolations } from "../../lib/test/axe";
import { dashboard, uploads } from "../ai-programme/test-fixtures";

import { renderAs } from "./test-utils";

import type { ComponentType } from "react";

/**
 * Student AI results for the school admin and the principal: enrolled vs opted in, conversion and
 * the tier it earns (locked or not yet), "Add N more seats -> unlock X%" and the large-school floor
 * when it is closer, the year's earnings as a labelled sum, and upload consistency per teacher and
 * per class with those below the target marked in words.
 */

let summary: Record<string, unknown> = dashboard();
let report: Record<string, unknown> = uploads();

const getMock = mock((path: string) => {
  switch (path) {
    case "/api/school/ai-revenue-share/summary":
      return Promise.resolve({ data: summary });
    case "/api/school/license/upload-consistency":
      return Promise.resolve({ data: report });
    case "/api/school/license":
      return Promise.resolve({ data: { license: null, usage: [] } });
    case "/api/school/license/invoices":
      return Promise.resolve({ data: { invoices: [] } });
    default:
      throw new Error(`Unhandled GET ${path}`);
  }
});

mock.module("../../lib/api", () => ({ api: { GET: getMock } }));

const loadPage = async (): Promise<ComponentType> =>
  (await import("./StudentAiResultsPage")).default;

async function renderPage(role = "PRINCIPAL") {
  const Page = await loadPage();
  return renderAs(role, <Page />, {
    path: "/portal/license/student-ai/results",
    at: "/portal/license/student-ai/results",
  });
}

const stat = (key: string) => screen.getByTestId(`stat-${key}`).querySelector("dd")!.textContent;

afterEach(() => {
  cleanup();
  summary = dashboard();
  report = uploads();
  getMock.mockClear();
});

describe("StudentAiResultsPage", () => {
  test("the worked example: 350 of 500 opted in, 70% locked -> 10%, 75 more seats unlock 12%", async () => {
    await renderPage();
    expect(await screen.findByTestId("stat-enrolled")).toBeTruthy();
    expect(stat("enrolled")).toBe("500");
    expect(stat("opted-in")).toBe("350");
    expect(stat("conversion")).toBe("70%");
    expect(stat("tier")).toBe("10%");
    expect(stat("uploads")).toBe("85%");
    expect(stat("rate")).toBe("13%");
    expect(stat("earnings")).toBe("$8,820.00");
    expect(screen.getByTestId("conversion-sentence").textContent).toBe(
      "350 of 500 enrolled students opted in: 70% conversion, which earns a 10% share.",
    );
    expect(screen.getAllByText(/Measured and locked on Oct 1, 2026/).length).toBe(2);
    const next = screen.getByTestId("next-tier");
    expect(next.textContent).toContain("Add 75 more seats → unlock 12%");
    expect(within(next).queryByTestId("floor-hint")).toBeNull();
    // The tier the school is in is marked on the ladder.
    const ladder = screen.getByRole("list", { name: "Conversion tiers" });
    const current = within(ladder)
      .getAllByRole("listitem")
      .find((item) => item.getAttribute("aria-current") === "true");
    expect(current?.textContent).toBe("70% and up10% share");
  });

  test("the year's earnings: share $1,820 + margin $7,000 = $8,820, each part labelled", async () => {
    await renderPage();
    const earnings = await screen.findByTestId("earnings");
    expect(within(earnings).getByTestId("earnings-share").textContent).toBe("$1,820.00");
    expect(within(earnings).getByTestId("earnings-margin").textContent).toBe("$7,000.00");
    expect(within(earnings).getByTestId("earnings-total").textContent).toBe("$8,820.00");
    expect(within(earnings).queryByTestId("earnings-estimated")).toBeNull();
    expect(earnings.textContent).toContain("Total earnings, 2026-2027");
    expect(earnings.textContent).toContain("Margin: $2.00 per student per month.");
  });

  test("auto-billing off: the margin is an estimate and says so", async () => {
    const base = dashboard();
    summary = dashboard({
      earnings: {
        ...(base.earnings as object),
        margin: {
          basis: "estimated",
          autoBilling: false,
          perStudentMonthMinor: 200,
          lines: 350,
          billedMinor: 0,
          collectedMinor: 0,
          estimatedMinor: 700_000,
          expectedMinor: 700_000,
        },
        totalMinor: 882_000,
        estimated: true,
      },
    });
    await renderPage("ORG_ADMIN");
    const earnings = await screen.findByTestId("earnings");
    expect(within(earnings).getByTestId("earnings-estimated").textContent).toBe("$7,000.00");
    expect(within(earnings).getAllByText("Estimated").length).toBeGreaterThan(0);
    expect(earnings.textContent).toContain("Includes an estimate.");
    expect(within(earnings).queryByTestId("earnings-margin")).toBeNull();
  });

  test("not measured yet, below the floor: today's figure, and the floor when it is closer", async () => {
    summary = dashboard({
      students: { enrolled: 1000, optedIn: 300, conversionBps: 3000 },
      conversion: {
        periodStart: "2026-09-01",
        measureOn: "2026-12-01",
        source: "live",
        enrolled: 1000,
        optedIn: 300,
        conversionBps: 3000,
        seats: 450,
        tierFromBps: 2500,
        shareBps: 400,
        floorApplied: false,
      },
      nextTier: { fromBps: 4000, shareBps: 600, optInsNeeded: 100 },
      largeSchoolFloor: { minSeats: 500, shareBps: 800, seatsNeeded: 50 },
    });
    await renderPage();
    expect(
      (await screen.findAllByText(/Today's figure\. It is measured and locked on Dec 1, 2026/))
        .length,
    ).toBe(2);
    const next = screen.getByTestId("next-tier");
    expect(next.textContent).toContain("Add 100 more seats → unlock 6%");
    expect(within(next).getByTestId("floor-hint").textContent).toBe(
      "Closer: reach 500 licence seats (50 more) for the large-school floor of 8%.",
    );
  });

  test("upload consistency per teacher and class, the ones below the 80% target marked", async () => {
    await renderPage();
    expect((await screen.findByTestId("upload-aim")).textContent).toContain("Target: 80%");
    const teachers = within(screen.getByTestId("upload-teachers"));
    const karim = teachers.getByText("Karim Benali").closest("tr")!;
    expect(karim.getAttribute("data-below")).toBe("true");
    expect(within(karim).getByText("Below target")).toBeTruthy();
    expect(karim.textContent).toContain("74%");
    const amal = teachers.getByText("Amal Idrissi").closest("tr")!;
    expect(amal.getAttribute("data-below")).toBeNull();
    expect(within(amal).queryByText("Below target")).toBeNull();
    const classes = within(screen.getByTestId("upload-classes"));
    const science = classes.getByText("Science").closest("tr")!;
    expect(science.textContent).toContain("37 of 50");
    expect(within(science).getByText("Below target")).toBeTruthy();
    // Lowest first: the class that most needs attention leads.
    const rows = within(screen.getByTestId("upload-classes")).getAllByRole("row").slice(1);
    expect(rows[0]!.textContent).toContain("Science");
  });

  test("a licence not in the programme yet points to the opt-in page", async () => {
    const base = dashboard();
    summary = dashboard({ license: { ...(base.license as object), inProgramme: false } });
    await renderPage();
    const link = await screen.findByRole("link", { name: "Go to Student AI opt-in" });
    expect(link.getAttribute("href")).toBe("/portal/license/student-ai");
  });

  test("has no accessibility violations", async () => {
    const { container } = await renderPage();
    await screen.findByTestId("upload-teachers");
    await expectNoA11yViolations(container);
  });
});
