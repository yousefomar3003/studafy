import { Button, Input } from "@studafy/ui";
import { useQuery } from "@tanstack/react-query";
import { useEffect, useState } from "react";

import { useTranslation } from "../../../lib/i18n";
import { fetchInvoicesPage } from "../invoices/queries";

import { formatMinorAmount, invoicePaidAmountMinor } from "./queries";

import type { Invoice } from "../invoices/queries";

const SEARCH_DEBOUNCE_MS = 300;

export interface RefundInvoicePickerFieldProps {
  value: Invoice | null;
  onChange: (invoice: Invoice | null) => void;
}

/**
 * Search-as-you-type invoice lookup for the refund flow's maker step. Same search-then-pick shape
 * as `payments/InvoicePickerField`, reimplemented rather than imported (each feature folder owns its
 * own picker, same convention that field's own doc comment follows) — narrowed differently, though:
 * a refund needs an invoice with something *paid* on it, not one with a balance still *owed*, so this
 * filters on `invoicePaidAmountMinor(invoice) > 0` instead of `outstanding_amount_minor > 0`. Also a
 * lookup convenience only — ERPNext still owns rejecting a refund that exceeds the net paid amount
 * (see `initiateRefundBodySchema`'s doc comment in the API).
 */
export function RefundInvoicePickerField({ value, onChange }: RefundInvoicePickerFieldProps) {
  const { t } = useTranslation();
  const [searchInput, setSearchInput] = useState("");
  const [debouncedSearch, setDebouncedSearch] = useState("");

  useEffect(() => {
    const handle = setTimeout(() => setDebouncedSearch(searchInput), SEARCH_DEBOUNCE_MS);
    return () => clearTimeout(handle);
  }, [searchInput]);

  const resultsQuery = useQuery({
    queryKey: ["finance", "adjustments", "refundable-invoice-search", debouncedSearch],
    queryFn: () => fetchInvoicesPage({ status: "submitted", search: debouncedSearch }, undefined),
    enabled: debouncedSearch.trim().length > 0 && value === null,
  });

  const results = (resultsQuery.data?.items ?? []).filter(
    (invoice) => invoicePaidAmountMinor(invoice) > 0,
  );

  if (value) {
    const paidMinor = invoicePaidAmountMinor(value);
    return (
      <div className="adjustments-form__invoice-selected">
        <div>
          <span className="sf-field__label">{t("financeReports.adjustments.common.invoice")}</span>
          <p>
            {value.erpnext_docname} &mdash; {value.student_name} ({value.admission_number})
          </p>
          <p className="adjustments-form__invoice-paid">
            {t("financeReports.adjustments.invoicePicker.paidToDate", {
              amount: formatMinorAmount(paidMinor, value.currency_minor_unit),
              currency: value.currency,
            })}
          </p>
        </div>
        <Button type="button" variant="tertiary" onClick={() => onChange(null)}>
          {t("financeReports.adjustments.common.change")}
        </Button>
      </div>
    );
  }

  return (
    <div className="adjustments-form__invoice-picker">
      <Input
        label={t("financeReports.adjustments.common.invoice")}
        type="search"
        placeholder={t("financeReports.adjustments.invoicePicker.placeholder")}
        value={searchInput}
        onChange={(event) => setSearchInput(event.target.value)}
        helperText={t("financeReports.adjustments.invoicePicker.helper")}
        required
      />
      {debouncedSearch.trim() ? (
        <ul className="adjustments-form__invoice-results">
          {results.map((invoice) => {
            const paidMinor = invoicePaidAmountMinor(invoice);
            return (
              <li key={invoice.id}>
                <button
                  type="button"
                  className="adjustments-form__invoice-result"
                  onClick={() => {
                    onChange(invoice);
                    setSearchInput("");
                    setDebouncedSearch("");
                  }}
                >
                  <strong>{invoice.erpnext_docname}</strong>
                  <span>
                    {invoice.student_name} &middot; {invoice.admission_number} &middot;{" "}
                    {t("financeReports.adjustments.invoicePicker.paid", {
                      amount: formatMinorAmount(paidMinor, invoice.currency_minor_unit),
                      currency: invoice.currency,
                    })}
                  </span>
                </button>
              </li>
            );
          })}
          {!resultsQuery.isPending && results.length === 0 ? (
            <li className="adjustments-form__invoice-empty">
              {t("financeReports.adjustments.invoicePicker.noMatches")}
            </li>
          ) : null}
        </ul>
      ) : null}
    </div>
  );
}
