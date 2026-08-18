import { ApiError } from "@studafy/api-client";
import { Button, Input, Select, useToast } from "@studafy/ui";
import { useEffect, useState } from "react";

import { FeeComponentsEditor } from "./FeeComponentsEditor";
import { InvoicePreviewPanel } from "./InvoicePreviewPanel";
import { feeStructureStatusLabel, feeStructureStatusTone } from "./labels";
import { useCreateFeeStructure, useUpdateFeeStructure } from "./mutations";

import type { FeeComponentDraft } from "./preview";
import type { AcademicYear, FeeStructure } from "./queries";
import type { SelectOption } from "@studafy/ui";
import type { FormEvent } from "react";

const CURRENCY_PATTERN = /^[A-Z]{3}$/;

interface FieldErrors {
  title?: string;
  currency?: string;
  /** Set when there are zero rows and at least one is required — there is no row to attach a
   * per-row error to, so this renders as its own message instead. */
  componentsGeneral?: string;
  components?: Record<number, { fee_category?: string; amount?: string }>;
}

function emptyComponent(): FeeComponentDraft {
  return { fee_category: "", amount: 0, description: "" };
}

function validate(
  title: string,
  currency: string,
  components: FeeComponentDraft[],
  requireComponents: boolean,
): FieldErrors {
  const errors: FieldErrors = {};

  if (title.trim() === "") errors.title = "Title is required";
  if (!CURRENCY_PATTERN.test(currency)) errors.currency = "Use a 3-letter ISO code, e.g. JOD";

  if (components.length === 0) {
    if (requireComponents) errors.componentsGeneral = "Add at least one fee component";
    return errors;
  }

  const rowErrors: Record<number, { fee_category?: string; amount?: string }> = {};
  components.forEach((component, index) => {
    const row: { fee_category?: string; amount?: string } = {};
    if (component.fee_category.trim() === "") row.fee_category = "Required";
    if (!Number.isFinite(component.amount) || component.amount < 0) {
      row.amount = "Enter a non-negative amount";
    }
    // `index` comes from iterating `components` itself, never external input — the same
    // bounded-key shape `finance/queries.ts` documents for this rule.
    // eslint-disable-next-line security/detect-object-injection
    if (Object.keys(row).length > 0) rowErrors[index] = row;
  });
  if (Object.keys(rowErrors).length > 0) errors.components = rowErrors;

  return errors;
}

export interface FeeStructureFormProps {
  academicYears: AcademicYear[];
  /** `null` — building a new structure. Otherwise the structure selected from the list. */
  editing: FeeStructure | null;
  onSaved: () => void;
}

/**
 * The builder itself: metadata, item composition, and the invoice preview for a sample student.
 *
 * Editing an existing structure is metadata-only by default. `GET /api/finance/fee-structures`
 * doesn't return a structure's components — only its computed totals (see `feeStructureSchema`) — so
 * there is nothing to pre-fill the composition editor with. Leaving it empty and omitting
 * `components` from the PATCH keeps the existing components untouched; adding rows here replaces the
 * full set, same as ERPNext's own PUT semantics.
 */
