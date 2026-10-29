import { ToastProvider } from "@studafy/ui";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
// eslint-disable-next-line import-x/no-unresolved -- "bun:test" is a virtual Bun built-in with no resolvable file path
import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { MemoryRouter } from "react-router-dom";

import { AuthProvider } from "../../../lib/auth";
import { createTestSessionStore } from "../../../lib/test/session";

import type { ComponentType } from "react";

interface RequestInit {
  params?: { path?: Record<string, string>; query?: Record<string, unknown> };
  body?: Record<string, unknown>;
}

type Field = Record<string, unknown> & { id: string; archived: boolean; published: boolean };

/** One in-memory template per subject, mutated by the POST/PATCH mocks like the API's draft. */
let templates: Record<string, { published_version: number; fields: Field[]; changed: boolean }>;

function templateResponse(kind: string) {
  const template = templates[kind]!;
  return {
    subject_kind: kind,
    published_version: template.published_version,
    published_at: template.published_version > 0 ? "2026-10-01T00:00:00.000Z" : null,
    has_unpublished_changes: template.changed,
    fields: template.fields,
  };
}

function newField(body: Record<string, unknown>, index: number): Field {
  return {
    id: `field-${index}`,
    field_type: body.field_type,
    label_en: body.label_en,
    label_ar: body.label_ar,
    help_en: body.help_en ?? null,
    help_ar: body.help_ar ?? null,
    required: body.required ?? false,
    options: body.options ?? [],
    sort_order: index,
    visibility: body.visibility ?? "staff_only",
    sensitivity: body.sensitivity ?? "standard",
    has_expiry: body.has_expiry ?? false,
    retention_months: body.retention_months ?? null,
    effective_retention_months: body.sensitivity === "sensitive" ? 12 : null,
    archived: false,
    published: false,
    label_suggests_sensitive: false,
    created_at: "2026-10-01T00:00:00.000Z",
    updated_at: "2026-10-01T00:00:00.000Z",
  };
}

const getMock = mock((path: string, init?: RequestInit) => {
  if (path === "/api/record-templates/{subjectKind}") {
    return Promise.resolve<unknown>({ data: templateResponse(init!.params!.path!.subjectKind!) });
  }
  return Promise.resolve<unknown>({ data: {} });
});

const postMock = mock((path: string, init?: RequestInit) => {
  const kind = init?.params?.path?.subjectKind ?? "student";
  const template = templates[kind]!;
  if (path === "/api/record-templates/{subjectKind}/fields") {
    const field = newField(init!.body!, template.fields.length);
    template.fields.push(field);
    template.changed = true;
    return Promise.resolve<unknown>({ data: field });
  }
  if (path === "/api/record-templates/{subjectKind}/publish") {
    template.published_version += 1;
    template.changed = false;
    for (const field of template.fields) field.published = true;
    return Promise.resolve<unknown>({
      data: {
        subject_kind: kind,
        version: template.published_version,
        published_at: "2026-10-28T00:00:00.000Z",
        field_count: template.fields.length,
      },
    });
  }
  return Promise.resolve<unknown>({ data: {} });
});

const patchMock = mock((_path: string, init?: RequestInit) => {
  const template = templates[init!.params!.path!.subjectKind!]!;
  const field = template.fields.find((candidate) => candidate.id === init!.params!.path!.fieldId)!;
  Object.assign(field, init!.body);
  template.changed = true;
  return Promise.resolve<unknown>({ data: field });
});

const putMock = mock((_path: string, init?: RequestInit) => {
  const kind = init!.params!.path!.subjectKind!;
  const order = init!.body!.field_ids as string[];
  const template = templates[kind]!;
  template.fields.sort((a, b) => order.indexOf(a.id) - order.indexOf(b.id));
  template.changed = true;
  return Promise.resolve<unknown>({ data: templateResponse(kind) });
});

mock.module("../../../lib/api", () => ({
  api: { GET: getMock, POST: postMock, PATCH: patchMock, PUT: putMock },
}));

const loadPage = async () =>
  (await import("./RecordTemplatesPage")).default as ComponentType<{
    portal?: "admin" | "principal";
  }>;

async function renderAs(roles: string[], portal: "admin" | "principal") {
  const Page = await loadPage();
  const store = await createTestSessionStore(roles);
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <AuthProvider store={store}>
      <QueryClientProvider client={queryClient}>
        <ToastProvider>
          <MemoryRouter>
            <Page portal={portal} />
          </MemoryRouter>
        </ToastProvider>
      </QueryClientProvider>
    </AuthProvider>,
  );
}

