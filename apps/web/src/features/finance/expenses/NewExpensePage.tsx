import { ApiError } from "@studafy/api-client";
import { Button, Card, Input, Select, useToast } from "@studafy/ui";
import { useId, useRef, useState } from "react";
import { Link } from "react-router-dom";

import { Trans, useTranslation } from "../../../lib/i18n";

import { categoryFieldLabel, EXPENSE_DOCUMENT_TYPE_LABEL_KEYS, vendorFieldLabel } from "./labels";
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
  const { t } = useTranslation();
  const [expense, setExpense] = useState<Expense | null>(null);

  return (
    <>
      <p className="expenses-form__back">
        <Link to="/portal/finance/expenses">{t("finance.expenses.back")}</Link>
      </p>
      <h1>{t("finance.expenses.new.title")}</h1>

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
  const { t } = useTranslation();
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

  const documentTypeOptions: SelectOption<ExpenseDocumentType | "">[] = [
    { value: "", label: t("finance.expenses.new.selectType") },
    ...(Object.entries(EXPENSE_DOCUMENT_TYPE_LABEL_KEYS) as [ExpenseDocumentType, string][]).map(
      ([value, labelKey]) => ({ value, label: t(labelKey) }),
    ),
  ];

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
        title: t("finance.expenses.new.error"),
        description: apiErrorMessage(error, t("finance.common.checkFormAndRetry")),
      });
    }
  }

  return (
    <Card as="section" aria-label={t("finance.expenses.new.formLabel")}>
      <Card.Body>
        <form onSubmit={handleSubmit} className="expenses-form">
          {/* No `required` here: unlike `Input`'s asterisk (which only ever affects `getByLabelText`
              via the associated `<label>`'s raw textContent), `Select`'s combobox exposes its
              accessible name through `aria-labelledby`, and adding an asterisk there would leak
              into `getByRole("combobox", { name: … })` lookups — same reasoning
              `payments/RecordPaymentPage`'s `RadioGroup` doc comment gives for skipping it on a
              different control. `canSubmit` below still gates on `documentType !== ""`. */}
          <Select
            label={t("finance.expenses.new.documentType")}
            options={documentTypeOptions}
            value={documentType}
            onChange={(value) => setDocumentType(value)}
          />

          <Input
            label={categoryFieldLabel(documentType, t)}
            type="text"
            value={category}
            onChange={(event) => setCategory(event.target.value)}
            maxLength={200}
            disabled={!documentType}
            helperText={t("finance.expenses.new.categoryHelper")}
            required
          />

          <Input
            label={vendorFieldLabel(documentType, t)}
            type="text"
            value={vendor}
            onChange={(event) => setVendor(event.target.value)}
            maxLength={200}
            disabled={!documentType}
            required
          />

          <Input
            label={t("finance.common.amount")}
            type="text"
            inputMode="decimal"
            value={amountInput}
            onChange={(event) => setAmountInput(event.target.value)}
            suffix={currency}
            placeholder="0.00"
            required
          />

          <Input
            label={t("finance.common.currency")}
            type="text"
            value={currency}
            onChange={(event) => setCurrency(event.target.value.toUpperCase().slice(0, 3))}
            maxLength={3}
            error={
              currency !== "" && !isValidCurrency
                ? t("finance.expenses.new.currencyInvalid")
                : undefined
            }
            required
          />

          <Input
            label={t("finance.expenses.new.expenseDate")}
            type="date"
            value={expenseDate}
            onChange={(event) => setExpenseDate(event.target.value)}
            helperText={t("finance.common.defaultsToToday")}
          />

          <div className="sf-field expenses-form__description">
            <label className="sf-field__label" htmlFor={descriptionId}>
              {t("finance.common.description")}
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
              {t("finance.expenses.new.receipt")}
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
              {t("finance.common.recordExpense")}
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
  const { t } = useTranslation();
  return (
    <Card as="section" aria-label={t("finance.expenses.new.recordedLabel")}>
      <Card.Body>
        <p role="status" className="expenses-success__headline">
          {t("finance.expenses.new.recordedHeadline", {
            amount: expense.amount,
            currency: expense.currency,
          })}
        </p>

        <dl className="expenses-success__summary">
          <div>
            <dt>{t("finance.common.type")}</dt>
            <dd>{t(EXPENSE_DOCUMENT_TYPE_LABEL_KEYS[expense.document_type])}</dd>
          </div>
          <div>
            <dt>{t("finance.common.category")}</dt>
            <dd>{expense.category}</dd>
          </div>
          <div>
            <dt>{t("finance.common.vendor")}</dt>
            <dd>{expense.vendor}</dd>
          </div>
          <div>
            <dt>{t("finance.common.erpnextDocument")}</dt>
            <dd>{expense.erpnext_name ?? "—"}</dd>
          </div>
        </dl>

        <p>
          <Trans
            t={t}
            i18nKey="finance.expenses.new.viewThisPrompt"
            components={{ expenseLink: <Link to={`/portal/finance/expenses/${expense.id}`} /> }}
          />
        </p>

        <div className="expenses-success__actions">
          <Button type="button" variant="secondary" onClick={onReset}>
            {t("finance.expenses.new.recordAnother")}
          </Button>
          <Link to="/portal/finance/expenses">{t("finance.expenses.new.viewAll")}</Link>
        </div>
      </Card.Body>
    </Card>
  );
}