export function FeeStructureForm({ academicYears, editing, onSaved }: FeeStructureFormProps) {
  const { show } = useToast();
  const createFeeStructure = useCreateFeeStructure();
  const updateFeeStructure = useUpdateFeeStructure();

  const [title, setTitle] = useState("");
  const [academicYearId, setAcademicYearId] = useState("");
  const [program, setProgram] = useState("");
  const [currency, setCurrency] = useState("JOD");
  const [components, setComponents] = useState<FeeComponentDraft[]>([emptyComponent()]);
  const [errors, setErrors] = useState<FieldErrors>({});
  const [serverError, setServerError] = useState<string | undefined>(undefined);

  const isReadOnly = editing !== null && editing.erpnext_status !== "draft";

  useEffect(() => {
    setErrors({});
    setServerError(undefined);
    if (editing) {
      setTitle(editing.title);
      setAcademicYearId(editing.academic_year_id ?? "");
      setProgram(editing.program ?? "");
      setCurrency(editing.currency);
      setComponents([]);
    } else {
      setTitle("");
      setAcademicYearId("");
      setProgram("");
      setCurrency("JOD");
      setComponents([emptyComponent()]);
    }
  }, [editing]);

  const yearOptions: SelectOption<string>[] = [
    { value: "", label: "No academic year" },
    ...academicYears.map((year) => ({
      value: year.id,
      label: `${year.name} (${year.starts_on} – ${year.ends_on})`,
    })),
  ];
  const selectedYear = academicYears.find((year) => year.id === academicYearId);

  const isPending = createFeeStructure.isPending || updateFeeStructure.isPending;

  function handleSubmit(event: FormEvent) {
    event.preventDefault();
    setServerError(undefined);

    // Validated against `components` as the admin actually left it — rows are not silently dropped
    // for being blank, since that would shift indices out from under `errors.components` and
    // misattribute a row's error to whichever row happened to slide into its old position. An
    // unwanted row is removed with its own "Remove" button, not by leaving it empty.
    const validation = validate(title, currency, components, editing === null);
    setErrors(validation);
    if (Object.keys(validation).length > 0) return;

    const trimmedComponents = components.map((component) => ({
      fee_category: component.fee_category.trim(),
      amount: component.amount,
      description: component.description?.trim() || undefined,
    }));

    const onError = (err: unknown) => {
      const detail = err instanceof ApiError ? (err.detail ?? err.title) : undefined;
      setServerError(detail ?? "Something went wrong. Try again.");
      show({ variant: "error", title: "Couldn't save fee structure", description: detail });
    };

    if (editing) {
      updateFeeStructure.mutate(
        {
          feeStructureId: editing.erpnext_name,
          body: {
            title: title.trim(),
            academic_year_id: academicYearId || undefined,
            program: program.trim() || undefined,
            currency,
            ...(trimmedComponents.length > 0 ? { components: trimmedComponents } : {}),
          },
        },
        {
          onSuccess: () => {
            show({ variant: "success", title: `Updated "${title.trim()}"` });
            onSaved();
          },
          onError,
        },
      );
      return;
    }

    createFeeStructure.mutate(
      {
        title: title.trim(),
        academic_year_id: academicYearId || undefined,
        program: program.trim() || undefined,
        currency,
        components: trimmedComponents,
      },
      {
        onSuccess: (structure) => {
          show({ variant: "success", title: `Created "${structure.title}"` });
          onSaved();
        },
        onError,
      },
    );
  }

  return (
    <div className="fee-builder__form-panel">
      <div className="fee-builder__form-header">
        <h2>{editing ? "Edit fee structure" : "New fee structure"}</h2>
        {editing ? (
          <span
            className="fee-builder__status-pill"
            data-tone={feeStructureStatusTone(editing.erpnext_status)}
          >
            {feeStructureStatusLabel(editing.erpnext_status)}
          </span>
        ) : null}
      </div>

      {isReadOnly ? (
        <p className="fee-builder__readonly-note">
          This structure is {feeStructureStatusLabel(editing!.erpnext_status).toLowerCase()} and
          immutable in ERPNext — create a new fee structure instead of editing this one.
        </p>
      ) : null}

      <form
        onSubmit={handleSubmit}
        noValidate
        aria-label={editing ? "Edit fee structure" : "New fee structure"}
      >
        <Input
          label="Title"
          value={title}
          onChange={(event) => setTitle(event.target.value)}
          error={errors.title}
          disabled={isReadOnly}
          required
          placeholder="Grade 5 — 2025/2026"
        />

        <Select
          label="Academic year"
          options={yearOptions}
          value={academicYearId}
          onChange={setAcademicYearId}
          disabled={isReadOnly}
          helperText={
            selectedYear
              ? `Effective ${selectedYear.starts_on} through ${selectedYear.ends_on}.`
              : "Fee structures don't carry their own effective dates — the academic year they " +
                "belong to is what dates them."
          }
        />

        <Input
          label="Program (ERPNext, grade/year grouping)"
          value={program}
          onChange={(event) => setProgram(event.target.value)}
          disabled={isReadOnly}
          placeholder="Grade 5"
          helperText="The ERPNext Program document name this structure applies to."
        />

        <Input
          label="Currency"
          value={currency}
          onChange={(event) => setCurrency(event.target.value.toUpperCase())}
          error={errors.currency}
          disabled={isReadOnly}
          required
          maxLength={3}
          placeholder="JOD"
        />

        {isReadOnly ? null : editing && components.length === 0 ? (
          <div className="fee-builder__components-note">
            <p>
              Component breakdown isn't returned by the list API, so it starts empty here. Leave it
              empty to keep the existing components unchanged, or add the full replacement set below
              — saving replaces all components at once, it doesn't merge.
            </p>
            <Button
              type="button"
              variant="tertiary"
              disabled={isReadOnly}
              onClick={() => setComponents([emptyComponent()])}
            >
              Change components
            </Button>
          </div>
        ) : (
          <>
            {errors.componentsGeneral ? (
              <p className="fee-builder__server-error" role="alert">
                {errors.componentsGeneral}
              </p>
            ) : null}
            <FeeComponentsEditor
              components={components}
              onChange={setComponents}
              errors={errors.components}
              disabled={isReadOnly}
              currency={currency}
            />
          </>
        )}

        {serverError ? (
          <p className="fee-builder__server-error" role="alert">
            {serverError}
          </p>
        ) : null}

        {!isReadOnly ? (
          <div className="fee-builder__form-actions">
            <Button type="submit" loading={isPending}>
              {editing ? "Save changes" : "Create fee structure"}
            </Button>
          </div>
        ) : null}
      </form>

      <InvoicePreviewPanel components={components} currency={currency} />
    </div>
  );
}