async function addField(labelEn: string, labelAr: string) {
  fireEvent.click(await screen.findByRole("button", { name: "Add field" }));
  const dialog = await screen.findByRole("dialog", { name: "Add a field" });
  fireEvent.change(within(dialog).getByRole("textbox", { name: "Label (English)" }), {
    target: { value: labelEn },
  });
  fireEvent.change(within(dialog).getByRole("textbox", { name: "Label (Arabic)" }), {
    target: { value: labelAr },
  });
  return dialog;
}

beforeEach(() => {
  templates = {
    student: { published_version: 0, fields: [], changed: false },
    parent: { published_version: 0, fields: [], changed: false },
  };
});

afterEach(() => {
  cleanup();
  for (const m of [getMock, postMock, patchMock, putMock]) m.mockClear();
});

describe("RecordTemplatesPage", () => {
  for (const [portal, role, back] of [
    ["admin", "ORG_ADMIN", "/portal/admin/settings"],
    ["principal", "PRINCIPAL", "/portal/principal"],
  ] as const) {
    test(`${role} builds and publishes a template from the ${portal} portal`, async () => {
      await renderAs([role], portal);
      expect((await screen.findByText(/Not published yet/)).textContent).toContain(
        "Not published yet",
      );
      expect(screen.getByRole("link", { name: /Back to/ }).getAttribute("href")).toBe(back);

      const dialog = await addField("Bus stop", "موقف الحافلة");
      fireEvent.click(within(dialog).getByRole("checkbox", { name: "Required" }));
      fireEvent.click(within(dialog).getByRole("button", { name: "Add field" }));

      await waitFor(() => expect(postMock).toHaveBeenCalledTimes(1));
      const [path, init] = postMock.mock.calls[0] as [string, RequestInit];
      expect(path).toBe("/api/record-templates/{subjectKind}/fields");
      expect(init.params?.path).toEqual({ subjectKind: "student" });
      expect(init.body).toMatchObject({
        field_type: "short_text",
        label_en: "Bus stop",
        label_ar: "موقف الحافلة",
        required: true,
        sensitivity: "standard",
        options: [],
      });

      expect(await screen.findByText("Unpublished changes")).toBeTruthy();
      const list = screen.getByRole("region", { name: "1 field on the form" });
      expect(within(list).getByText("Bus stop")).toBeTruthy();

      fireEvent.click(screen.getByRole("button", { name: "Publish" }));
      await waitFor(() =>
        expect(postMock).toHaveBeenCalledWith("/api/record-templates/{subjectKind}/publish", {
          params: { path: { subjectKind: "student" } },
        }),
      );
      expect(await screen.findByText("Version 1 published")).toBeTruthy();
      await waitFor(() => expect(screen.queryByText("Unpublished changes")).toBeNull());
    });
  }

  test("a choice field needs its choices, sent with both labels", async () => {
    await renderAs(["ORG_ADMIN"], "admin");
    const dialog = await addField("Bus route", "خط الحافلة");
    fireEvent.click(within(dialog).getByRole("combobox", { name: "Type" }));
    fireEvent.click(await screen.findByRole("option", { name: "One choice" }));
    fireEvent.click(within(dialog).getByRole("button", { name: "Add field" }));
    expect(await within(dialog).findByText("Add at least one choice")).toBeTruthy();
    expect(postMock).not.toHaveBeenCalled();

    fireEvent.click(within(dialog).getByRole("button", { name: "Add a choice" }));
    fireEvent.change(within(dialog).getByRole("textbox", { name: "Choice 1 value" }), {
      target: { value: "red" },
    });
    fireEvent.change(within(dialog).getByRole("textbox", { name: "Choice 1 label (English)" }), {
      target: { value: "Red" },
    });
    fireEvent.change(within(dialog).getByRole("textbox", { name: "Choice 1 label (Arabic)" }), {
      target: { value: "أحمر" },
    });
    fireEvent.click(within(dialog).getByRole("button", { name: "Add field" }));
    await waitFor(() => expect(postMock).toHaveBeenCalledTimes(1));
    expect((postMock.mock.calls[0] as [string, RequestInit])[1].body).toMatchObject({
      field_type: "single_choice",
      options: [{ value: "red", label_en: "Red", label_ar: "أحمر" }],
    });
  });

  test("an ID-like label suggests sensitive handling and explains what it means", async () => {
    await renderAs(["ORG_ADMIN"], "admin");
    const dialog = await addField("Passport number", "رقم جواز السفر");

    const hint = await within(dialog).findByText(/looks like an ID number/);
    expect(hint).toBeTruthy();
    expect(within(dialog).getByText(/shown masked everywhere/)).toBeTruthy();
    expect(within(dialog).getByText(/separate permission/)).toBeTruthy();
    expect(within(dialog).getByText(/Every reveal and every download is logged/)).toBeTruthy();

    fireEvent.click(within(dialog).getByRole("button", { name: "Mark as sensitive" }));
    expect(
      (within(dialog).getByRole("checkbox", { name: "Sensitive" }) as HTMLInputElement).checked,
    ).toBe(true);
    fireEvent.change(within(dialog).getByRole("spinbutton", { name: "Delete after (months)" }), {
      target: { value: "6" },
    });
    fireEvent.click(within(dialog).getByRole("button", { name: "Add field" }));
    await waitFor(() => expect(postMock).toHaveBeenCalledTimes(1));
    expect((postMock.mock.calls[0] as [string, RequestInit])[1].body).toMatchObject({
      sensitivity: "sensitive",
      retention_months: 6,
    });
  });

  test("a published field's type is locked, and a sensitive one stays sensitive", async () => {
    templates.student!.fields = [
      {
        ...newField(
          {
            field_type: "short_text",
            label_en: "Civil ID",
            label_ar: "الرقم المدني",
            sensitivity: "sensitive",
          },
          0,
        ),
        published: true,
      },
    ];
    templates.student!.published_version = 1;
    await renderAs(["ORG_ADMIN"], "admin");
    fireEvent.click(await screen.findByRole("button", { name: "Edit Civil ID" }));
    const dialog = await screen.findByRole("dialog", { name: "Edit field" });
    expect(within(dialog).getByText(/its type is locked/)).toBeTruthy();
    expect(
      (within(dialog).getByRole("checkbox", { name: "Sensitive" }) as HTMLInputElement).disabled,
    ).toBe(true);
    expect(
      within(dialog).getByText("This field was published as sensitive, so it stays sensitive."),
    ).toBeTruthy();
  });

  test("reorders, archives and restores fields as draft changes", async () => {
    templates.student!.fields = [
      newField({ field_type: "short_text", label_en: "First", label_ar: "الأول" }, 0),
      newField({ field_type: "short_text", label_en: "Second", label_ar: "الثاني" }, 1),
    ];
    await renderAs(["ORG_ADMIN"], "admin");

    fireEvent.click(await screen.findByRole("button", { name: "Move Second up" }));
    await waitFor(() =>
      expect(putMock).toHaveBeenCalledWith("/api/record-templates/{subjectKind}/field-order", {
        params: { path: { subjectKind: "student" } },
        body: { field_ids: ["field-1", "field-0"] },
      }),
    );

    fireEvent.click(screen.getByRole("button", { name: "Archive First" }));
    await waitFor(() =>
      expect(patchMock).toHaveBeenCalledWith(
        "/api/record-templates/{subjectKind}/fields/{fieldId}",
        {
          params: { path: { subjectKind: "student", fieldId: "field-0" } },
          body: { archived: true },
        },
      ),
    );
    expect(await screen.findByText("1 archived field")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Restore First" }));
    await waitFor(() => expect(patchMock).toHaveBeenCalledTimes(2));
    expect((patchMock.mock.calls[1] as [string, RequestInit])[1].body).toEqual({ archived: false });
  });

  test("previews the form in English and in Arabic", async () => {
    templates.student!.fields = [
      newField({ field_type: "short_text", label_en: "Bus stop", label_ar: "موقف الحافلة" }, 0),
    ];
    await renderAs(["ORG_ADMIN"], "admin");
    expect(await screen.findByLabelText("Bus stop")).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "العربية" }));
    const label = await screen.findByLabelText("موقف الحافلة");
    expect(label.closest("[dir]")?.getAttribute("dir")).toBe("rtl");
    // The app language did not change: the editor chrome is still English.
    expect(screen.getByRole("button", { name: "Publish" })).toBeTruthy();
  });

  test("the parent template is edited on its own tab", async () => {
    await renderAs(["PRINCIPAL"], "principal");
    fireEvent.click(await screen.findByRole("tab", { name: "Parent record" }));
    const dialog = await addField("Work phone", "هاتف العمل");
    fireEvent.click(within(dialog).getByRole("button", { name: "Add field" }));
    await waitFor(() => expect(postMock).toHaveBeenCalledTimes(1));
    expect((postMock.mock.calls[0] as [string, RequestInit])[1].params?.path).toEqual({
      subjectKind: "parent",
    });
  });

  test("a caller without recordTemplate:manage sees the draft read-only", async () => {
    templates.student!.fields = [
      newField({ field_type: "short_text", label_en: "Bus stop", label_ar: "موقف الحافلة" }, 0),
    ];
    await renderAs(["FINANCE"], "admin");
    const list = await screen.findByRole("region", { name: "1 field on the form" });
    expect(within(list).getByText("Bus stop")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Add field" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Publish" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Edit Bus stop" })).toBeNull();
  });
});
