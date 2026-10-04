import { Card } from "@studafy/ui";
import { useQuery } from "@tanstack/react-query";
import { Link, useParams } from "react-router-dom";

import { useTranslation } from "../../../lib/i18n";

import { EXPENSE_DOCUMENT_TYPE_LABEL_KEYS, expenseStatusLabel, expenseStatusTone } from "./labels";
import { expenseQueryKey, fetchExpense } from "./queries";

import "./expenses.css";

/**
 * Expense detail (`/portal/finance/expenses/:expenseId`), gated by `billing:read`. Exists mainly so
 * a receipt can actually be opened: `GET /api/finance/expenses/{expenseId}` resolves a pre-signed
 * download URL for the attachment (see `getExpense` in the API's `expenses/service.ts`), while the
 * list endpoint's own rows never do — see `queries.ts`'s `fetchExpensesPage` and
 * `NewExpensePage`'s doc comment on why the create response can't show one either.
 */
export default function ExpenseDetailPage() {
  const { t } = useTranslation();
  const { expenseId } = useParams<{ expenseId: string }>();
  const query = useQuery({
    queryKey: expenseQueryKey(expenseId ?? ""),
    queryFn: () => fetchExpense(expenseId as string),
    enabled: Boolean(expenseId),
  });

  const expense = query.data;

  return (
    <>
      <p className="expenses-detail__back">
        <Link to="/portal/finance/expenses">{t("finance.expenses.back")}</Link>
      </p>

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
              <p className="expenses-detail__no-attachment">
                {t("finance.expenses.detail.noReceipt")}
              </p>
            )}
          </Card.Body>
        </Card>
      )}
    </>
  );
}
