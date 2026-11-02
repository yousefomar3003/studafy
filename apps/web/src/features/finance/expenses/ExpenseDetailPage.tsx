import { ApiError } from "@studafy/api-client";
import { PERMISSIONS } from "@studafy/constants";
import { Button, Card, useToast } from "@studafy/ui";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useId, useState } from "react";
import { useParams } from "react-router-dom";

import { usePermissions } from "../../../lib/auth";
import { useTranslation } from "../../../lib/i18n";

import { ExpenseEditForm } from "./ExpenseEditForm";
import { EXPENSE_DOCUMENT_TYPE_LABEL_KEYS, expenseStatusLabel, expenseStatusTone } from "./labels";
import {
  uploadFileToPresignedUrl,
  useConfirmExpenseAttachment,
  useRequestExpenseUploadUrl,
} from "./mutations";
import { expenseQueryKey, fetchExpense } from "./queries";

import "./expenses.css";

/**
 * Expense detail (`/portal/finance/expenses/:expenseId`), gated by `billing:read`. Exists mainly so
 * a receipt can actually be opened: `GET /api/finance/expenses/{expenseId}` resolves a pre-signed
 * download URL for the attachment (see `getExpense` in the API's `expenses/service.ts`), while the
 * list endpoint's own rows never do — see `queries.ts`'s `fetchExpensesPage` and
 * `NewExpensePage`'s doc comment on why the create response can't show one either.
 *
 * With `billing:update`: a draft can be corrected (ERPNext refuses edits to a submitted document,
 * so the page does not offer them), and a receipt can be attached to one that has none.
 */
export default function ExpenseDetailPage() {
  const { t } = useTranslation();
  const { expenseId } = useParams<{ expenseId: string }>();
  const { show } = useToast();
  const canUpdate = usePermissions().has(PERMISSIONS.BILLING_UPDATE);
  const queryClient = useQueryClient();
  const [editing, setEditing] = useState(false);
  const [uploading, setUploading] = useState(false);
  const fileInputId = useId();
  const requestUploadUrl = useRequestExpenseUploadUrl();
  const confirmAttachment = useConfirmExpenseAttachment(expenseId ?? "");
  const query = useQuery({
    queryKey: expenseQueryKey(expenseId ?? ""),
    queryFn: () => fetchExpense(expenseId as string),
    enabled: Boolean(expenseId),
  });

  const expense = query.data;

  function refresh() {
    void queryClient.invalidateQueries({ queryKey: expenseQueryKey(expenseId ?? "") });
    void queryClient.invalidateQueries({ queryKey: ["finance", "expenses"] });
  }

  async function attach(file: File) {
    setUploading(true);
    try {
      const upload = await requestUploadUrl.mutateAsync({
        file_name: file.name,
        content_type: file.type || undefined,
      });
      await uploadFileToPresignedUrl(upload.upload_url, file);
      await confirmAttachment.mutateAsync(upload.storage_key);
      show({ variant: "success", title: t("finance.expenses.detail.attachedToast") });
      refresh();
    } catch (error) {
      show({
        variant: "error",
        title: t("finance.expenses.detail.attachError"),
        description: error instanceof ApiError ? (error.detail ?? error.title) : undefined,
      });
    } finally {
      setUploading(false);
    }
  }

  return (
    <>
      {query.isPending ? (
        <p>{t("finance.common.loading")}</p>
      ) : query.isError || !expense ? (
        <p role="alert">{t("finance.expenses.detail.loadError")}</p>
      ) : (
        <Card as="section" aria-label={t("finance.expenses.detail.label")}>
          <Card.Body>
            <div className="expenses-detail__header">
              <div>
                <h1>{expense.category}</h1>
                <p>{t(EXPENSE_DOCUMENT_TYPE_LABEL_KEYS[expense.document_type])}</p>
              </div>
              <span
                className="expenses-status-pill"
                data-tone={expenseStatusTone(expense.erpnext_status)}
              >
                {expenseStatusLabel(expense.erpnext_status, t)}
              </span>
            </div>

            <dl className="expenses-detail__summary">
              <div>
                <dt>{t("finance.common.vendor")}</dt>
                <dd>{expense.vendor}</dd>
              </div>
              <div>
                <dt>{t("finance.common.amount")}</dt>
                <dd>
                  {expense.amount} {expense.currency}
                </dd>
              </div>
              <div>
                <dt>{t("finance.common.date")}</dt>
                <dd>{expense.expense_date}</dd>
              </div>
              <div>
                <dt>{t("finance.common.erpnextDocument")}</dt>
                <dd>{expense.erpnext_name ?? "—"}</dd>
              </div>
            </dl>

            {expense.description ? <p>{expense.description}</p> : null}

            {canUpdate && expense.erpnext_status === "draft" ? (
              editing ? (
                <ExpenseEditForm
                  expense={expense}
                  onSaved={() => {
                    setEditing(false);
                    refresh();
                  }}
                  onCancel={() => setEditing(false)}
                />
              ) : (
                <Button type="button" variant="secondary" onClick={() => setEditing(true)}>
                  {t("finance.expenses.detail.edit")}
                </Button>
              )
            ) : null}

            {expense.attachment_url ? (
              <a
                className="sf-button sf-button--secondary"
                href={expense.attachment_url}
                target="_blank"
                rel="noopener noreferrer"
              >
                {t("finance.expenses.detail.viewReceipt")}
              </a>
            ) : (
              <>
                <p className="expenses-detail__no-attachment">
                  {t("finance.expenses.detail.noReceipt")}
                </p>
                {canUpdate && expense.erpnext_status !== "cancelled" ? (
                  <div className="sf-field">
                    <label className="sf-field__label" htmlFor={fileInputId}>
                      {t("finance.expenses.detail.attachReceipt")}
                    </label>
                    <div className="sf-input">
                      <input
                        id={fileInputId}
                        className="sf-input__control"
                        type="file"
                        accept="image/*,application/pdf"
                        disabled={uploading}
                        onChange={(event) => {
                          const file = event.target.files?.[0];
                          if (file) void attach(file);
                        }}
                      />
                    </div>
                    {uploading ? (
                      <p role="status">{t("finance.expenses.detail.uploading")}</p>
                    ) : null}
                  </div>
                ) : null}
              </>
            )}
          </Card.Body>
        </Card>
      )}
    </>
  );
}
