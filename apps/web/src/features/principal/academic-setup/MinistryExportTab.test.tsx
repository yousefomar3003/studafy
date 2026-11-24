import { ToastProvider } from "@studafy/ui";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
// eslint-disable-next-line import-x/no-unresolved -- "bun:test" is a virtual Bun built-in with no resolvable file path
import { afterEach, describe, expect, mock, test } from "bun:test";
import { MemoryRouter, Route, Routes } from "react-router-dom";

import { AuthProvider } from "../../../lib/auth";
import { expectNoA11yViolations } from "../../../lib/test/axe";
import { createTestSessionStore } from "../../../lib/test/session";

import { parseValueMap } from "./MinistryExportTab";

import type { ComponentType } from "react";

/**
 * Academic setup's ministry export: the school's templates, starting one from a built-in example
 * (marked as an example, not an official format), the editor's checks, and a preview with what is
 * missing before the file is downloaded.
 */

const STAMP = { created_at: "2026-08-01T00:00:00.000Z", updated_at: "2026-08-01T00:00:00.000Z" };
const YEAR = {
  id: "year-1",
  school_id: "school-1",
  code: "2026",
  name: "2026-2027",
  status: "active",
  starts_on: "2026-09-01",
  ends_on: "2027-06-30",
  ...STAMP,
};
const TERM = {
  id: "term-1",
  school_id: "school-1",
  academic_year_id: "year-1",
  code: "T1",
  name: "Term 1",
  sequence_number: 1,
  starts_on: "2026-09-01",
  ends_on: "2027-01-31",
  status: "active",
  ...STAMP,
};
const GRADE_10 = {
  id: "grade-10",
  school_id: "school-1",
  name: "Grade 10",
  sort_order: 10,
  ...STAMP,
};
const OVERVIEW = {
  year: { id: "year-1", code: "2026", name: "2026-2027", grading_config_status: "active" },
  grades: [],
  counts: {},
  issues: [],
};
const TEMPLATE = {
  id: "tpl-1",
  name: "Jordan MoE",
  target: "Jordan MoE",
  file_format: "csv",
  encoding: "utf8_bom",
  row_kind: "subject",
  decimal_places: 2,
  national_id_field: {
    id: "field-nid",
    label_en: "National ID",
    label_ar: "الرقم الوطني",
    sensitive: true,
    archived: false,
  },
  columns: [
    { header: "National ID", field: "national_id", constant_value: null, value_map: [] },
    { header: "Mark", field: "mark", constant_value: null, value_map: [] },
  ],
  subject_codes: [],
  ...STAMP,
};
const EXAMPLE = {
  key: "overall_results",
  name_en: "Overall results (example)",
  name_ar: "النتيجة النهائية (مثال)",
  note_en: "An editable example, not an official ministry format.",
  note_ar: "مثال قابل للتعديل.",
  template: {
    name: "Overall results",
    target: "Ministry of Education",
    file_format: "xlsx",
    encoding: "utf8",
    row_kind: "overall",
    decimal_places: 2,
    columns: [
      { header: "Student number", field: "admission_number", constant_value: null, value_map: [] },
      {
        header: "Result",
        field: "status",
        constant_value: null,
        value_map: [{ from: "promoted", to: "Promoted" }],
      },
    ],
  },
};
const RECORD_FORM = {
  subject_kind: "student",
  version: 1,
  fields: [
    {
      id: "field-nid",
      field_type: "short_text",
      label_en: "National ID",
      label_ar: "الرقم الوطني",
      help_en: null,
      help_ar: null,
      required: false,
      options: [],
      sort_order: 0,
      visibility: "staff_only",
      sensitivity: "sensitive",
      has_expiry: false,
    },
  ],
};
const PREVIEW = {
  template_id: "tpl-1",
  file_format: "csv",
  total_rows: 2,
  students: 2,
  sections_included: 1,
  header: ["National ID", "Mark"],
  rows: [{ cells: ["•••• 4567", "86.46"] }, { cells: ["", "70.00"] }],
  national_ids_masked: true,
  issues: [
    {
      code: "missing_national_id",
      severity: "error",
      count: 1,
      student_id: "stu-badr",
      student_name: "Badr Nasser",
      admission_number: "A-2",
      subject_id: null,
      subject_code: null,
      subject_name: null,
      section_id: "sec-a",
      section_name: "10A",
      grade_level_name: "Grade 10",
    },
    {
      code: "section_not_finalized",
      severity: "warning",
      count: 0,
      student_id: null,
      student_name: null,
      admission_number: null,
      subject_id: null,
      subject_code: null,
      subject_name: null,
      section_id: "sec-b",
      section_name: "10B",
      grade_level_name: "Grade 10",
    },
  ],
};

