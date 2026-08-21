import { Button, Input } from "@studafy/ui";
import { useQuery } from "@tanstack/react-query";
import { useEffect, useState } from "react";

import { fetchInvoicesPage } from "../invoices/queries";

import type { Invoice } from "../invoices/queries";

const SEARCH_DEBOUNCE_MS = 300;

export interface InvoicePickerFieldProps {
  value: Invoice | null;
  onChange: (invoice: Invoice | null) => void;
}

/**
 * Search-as-you-type invoice lookup for the payment recording flow's first step. Same shape as
 * `fees/StudentPickerField`'s student picker — there is no combobox primitive in `@studafy/ui`, so
 * search-then-pick-a-result is the established pattern for resolving a name or number into a
 * document, not a new one invented for this screen.
 *
 * Narrowed to `submitted` invoices with a balance still owed: a draft isn't a postable Sales
 * Invoice yet, a cancelled one never was, and a fully paid one has nothing left to record. This is
 * a lookup convenience, not a financial rule — ERPNext still owns rejecting an actual overpayment
 * (see `createPaymentBodySchema`'s doc comment in the API), so it only shortens the list a payer
 * would pick from.
 */
export function InvoicePickerField({ value, onChange }: InvoicePickerFieldProps) {
  const [searchInput, setSearchInput] = useState("");
  const [debouncedSearch, setDebouncedSearch] = useState("");

  useEffect(() => {
    const handle = setTimeout(() => setDebouncedSearch(searchInput), SEARCH_DEBOUNCE_MS);
    return () => clearTimeout(handle);
  }, [searchInput]);

  const resultsQuery = useQuery({
    queryKey: ["finance", "invoices", "payable-search", debouncedSearch],
    queryFn: () => fetchInvoicesPage({ status: "submitted", search: debouncedSearch }, undefined),
    enabled: debouncedSearch.trim().length > 0 && value === null,
  });

  const results = (resultsQuery.data?.items ?? []).filter(
    (invoice) => invoice.outstanding_amount_minor > 0,
  );

  if (value) {
    return (
      <div className="payments-form__invoice-selected">
        <div>
          <span className="sf-field__label">Invoice</span>
          <p>
            {value.erpnext_docname} &mdash; {value.student_name} ({value.admission_number})
          </p>
          <p className="payments-form__invoice-outstanding">
            Outstanding: {value.outstanding_amount} {value.currency}
          </p>
        </div>
        <Button type="button" variant="tertiary" onClick={() => onChange(null)}>
          Change
        </Button>
      </div>
    );
  }

  return (
    <div className="payments-form__invoice-picker">
      <Input
        label="Invoice"
        type="search"
        placeholder="Search by student or invoice number"
        value={searchInput}
        onChange={(event) => setSearchInput(event.target.value)}
        helperText="Only submitted invoices with an outstanding balance can be paid."
        required
      />
      {debouncedSearch.trim() ? (
        <ul className="payments-form__invoice-results">
          {results.map((invoice) => (
            <li key={invoice.id}>
              <button
                type="button"
                className="payments-form__invoice-result"
                onClick={() => {
                  onChange(invoice);
                  setSearchInput("");
                  setDebouncedSearch("");
                }}
              >
                <strong>{invoice.erpnext_docname}</strong>
                <span>
                  {invoice.student_name} &middot; {invoice.admission_number} &middot; Outstanding{" "}
                  {invoice.outstanding_amount} {invoice.currency}
                </span>
              </button>
            </li>
          ))}
          {!resultsQuery.isPending && results.length === 0 ? (
            <li className="payments-form__invoice-empty">No payable invoices match.</li>
          ) : null}
        </ul>
      ) : null}
    </div>
  );
}
