import { cleanup, fireEvent, screen, within } from "@testing-library/react";
// eslint-disable-next-line import-x/no-unresolved -- "bun:test" is a virtual Bun built-in with no resolvable file path
import { afterEach, describe, expect, mock, test } from "bun:test";

import { SCHOOL_ID, schoolRow } from "../../ai-programme/test-fixtures";
import { renderAs } from "../../license/test-utils";

import { filterProgrammeSchools, sortProgrammeSchools } from "./AiProgrammeSchoolsPage";

import type { ProgrammeSchoolRow } from "../../ai-programme/queries";
import type { ComponentType } from "react";

/**
 * The console's overview of every school in the Student AI programme: one row each with its
 * conversion, uploads, share and what Studafy keeps per seat; sortable by any figure, filtered by
 * name, programme, money owed, or earning no share; each school opening its ledger.
 */

const OTHER = "10000000-0000-4000-8000-000000000099";
const rows = [
  schoolRow(),
  schoolRow({
    schoolId: OTHER,
    schoolName: "Basma School",
    enrolled: 1000,
    optedIn: 200,
    liveConversionBps: 2000,
    conversionBps: 2000,
    conversionSource: "live",
    conversionShareBps: 0,
    bonusBps: 0,
    totalBps: 0,
    collectedMinor: 400_000,
    owedMinor: 0,
    earnedMinor: 0,
    studafyNetMinor: 400_000,
    studafyNetPerSeatMinor: 4000,
  }),
] as unknown as ProgrammeSchoolRow[];

const getMock = mock((path: string) => {
  if (path === "/api/platform/ai-revenue-share/schools") {
    return Promise.resolve({ data: { schools: rows } });
  }
  throw new Error(`Unhandled GET ${path}`);
});

mock.module("../../../lib/api", () => ({ api: { GET: getMock } }));

const loadPage = async (): Promise<ComponentType> =>
  (await import("./AiProgrammeSchoolsPage")).default;

async function renderPage() {
  const Page = await loadPage();
  return renderAs("SUPER_ADMIN", <Page />, {
    path: "/portal/platform/ai-programme/schools",
    at: "/portal/platform/ai-programme/schools",
  });
}

const names = () =>
  within(screen.getByTestId("programme-schools"))
    .getAllByRole("row")
    .slice(1)
    .map((row) => row.querySelector("a")!.textContent);

afterEach(() => {
  cleanup();
  getMock.mockClear();
});

describe("AiProgrammeSchoolsPage", () => {
  test("a row per school with its figures and a link to its ledger", async () => {
    await renderPage();
    const table = await screen.findByTestId("programme-schools");
    const atlas = within(table).getByRole("link", { name: "Atlas Academy" }).closest("tr")!;
    expect(within(atlas).getByRole("link", { name: "Atlas Academy" }).getAttribute("href")).toBe(
      `/portal/platform/ai-programme/schools/${SCHOOL_ID}`,
    );
    const text = atlas.textContent!;
    expect(text).toContain("350 / 500");
    expect(text).toContain("70%");
    expect(text).toContain("Locked");
    expect(text).toContain("13%");
    expect(text).toContain("10% + 3%");
    expect(text).toContain("$14,000.00");
    expect(text).toContain("$1,820.00");
    expect(text).toContain("$34.80");
    expect(text).toContain("$12,180.00 in total");
  });

  test("sorting by a column, both ways, with aria-sort", async () => {
    await renderPage();
    await screen.findByTestId("programme-schools");
    expect(names()).toEqual(["Atlas Academy", "Basma School"]);
    const header = screen.getByRole("button", { name: /Studafy net \/ seat/ });
    fireEvent.click(header);
    expect(header.closest("th")!.getAttribute("aria-sort")).toBe("ascending");
    expect(names()).toEqual(["Atlas Academy", "Basma School"]);
    fireEvent.click(header);
    expect(header.closest("th")!.getAttribute("aria-sort")).toBe("descending");
    expect(names()).toEqual(["Basma School", "Atlas Academy"]);
  });

  test("filters: by name, money owed, or earning no share", async () => {
    await renderPage();
    await screen.findByTestId("programme-schools");
    fireEvent.click(screen.getByLabelText("Share owed or due"));
    expect(names()).toEqual(["Atlas Academy"]);
    fireEvent.click(screen.getByLabelText("Share owed or due"));
    fireEvent.click(screen.getByLabelText("Earning no share"));
    expect(names()).toEqual(["Basma School"]);
    fireEvent.click(screen.getByLabelText("Earning no share"));
    fireEvent.change(screen.getByLabelText("School name"), { target: { value: "atl" } });
    expect(names()).toEqual(["Atlas Academy"]);
  });

  test("filter and sort as pure functions", () => {
    const filters = { search: "", inProgrammeOnly: true, owedOnly: false, belowTier: false };
    const notIn = schoolRow({ schoolId: "x", schoolName: "Cedar", inProgramme: false });
    expect(
      filterProgrammeSchools([...rows, notIn] as unknown as ProgrammeSchoolRow[], filters),
    ).toHaveLength(2);
    expect(sortProgrammeSchools(rows, "conversion", "descending").map((r) => r.schoolName)).toEqual(
      ["Atlas Academy", "Basma School"],
    );
    expect(sortProgrammeSchools(rows, "collected", "ascending").map((r) => r.schoolName)).toEqual([
      "Basma School",
      "Atlas Academy",
    ]);
  });
});
