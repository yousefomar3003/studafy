import { ApiError } from "@studafy/api-client";
import { Button, Card, Input, Select, useToast } from "@studafy/ui";
import { useId, useRef, useState } from "react";
import { Link } from "react-router-dom";

import { categoryFieldLabel, EXPENSE_DOCUMENT_TYPE_LABELS, vendorFieldLabel } from "./labels";
import {
  useCreateExpense,
  useRequestExpenseUploadUrl,
  uploadFileToPresignedUrl,
} from "./mutations";

import "./expenses.css";

import type { CreateExpenseBody, Expense, ExpenseDocumentType } from "./queries";
import type { SelectOption } from "@studafy/ui";
import type { FormEvent } from "react";

function apiErrorMessage(error: unknown, fallback: string): string {
  if (!(error instanceof ApiError)) return fallback;
  return error.detail ?? error.title;
}

const DOCUMENT_TYPE_OPTIONS: SelectOption<ExpenseDocumentType | "">[] = [
  { value: "", label: "Select a document type" },
  ...(Object.entries(EXPENSE_DOCUMENT_TYPE_LABELS) as [ExpenseDocumentType, string][]).map(
    ([value, label]) => ({ value, label }),
  ),
];

const CURRENCY_PATTERN = /^[A-Z]{3}$/;

/**
 * Expense entry (`/portal/finance/expenses/new`), gated by `billing:update`. Single-step create —
 * unlike the refund/scholarship maker/checker pair, an expense has no separate confirmation step,
 * so this follows `payments/RecordPaymentPage`'s simpler direct-submit shape instead.
 *
 * The attachment (if any) goes through the pre-signed flow before the expense itself is created:
 * request an upload URL, PUT the bytes straight to S3, then create the expense with the returned
 * `storage_key` as `attachment_storage_key` — see `mutations.ts`'s doc comments on why that PUT
 * isn't routed through `api`. The created expense's own `attachment_url` comes back `null` either
 * way (the create response never resolves a pre-signed *download* URL — see `expenses/service.ts`'s
 * `projectToCache`), so the success panel points at the expense's detail page to view the receipt
 * rather than claiming one is attached right here.
 */
export default function NewExpensePage() {
  const [expense, setExpense] = useState<Expense | null>(null);

  return (
    <>
      <p className="expenses-form__back">
        <Link to="/portal/finance/expenses">&larr; Back to expenses</Link>
      </p>
      <h1>Record an expense</h1>

      {expense ? (
        <ExpenseCreated expense={expense} onReset={() => setExpense(null)} />
      ) : (
        <ExpenseForm onCreated={setExpense} />
      )}
    </>
  );
}

// ---------------------------------------------------------------------------
// Form
// ---------------------------------------------------------------------------

interface ExpenseFormProps {
  onCreated: (expense: Expense) => void;
}