const GET_RESPONSES = new Map<string, unknown>(
  Object.entries({
    "/api/grading/ministry-export-templates": { templates: [TEMPLATE] },
    "/api/grading/ministry-export-examples": { examples: [EXAMPLE] },
    "/api/record-forms/{subjectKind}": RECORD_FORM,
    "/api/academics/years": { academic_years: [YEAR], total: 1 },
    "/api/academics/years/{yearId}/terms": { terms: [TERM], total: 1 },
    "/api/academics/grade-levels": { grade_levels: [GRADE_10], total: 1 },
    "/api/academics/subjects": { subjects: [], total: 0 },
    "/api/grading/years/{yearId}/overview": OVERVIEW,
  }),
);
const getMock = mock((path: string, _init?: unknown) =>
  Promise.resolve<unknown>({ data: GET_RESPONSES.get(path) }),
);
const postMock = mock((path: string, _init?: unknown) => {
  if (path === "/api/grading/ministry-exports/preview") {
    return Promise.resolve<unknown>({ data: PREVIEW });
  }
  if (path === "/api/grading/ministry-exports/download") {
    return Promise.resolve<unknown>({
      data: new Blob(["National ID,Mark\r\n"]),
      response: new Response(null, {
        headers: { "Content-Disposition": 'attachment; filename="jordan-moe-2026-annual.csv"' },
      }),
    });
  }
  return Promise.resolve<unknown>({ data: TEMPLATE });
});
const putMock = mock((_path: string, _init?: unknown) =>
  Promise.resolve<unknown>({ data: TEMPLATE }),
);
const deleteMock = mock((_path: string, _init?: unknown) =>
  Promise.resolve<unknown>({ data: undefined }),
);
mock.module("../../../lib/api", () => ({
  api: { GET: getMock, POST: postMock, PUT: putMock, DELETE: deleteMock },
}));

async function renderTab() {
  const Page: ComponentType = (await import("./AcademicSetupPage")).default;
  const store = await createTestSessionStore(["PRINCIPAL"]);
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <AuthProvider store={store}>
      <QueryClientProvider client={queryClient}>
        <ToastProvider>
          <MemoryRouter
            initialEntries={["/portal/principal/academic-setup/ministry-export?year=year-1"]}
          >
            <main>
              <Routes>
                <Route path="/portal/principal/academic-setup/*" element={<Page />} />
              </Routes>
            </main>
          </MemoryRouter>
        </ToastProvider>
      </QueryClientProvider>
    </AuthProvider>,
  );
}

async function choose(label: string, option: string) {
  const select = screen.getByRole("combobox", { name: label });
  await waitFor(() =>
    expect(select.hasAttribute("disabled") || select.getAttribute("aria-disabled") === "true").toBe(
      false,
    ),
  );
  fireEvent.click(select);
  fireEvent.click(await screen.findByRole("option", { name: option }));
}

afterEach(() => {
  cleanup();
  getMock.mockClear();
  postMock.mockClear();
  putMock.mockClear();
  deleteMock.mockClear();
});

describe("parseValueMap", () => {
  test("reads one our = ministry pair per line and flags lines without =", () => {
    expect(parseValueMap("pass = 1\n\n fail=2 \nB+ = A=1\nexempt")).toEqual({
      entries: [
        { from: "pass", to: "1" },
        { from: "fail", to: "2" },
        { from: "B+", to: "A=1" },
      ],
      bad: ["exempt"],
    });
  });
});

