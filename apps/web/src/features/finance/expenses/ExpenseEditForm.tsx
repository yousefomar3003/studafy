import { ApiError } from "@studafy/api-client";
import { Button, Input, useToast } from "@studafy/ui";
import { useId, useState } from "react";

import { useTranslation } from "../../../lib/i18n";

import { useUpdateExpense } from "./mutations";

import type { Expense } from "./queries";
import type { FormEvent } from "react";

export interface ExpenseEditFormProps {
  expense: Expense;
  onSaved: (expense: Expense) => void;
  onCancel: () => void;
}

/** Corrects a draft expense's category, vendor, amount, date or description (sent to ERPNext). */
export function ExpenseEditForm({ expense, onSaved, onCancel }: ExpenseEditFormProps) {
  const { t } = useTranslation();
  const { show } = useToast();
  const update = useUpdateExpense(expense.id);
  const descriptionId = useId();
  const [category, setCategory] = useState(expense.category);
  const [vendor, setVendor] = useState(expense.vendor);
  const [amount, setAmount] = useState(expense.amount);
  const [expenseDate, setExpenseDate] = useState(expense.expense_date);
  const [description, setDescription] = useState(expense.description ?? "");

  const amountValue = Number(amount);
  const valid =
    category.trim() !== "" &&
    vendor.trim() !== "" &&
    Number.isFinite(amountValue) &&
    amountValue > 0 &&
    expenseDate !== "";

  function handleSubmit(event: FormEvent) {
    event.preventDefault();
    if (!valid) return;
    update.mutate(
      {
        category: category.trim(),
        vendor: vendor.trim(),
        amount: amountValue,
        currency: expense.currency,
        expense_date: expenseDate,
        description: description.trim() || undefined,
      },
      {
        onSuccess: (saved) => {
          show({ variant: "success", title: t("finance.expenses.edit.savedToast") });
          onSaved(saved);
        },
        onError: (error) =>
          show({
            variant: "error",
            title: t("finance.expenses.edit.error"),
            description: error instanceof ApiError ? (error.detail ?? error.title) : undefined,
          }),
      },
    );
  }

  return (
    <form
      className="expenses-form"
      onSubmit={handleSubmit}
      aria-label={t("finance.expenses.edit.label")}
    >
      <Input
        label={t("finance.common.category")}
        value={category}
        onChange={(event) => setCategory(event.target.value)}
        required
      />
      <Input
        label={t("finance.common.vendor")}
        value={vendor}
        onChange={(event) => setVendor(event.target.value)}
        required
      />
      <Input
        label={t("finance.common.amount")}
        inputMode="decimal"
        value={amount}
        suffix={expense.currency}
        onChange={(event) => setAmount(event.target.value)}
        required
      />
      <Input
        type="date"
        label={t("finance.common.date")}
        value={expenseDate}
        onChange={(event) => setExpenseDate(event.target.value)}
        required
      />
      <div className="sf-field">
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
      <div className="expenses-form__actions">
        <Button type="button" variant="tertiary" onClick={onCancel}>
          {t("finance.common.cancel")}
        </Button>
        <Button type="submit" loading={update.isPending} disabled={!valid}>
          {t("finance.expenses.edit.save")}
        </Button>
      </div>
    </form>
  );
}