function ExpenseForm({ onCreated }: ExpenseFormProps) {
  const { show } = useToast();
  const requestUploadUrl = useRequestExpenseUploadUrl();
  const createExpense = useCreateExpense();
  const descriptionId = useId();
  const attachmentId = useId();

  const [documentType, setDocumentType] = useState<ExpenseDocumentType | "">("");
  const [category, setCategory] = useState("");
  const [vendor, setVendor] = useState("");
  const [amountInput, setAmountInput] = useState("");
  const [currency, setCurrency] = useState("JOD");
  const [expenseDate, setExpenseDate] = useState("");
  const [description, setDescription] = useState("");
  const [file, setFile] = useState<File | null>(null);
  const [isSubmitting, setIsSubmitting] = useState(false);

  // Guards a double-click firing two submits before React re-renders the disabled button — same
  // reasoning `payments/RecordPaymentPage`'s own `submittingRef` documents.
  const submittingRef = useRef(false);

  const amountValue = Number(amountInput);
  const isValidAmount =
    amountInput.trim() !== "" && Number.isFinite(amountValue) && amountValue > 0;
  const isValidCurrency = CURRENCY_PATTERN.test(currency);

  const canSubmit =
    documentType !== "" &&
    category.trim() !== "" &&
    vendor.trim() !== "" &&
    isValidAmount &&
    isValidCurrency;

  async function handleSubmit(event: FormEvent) {
    event.preventDefault();
    // `canSubmit`'s own `documentType !== ""` check is what TypeScript's control-flow analysis
    // narrows `documentType` from below — see the `document_type: documentType` assignment past
    // the `try` block, which needs `ExpenseDocumentType` rather than `ExpenseDocumentType | ""`.
    if (!canSubmit || submittingRef.current) return;
    submittingRef.current = true;
    setIsSubmitting(true);

    try {
      let attachmentStorageKey: string | undefined;
      if (file) {
        const uploadUrl = await requestUploadUrl.mutateAsync({
          file_name: file.name,
          content_type: file.type || undefined,
        });
        await uploadFileToPresignedUrl(uploadUrl.upload_url, file);
        attachmentStorageKey = uploadUrl.storage_key;
      }

      const body: CreateExpenseBody = {
        document_type: documentType,
        category: category.trim(),
        vendor: vendor.trim(),
        amount: amountValue,
        currency,
        description: description.trim() || undefined,
        expense_date: expenseDate || undefined,
        attachment_storage_key: attachmentStorageKey,
      };

      const created = await createExpense.mutateAsync(body);
      onCreated(created);
    } catch (error) {
      submittingRef.current = false;
      setIsSubmitting(false);
      show({
        variant: "error",
        title: "Couldn't record the expense",
        description: apiErrorMessage(error, "Please check the form and try again."),
      });
    }
  }

  return (
    <Card as="section" aria-label="Expense form">
      <Card.Body>
        <form onSubmit={handleSubmit} className="expenses-form">
          {/* No `required` here: unlike `Input`'s asterisk (which only ever affects `getByLabelText`
              via the associated `<label>`'s raw textContent), `Select`'s combobox exposes its
              accessible name through `aria-labelledby`, and adding an asterisk there would leak
              into `getByRole("combobox", { name: … })` lookups — same reasoning
              `payments/RecordPaymentPage`'s `RadioGroup` doc comment gives for skipping it on a
              different control. `canSubmit` below still gates on `documentType !== ""`. */}
          <Select
            label="Document type"
            options={DOCUMENT_TYPE_OPTIONS}
            value={documentType}
            onChange={(value) => setDocumentType(value)}
          />

          <Input
            label={categoryFieldLabel(documentType)}
            type="text"
            value={category}
            onChange={(event) => setCategory(event.target.value)}
            maxLength={200}
            disabled={!documentType}
            helperText="Must match an existing ERPNext document — ERPNext validates it on submit."
            required
          />

          <Input
            label={vendorFieldLabel(documentType)}
            type="text"
            value={vendor}
            onChange={(event) => setVendor(event.target.value)}
            maxLength={200}
            disabled={!documentType}
            required
          />

          <Input
            label="Amount"
            type="text"
            inputMode="decimal"
            value={amountInput}
            onChange={(event) => setAmountInput(event.target.value)}
            suffix={currency}
            placeholder="0.00"
            required
          />

          <Input
            label="Currency"
            type="text"
            value={currency}
            onChange={(event) => setCurrency(event.target.value.toUpperCase().slice(0, 3))}
            maxLength={3}
            error={
              currency !== "" && !isValidCurrency ? "Use a 3-letter currency code." : undefined
            }
            required
          />

          <Input
            label="Expense date (optional)"
            type="date"
            value={expenseDate}
            onChange={(event) => setExpenseDate(event.target.value)}
            helperText="Defaults to today."
          />

          <div className="sf-field expenses-form__description">
            <label className="sf-field__label" htmlFor={descriptionId}>
              Description (optional)
            </label>
            <div className="sf-input">
              <textarea
                id={descriptionId}
                className="sf-input__control"
                rows={3}
                maxLength={1000}
                value={description}
                onChange={(event) => setDescription(event.target.value)}
              />
            </div>
          </div>

          <div className="sf-field">
            <label className="sf-field__label" htmlFor={attachmentId}>
              Receipt (optional)
            </label>
            <div className="sf-input">
              <input
                id={attachmentId}
                className="sf-input__control"
                type="file"
                accept="image/*,application/pdf"
                onChange={(event) => setFile(event.target.files?.[0] ?? null)}
              />
            </div>
            {file ? <p className="expenses-form__attachment-name">{file.name}</p> : null}
          </div>

          <div className="expenses-form__actions">
            <Button type="submit" loading={isSubmitting} disabled={!canSubmit}>
              Record expense
            </Button>
          </div>
        </form>
      </Card.Body>
    </Card>
  );
}

// ---------------------------------------------------------------------------
// Success
// ---------------------------------------------------------------------------

interface ExpenseCreatedProps {
  expense: Expense;
  onReset: () => void;
}

function ExpenseCreated({ expense, onReset }: ExpenseCreatedProps) {
  return (
    <Card as="section" aria-label="Expense recorded">
      <Card.Body>
        <p role="status" className="expenses-success__headline">
          Expense recorded &mdash; {expense.amount} {expense.currency}
        </p>

        <dl className="expenses-success__summary">
          <div>
            <dt>Type</dt>
            <dd>{EXPENSE_DOCUMENT_TYPE_LABELS[expense.document_type]}</dd>
          </div>
          <div>
            <dt>Category</dt>
            <dd>{expense.category}</dd>
          </div>
          <div>
            <dt>Vendor</dt>
            <dd>{expense.vendor}</dd>
          </div>
          <div>
            <dt>ERPNext document</dt>
            <dd>{expense.erpnext_name ?? "—"}</dd>
          </div>
        </dl>

        <p>
          <Link to={`/portal/finance/expenses/${expense.id}`}>View this expense</Link> to open its
          receipt, if one was attached.
        </p>

        <div className="expenses-success__actions">
          <Button type="button" variant="secondary" onClick={onReset}>
            Record another expense
          </Button>
          <Link to="/portal/finance/expenses">View expenses</Link>
        </div>
      </Card.Body>
    </Card>
  );
}
