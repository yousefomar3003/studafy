import { ToastProvider } from "@studafy/ui";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
// eslint-disable-next-line import-x/no-unresolved -- "bun:test" is a virtual Bun built-in with no resolvable file path
import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";

import type { RecordsPanelProps } from "./RecordsPanel";
import type { ComponentType } from "react";

const SECRET = "784-1990-1234567-1";

function field(overrides: Record<string, unknown>) {
  return {
    help_en: null,
    help_ar: null,
    required: false,
    options: [],
    sort_order: 0,
    visibility: "staff_only",
    sensitivity: "standard",
    has_expiry: false,
    ...overrides,
  };
}

function entry(fieldDefinition: Record<string, unknown>, overrides: Record<string, unknown> = {}) {
  return {
    field: fieldDefinition,
    archived: false,
    value: null,
    masked: false,
    mask: null,
    answered: false,
    missing: false,
    answered_in_version: null,
    answered_field: null,
    document: null,
    updated_at: null,
    ...overrides,
  };
}

const BUS = field({
  id: "field-bus",
  field_type: "single_choice",
  label_en: "Bus route",
  label_ar: "خط الحافلة",
  options: [
    { value: "red", label_en: "Red route", label_ar: "الخط الأحمر" },
    { value: "blue", label_en: "Blue route", label_ar: "الخط الأزرق" },
  ],
});
const ALLERGIES = field({
  id: "field-allergies",
  field_type: "short_text",
  label_en: "Allergies",
  label_ar: "الحساسية",
  required: true,
});
const NATIONAL_ID = field({
  id: "field-id",
  field_type: "short_text",
  label_en: "National ID",
  label_ar: "رقم الهوية",
  sensitivity: "sensitive",
});
const BIRTH_CERTIFICATE = field({
  id: "field-birth",
  field_type: "document",
  label_en: "Birth certificate",
  label_ar: "شهادة الميلاد",
  required: true,
  has_expiry: true,
});

function records(overrides: { entries?: unknown[]; missing_required?: number } = {}) {
  return {
    subject_kind: "student",
    subject_id: "student-1",
    template_version: 2,
    missing_required: 2,
    entries: [
      entry(BUS, {
        value: "red",
        answered: true,
        answered_in_version: 1,
        answered_field: { ...BUS, label_en: "Morning bus" },
      }),
      entry(ALLERGIES, { missing: true }),
      entry(NATIONAL_ID, { masked: true, mask: "•••• 67-1", answered: true }),
      entry(BIRTH_CERTIFICATE, { missing: true }),
      entry(
        field({
          id: "field-locker",
          field_type: "short_text",
          label_en: "Locker",
          label_ar: "خزانة",
        }),
        {
          archived: true,
          value: "B-12",
          answered: true,
        },
      ),
    ],
    ...overrides,
  };
}

interface RequestInit {
  params?: { path?: Record<string, string> };
  body?: Record<string, unknown>;
}

let current: ReturnType<typeof records> = records();

const getMock = mock((path: string, _init?: RequestInit) => {
  if (path === "/api/students/{studentId}/records")
    return Promise.resolve<unknown>({ data: current });
  return Promise.resolve<unknown>({ data: {} });
});
const postMock = mock((path: string, _init?: RequestInit) => {
  if (path === "/api/students/{studentId}/records/{fieldId}/reveal") {
    return Promise.resolve<unknown>({ data: { field_id: "field-id", value: SECRET } });
  }
  if (path === "/api/storage/uploads/request-upload") {
    return Promise.resolve<unknown>({
      data: {
        upload_url: "https://storage.example/upload",
        storage_key: "temp/school-1/object-1/birth.pdf",
        expires_at: "2026-10-28T10:00:00.000Z",
      },
    });
  }
  return Promise.resolve<unknown>({ data: {} });
});
const putMock = mock((path: string, _init?: RequestInit) => {
  if (path === "/api/students/{studentId}/records/{fieldId}/document") {
    current = records({
      entries: current.entries.map((item) =>
        (item as { field: { id: string } }).field.id === "field-birth"
          ? entry(BIRTH_CERTIFICATE, {
              answered: true,
              document: {
                status: "uploaded",
                file_name: "birth.pdf",
                content_type: "application/pdf",
                size_bytes: 1024,
                sensitive: false,
                uploaded_at: "2026-10-28T10:00:00.000Z",
                verified_at: null,
                expires_on: "2030-01-01",
                expiry_state: "valid",
              },
            })
          : item,
      ),
    });
  }
  return Promise.resolve<unknown>({ data: current });
});

mock.module("../../lib/api", () => ({
  api: { GET: getMock, POST: postMock, PUT: putMock, PATCH: putMock, DELETE: putMock },
}));

const fetchMock = mock(() => Promise.resolve(new Response(null, { status: 200 })));
const realFetch = globalThis.fetch;

const loadPanel = async (): Promise<ComponentType<RecordsPanelProps>> =>
  (await import("./RecordsPanel")).RecordsPanel;