describe("MinistryExportTab", () => {
  test("lists the templates and starts a new one from an example, marked as an example", async () => {
    const { container } = await renderTab();
    const edit = await screen.findByRole("button", { name: "Edit Jordan MoE" });
    const row = edit.closest("tr")!;
    expect(within(row).getByText("CSV, UTF-8 with BOM (Excel, Arabic)")).toBeTruthy();
    expect(within(row).getByText(/2 columns/)).toBeTruthy();
    // The export panel below has its grades (and terms) loaded before the page is checked.
    await screen.findByLabelText("Grade 10");
    await expectNoA11yViolations(container);

    await choose("Start from an example", "Overall results (example)");
    fireEvent.click(screen.getByRole("button", { name: "Use this example" }));
    expect(
      await screen.findByText("An editable example, not an official ministry format."),
    ).toBeTruthy();
    expect((screen.getByLabelText(/^Name/) as HTMLInputElement).value).toBe("Overall results");
    // Overall rows take no subject codes.
    expect(screen.queryByText("Ministry subject codes")).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "Save template" }));
    await waitFor(() => expect(postMock).toHaveBeenCalledTimes(1));
    const [path, init] = postMock.mock.calls[0] as [string, { body: unknown }];
    expect(path).toBe("/api/grading/ministry-export-templates");
    expect(init.body).toEqual({
      name: "Overall results",
      target: "Ministry of Education",
      file_format: "xlsx",
      encoding: "utf8",
      row_kind: "overall",
      decimal_places: 2,
      national_id_field_id: null,
      columns: [
        {
          header: "Student number",
          field: "admission_number",
          constant_value: null,
          value_map: [],
        },
        {
          header: "Result",
          field: "status",
          constant_value: null,
          value_map: [{ from: "promoted", to: "Promoted" }],
        },
      ],
      subject_codes: [],
    });
  });

  test("the editor checks the template as the API will before saving", async () => {
    await renderTab();
    fireEvent.click(await screen.findByRole("button", { name: "Edit Jordan MoE" }));
    const save = await screen.findByRole("button", { name: "Save template" });
    expect((save as HTMLButtonElement).disabled).toBe(false);

    const second = screen.getByRole("group", { name: "Column 2" });
    fireEvent.change(within(second).getByLabelText(/Value map/), {
      target: { value: "pass" },
    });
    expect(
      await screen.findByText('Column 2: "pass" needs an = between our value and the ministry\'s.'),
    ).toBeTruthy();
    expect((save as HTMLButtonElement).disabled).toBe(true);

    fireEvent.change(within(second).getByLabelText(/Value map/), {
      target: { value: "pass = 1" },
    });
    fireEvent.change(within(second).getByLabelText(/^Heading/), {
      target: { value: "national id" },
    });
    expect(await screen.findByText("Column 2: another column has this heading.")).toBeTruthy();
    expect((save as HTMLButtonElement).disabled).toBe(true);
  });

  test("previews the year's export with what is missing, then downloads the file", async () => {
    const created: Blob[] = [];
    const originalCreate = URL.createObjectURL;
    const originalRevoke = URL.revokeObjectURL;
    URL.createObjectURL = (blob: Blob) => {
      created.push(blob);
      return "blob:export";
    };
    URL.revokeObjectURL = () => undefined;
    try {
      await renderTab();
      await screen.findByRole("button", { name: "Edit Jordan MoE" });
      fireEvent.click(screen.getByRole("button", { name: "Preview" }));
      await waitFor(() =>
        expect(postMock).toHaveBeenCalledWith("/api/grading/ministry-exports/preview", {
          body: {
            template_id: "tpl-1",
            academic_year_id: "year-1",
            term_id: null,
            grade_level_ids: [],
          },
        }),
      );
      expect(await screen.findByText("2 rows, 2 students, 1 sections finalized.")).toBeTruthy();
      expect(screen.getByText(/National IDs are masked here/)).toBeTruthy();
      expect(screen.getByText("Badr Nasser (A-2) has no national ID.")).toBeTruthy();
      expect(
        screen.getByText(
          "Grade 10 10B has no finalized results for this period and is not in the file.",
        ),
      ).toBeTruthy();
      expect(screen.getByText("•••• 4567")).toBeTruthy();

      const download = screen.getByRole("button", { name: /^Download/ }) as HTMLButtonElement;
      fireEvent.click(download);
      await waitFor(() => expect(created).toHaveLength(1));
      await waitFor(() => expect(download.getAttribute("aria-busy")).not.toBe("true"));
      const call = postMock.mock.calls.find(
        ([path]) => path === "/api/grading/ministry-exports/download",
      ) as [string, { parseAs: string }];
      expect(call[1].parseAs).toBe("blob");
    } finally {
      URL.createObjectURL = originalCreate;
      URL.revokeObjectURL = originalRevoke;
    }
  });
});