function renderPanel(
  Panel: ComponentType<RecordsPanelProps>,
  props: Partial<RecordsPanelProps> = {},
) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const view = render(
    <QueryClientProvider client={queryClient}>
      <ToastProvider>
        <Panel
          subject={{ kind: "student", id: "student-1" }}
          canEdit
          canRevealSensitive
          {...props}
        />
      </ToastProvider>
    </QueryClientProvider>,
  );
  return { ...view, queryClient };
}

function callsTo(mocked: typeof putMock, path: string) {
  return mocked.mock.calls.filter(([called]) => called === path) as [string, RequestInit][];
}

beforeEach(() => {
  globalThis.fetch = fetchMock as unknown as typeof fetch;
});

afterEach(() => {
  cleanup();
  current = records();
  globalThis.fetch = realFetch;
  for (const mocked of [getMock, postMock, putMock, fetchMock]) mocked.mockClear();
});

describe("RecordsPanel", () => {
  test("shows answers in the active language, missing fields, older versions and archived answers", async () => {
    renderPanel(await loadPanel());

    expect(await screen.findByText("Red route")).toBeTruthy();
    expect(screen.getByText("2 required fields are missing")).toBeTruthy();
    expect(screen.getAllByText("Missing")).toHaveLength(2);
    expect(screen.getByText(/when the field read “Morning bus”/)).toBeTruthy();
    const archived = screen.getByRole("region", { name: "No longer on the form" });
    expect(within(archived).getByText("B-12")).toBeTruthy();
  });

  test("fills in a record, sending only what changed", async () => {
    renderPanel(await loadPanel());
    fireEvent.click(await screen.findByRole("button", { name: "Edit record" }));

    const form = screen.getByRole("form", { name: "Edit record" });
    fireEvent.change(within(form).getByLabelText(/Allergies/), { target: { value: "Peanuts" } });
    fireEvent.click(within(form).getByRole("button", { name: "Save record" }));

    await waitFor(() =>
      expect(callsTo(putMock, "/api/students/{studentId}/records")).toHaveLength(1),
    );
    const [, init] = callsTo(putMock, "/api/students/{studentId}/records")[0]!;
    // The untouched choice and the masked sensitive field (left blank) are not sent.
    expect(init.body).toEqual({ answers: [{ field_id: "field-allergies", value: "Peanuts" }] });
  });

  test("uploads a document through the record.document class, with its expiry date", async () => {
    renderPanel(await loadPanel());
    await screen.findByText("Red route");

    fireEvent.change(screen.getByLabelText("Expiry date for Birth certificate"), {
      target: { value: "2030-01-01" },
    });
    const file = new File(["%PDF-1.7"], "birth.pdf", { type: "application/pdf" });
    fireEvent.change(screen.getByLabelText("File for Birth certificate"), {
      target: { files: [file] },
    });

    await waitFor(() =>
      expect(callsTo(putMock, "/api/students/{studentId}/records/{fieldId}/document")).toHaveLength(
        1,
      ),
    );
    const [, upload] = callsTo(postMock, "/api/storage/uploads/request-upload")[0]!;
    expect(upload.body).toMatchObject({ content_class: "record.document", file_name: "birth.pdf" });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [, attach] = callsTo(putMock, "/api/students/{studentId}/records/{fieldId}/document")[0]!;
    expect(attach.params?.path).toEqual({ studentId: "student-1", fieldId: "field-birth" });
    expect(attach.body).toEqual({
      storage_key: "temp/school-1/object-1/birth.pdf",
      expires_on: "2030-01-01",
    });
    expect(await screen.findByText("Uploaded, not yet verified")).toBeTruthy();
  });

  test("a sensitive value is masked, and revealed only into the panel's own state", async () => {
    const { queryClient } = renderPanel(await loadPanel());
    expect(await screen.findByText("•••• 67-1")).toBeTruthy();
    expect(screen.queryByText(SECRET)).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "Reveal National ID" }));
    expect(await screen.findByText(SECRET)).toBeTruthy();
    expect(callsTo(postMock, "/api/students/{studentId}/records/{fieldId}/reveal")).toHaveLength(1);
    // Never cached: nothing in React Query holds the revealed value.
    expect(
      JSON.stringify(
        queryClient
          .getQueryCache()
          .getAll()
          .map((q) => q.state.data),
      ),
    ).not.toContain(SECRET);

    fireEvent.click(screen.getByRole("button", { name: "Hide National ID" }));
    expect(screen.queryByText(SECRET)).toBeNull();
    expect(screen.getByText("•••• 67-1")).toBeTruthy();
  });

  test("without studentRecord:readSensitive there is no Reveal; without update, no editing", async () => {
    renderPanel(await loadPanel(), { canRevealSensitive: false, canEdit: false });
    expect(await screen.findByText("•••• 67-1")).toBeTruthy();
    expect(screen.queryByRole("button", { name: /Reveal/ })).toBeNull();
    expect(screen.queryByRole("button", { name: "Edit record" })).toBeNull();
    expect(screen.queryByLabelText("File for Birth certificate")).toBeNull();
    expect(postMock).not.toHaveBeenCalled();
  });
});
