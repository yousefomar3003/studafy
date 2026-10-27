import { ApiError } from "@studafy/api-client";
import { Button, Card, Checkbox, DataGrid, Input, Radio, RadioGroup, Select } from "@studafy/ui";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useMemo, useRef, useState } from "react";
import { Link, useParams } from "react-router-dom";

import { useTranslation } from "../../../lib/i18n";
import { PAYMENT_MODE_LABEL_KEYS } from "../labels";
import { ReceiptButton } from "../ReceiptButton";

import { allocateOldestFirst, fromMinor, payingOrder, toMinor } from "./allocation";
import {
  FAMILIES_KEY,
  fetchFamilyProfile,
  fetchHousehold,
  useRecordFamilyPayment,
} from "./queries";

import "./families.css";

import type { OpenInvoice } from "./allocation";
import type { CreateFamilyPaymentBody, FamilyPaymentResponse, HouseholdStudent } from "./queries";
import type { DataGridColumn, SelectOption } from "@studafy/ui";
import type { FormEvent } from "react";

type PaymentMode = keyof typeof PAYMENT_MODE_LABEL_KEYS;

/** How often the result screen checks for ERPNext's confirmations, as the single-payment page does. */
const CONFIRM_POLL_MS = 3000;

interface OpenRow extends OpenInvoice {
  student_name: string;
  currency: string;
  minor_unit: number;
  outstanding: string;
}

/**
 * One payment from a family, split across its children's invoices
 * (`/portal/finance/families/:familyId/payments/new`), gated by `billing:update`.
 *
 * The split defaults to the server's own rule, oldest-due invoice first, previewed live; finance can
 * switch to choosing each invoice's share by hand. Either way the API posts one ERPNext Payment Entry
 * per invoice under keys derived from this form's Idempotency-Key, so "Retry" after a partial
 * failure pays only what is left.
 */
export default function RecordFamilyPaymentPage() {
  const { t } = useTranslation();
  const { familyId = "" } = useParams<{ familyId: string }>();

  const profile = useQuery({
    queryKey: [...FAMILIES_KEY, familyId, "profile"],
    queryFn: () => fetchFamilyProfile(familyId),
    enabled: Boolean(familyId),
  });
  const household = useQuery({
    queryKey: [...FAMILIES_KEY, familyId, "household"],
    queryFn: () => fetchHousehold(familyId),
    enabled: Boolean(familyId),
  });

  if (profile.isPending || household.isPending) {
    return <p role="status">{t("finance.common.loading")}</p>;
  }
  if (profile.isError || household.isError) {
    return <p role="alert">{t("finance.families.detail.loadError")}</p>;
  }

  const names = new Map(profile.data.children.map((child) => [child.student_id, child.name]));
  const open: OpenRow[] = household.data.flatMap((section) =>
    section.invoices
      .filter(
        (invoice) =>
          invoice.outstanding_amount_minor > 0 &&
          !["draft", "cancelled"].includes(invoice.erpnext_status.toLowerCase()),
      )
      .map((invoice) => ({
        invoice_id: invoice.erpnext_docname,
        student_id: section.student_id,
        student_name: names.get(section.student_id) ?? "",
        due_date: invoice.due_date,
        issued_date: invoice.issued_date,
        outstanding_minor: invoice.outstanding_amount_minor,
        outstanding: invoice.outstanding_amount,
        currency: invoice.currency,
        minor_unit: invoice.currency_minor_unit,
      })),
  );

  return (
    <>
      <h1>{t("finance.families.payment.title", { family: profile.data.display_name })}</h1>
      <p>
        <Link to={`/portal/finance/families/${familyId}`}>
          {t("finance.families.payment.backToFamily")}
        </Link>
      </p>
      {open.length === 0 ? (
        <p role="status">{t("finance.families.payment.nothingOwed")}</p>
      ) : (
        <FamilyPaymentForm familyId={familyId} open={open} />
      )}
    </>
  );
}

function FamilyPaymentForm({ familyId, open }: { familyId: string; open: OpenRow[] }) {
  const { t } = useTranslation();
  const record = useRecordFamilyPayment();
  const currencies = [...new Set(open.map((row) => row.currency))];

  const [currency, setCurrency] = useState(currencies[0]!);
  const [amountInput, setAmountInput] = useState("");
  const [mode, setMode] = useState<PaymentMode | "">("");
  const [referenceNo, setReferenceNo] = useState("");
  const [referenceDate, setReferenceDate] = useState("");
  const [postingDate, setPostingDate] = useState("");
  const [remarks, setRemarks] = useState("");
  const [manual, setManual] = useState(false);
  const [manualInputs, setManualInputs] = useState<Record<string, string>>({});
  const [result, setResult] = useState<FamilyPaymentResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  // One key per attempt; a retry of the same attempt reuses it so nothing is paid twice.
  const keyRef = useRef(crypto.randomUUID());

  const rows = useMemo(
    () => payingOrder(open.filter((row) => row.currency === currency)) as typeof open,
    [open, currency],
  );
  const minorUnit = rows[0]?.minor_unit ?? 3;
  const owedMinor = rows.reduce((sum, row) => sum + row.outstanding_minor, 0);
  const amountMinor = toMinor(amountInput, minorUnit);

  const automatic = amountMinor === null ? [] : allocateOldestFirst(amountMinor, rows);
  const shareOf = (invoiceId: string): number | null => {
    if (!manual) return automatic.find((item) => item.invoice_id === invoiceId)?.amount_minor ?? 0;
    const text = manualInputs[invoiceId] ?? "";
    return text.trim() === "" ? 0 : toMinor(text, minorUnit);
  };
  const shares = rows.map((row) => ({ row, minor: shareOf(row.invoice_id) }));
  const allocatedMinor = shares.reduce((sum, share) => sum + (share.minor ?? 0), 0);

  const problems: string[] = [];
  if (amountMinor !== null && amountMinor > owedMinor) {
    problems.push(
      t("finance.families.payment.exceeds", { amount: fromMinor(owedMinor, minorUnit), currency }),
    );
  }
  if (manual) {
    if (shares.some((share) => share.minor === null)) {
      problems.push(t("finance.families.payment.invalidShare"));
    }
    if (shares.some((share) => (share.minor ?? 0) > share.row.outstanding_minor)) {
      problems.push(t("finance.families.payment.shareTooLarge"));
    }
    if (amountMinor !== null && allocatedMinor !== amountMinor) {
      problems.push(
        t("finance.families.payment.unbalanced", {
          allocated: fromMinor(allocatedMinor, minorUnit),
          amount: fromMinor(amountMinor, minorUnit),
          currency,
        }),
      );
    }
  }
  const canSubmit = amountMinor !== null && amountMinor > 0 && mode !== "" && problems.length === 0;

  function switchToManual(next: boolean) {
    if (next) {
      // Start from the automatic split, so the clerk adjusts rather than retypes.
      setManualInputs(
        Object.fromEntries(
          automatic.map((item) => [item.invoice_id, fromMinor(item.amount_minor, minorUnit)]),
        ),
      );
    }
    setManual(next);
  }

  function submit(event?: FormEvent) {
    event?.preventDefault();
    if (!canSubmit || amountMinor === null || record.isPending) return;
    setError(null);
    const body: CreateFamilyPaymentBody = {
      amount: Number(fromMinor(amountMinor, minorUnit)),
      currency,
      payment_mode: mode as PaymentMode,
      reference_no: referenceNo.trim() || undefined,
      reference_date: referenceDate || undefined,
      posting_date: postingDate || undefined,
      remarks: remarks.trim() || undefined,
      allocations: shares
        .filter((share) => (share.minor ?? 0) > 0)
        .map((share) => ({
          invoice_id: share.row.invoice_id,
          amount: Number(fromMinor(share.minor!, minorUnit)),
        })),
    };
    record.mutate(
      { familyId, body, idempotencyKey: keyRef.current },
      {
        onSuccess: setResult,
        onError: (failure) =>
          setError(
            failure instanceof ApiError
              ? (failure.detail ?? failure.title)
              : t("finance.common.checkFormAndRetry"),
          ),
      },
    );
  }

  if (result) {
    return (
      <PaymentOutcome
        familyId={familyId}
        result={result}
        retrying={record.isPending}
        onRetry={() => submit()}
      />
    );
  }

  const columns: DataGridColumn<(typeof shares)[number]>[] = [
    { id: "child", header: t("finance.common.student"), renderCell: ({ row }) => row.student_name },
    { id: "invoice", header: t("finance.common.invoice"), renderCell: ({ row }) => row.invoice_id },
    { id: "due", header: t("finance.common.due"), renderCell: ({ row }) => row.due_date ?? "—" },
    {
      id: "owes",
      header: t("finance.common.outstanding"),
      align: "end",
      renderCell: ({ row }) => `${row.outstanding} ${row.currency}`,
    },
    {
      id: "share",
      header: t("finance.families.payment.share"),
      align: "end",
      renderCell: ({ row, minor }) =>
        manual ? (
          <span className="families-share">
            <input
              className="families-share__input"
              aria-label={t("finance.families.payment.shareFor", { invoice: row.invoice_id })}
              type="text"
              inputMode="decimal"
              value={manualInputs[row.invoice_id] ?? ""}
              onChange={(event) =>
                setManualInputs((current) => ({ ...current, [row.invoice_id]: event.target.value }))
              }
            />
            <span>{row.currency}</span>
          </span>
        ) : minor ? (
          `${fromMinor(minor, minorUnit)} ${row.currency}`
        ) : (
          "—"
        ),
    },
  ];

  const currencyOptions: SelectOption<string>[] = currencies.map((code) => ({
    value: code,
    label: code,
  }));

  return (
    <Card as="section" aria-label={t("finance.families.payment.formLabel")}>
      <Card.Body>
        <form className="families-form" onSubmit={submit}>
          {currencies.length > 1 ? (
            <Select
              label={t("finance.common.currency")}
              options={currencyOptions}
              value={currency}
              onChange={(next) => {
                setCurrency(next);
                setManualInputs({});
              }}
            />
          ) : null}

          <div className="families-form__amount">
            <Input
              label={t("finance.families.payment.amount")}
              type="text"
              inputMode="decimal"
              value={amountInput}
              onChange={(event) => setAmountInput(event.target.value)}
              suffix={currency}
              helperText={t("finance.families.payment.owes", {
                amount: fromMinor(owedMinor, minorUnit),
                currency,
              })}
              required
            />
            <Button
              type="button"
              variant="tertiary"
              onClick={() => setAmountInput(fromMinor(owedMinor, minorUnit))}
            >
              {t("finance.families.payment.payAll")}
            </Button>
          </div>

          <Checkbox
            label={t("finance.families.payment.manual")}
            checked={manual}
            onChange={(event) => switchToManual(event.target.checked)}
          />
          <p className="families-cell__muted">
            {manual
              ? t("finance.families.payment.manualHint")
              : t("finance.families.payment.autoHint")}
          </p>

          <DataGrid
            caption={t("finance.families.payment.splitCaption")}
            columns={columns}
            rows={shares}
            getRowId={({ row }) => row.invoice_id}
            getRowLabel={({ row }) => row.invoice_id}
            empty={t("finance.families.payment.nothingOwed")}
          />

          {problems.map((problem) => (
            <p key={problem} role="alert" className="families-form__problem">
              {problem}
            </p>
          ))}

          <RadioGroup
            label={t("finance.payments.record.method")}
            name="family-payment-mode"
            value={mode}
            onChange={(value) => setMode(value as PaymentMode)}
          >
            {(Object.entries(PAYMENT_MODE_LABEL_KEYS) as [PaymentMode, string][]).map(
              ([value, labelKey]) => (
                <Radio key={value} value={value} label={t(labelKey)} />
              ),
            )}
          </RadioGroup>

          <Input
            label={t("finance.payments.record.referenceNumber")}
            type="text"
            value={referenceNo}
            onChange={(event) => setReferenceNo(event.target.value)}
            maxLength={140}
          />
          <Input
            label={t("finance.payments.record.referenceDate")}
            type="date"
            value={referenceDate}
            onChange={(event) => setReferenceDate(event.target.value)}
          />
          <Input
            label={t("finance.payments.record.postingDate")}
            type="date"
            value={postingDate}
            onChange={(event) => setPostingDate(event.target.value)}
            helperText={t("finance.common.defaultsToToday")}
          />
          <Input
            label={t("finance.payments.record.remarks")}
            type="text"
            value={remarks}
            onChange={(event) => setRemarks(event.target.value)}
            maxLength={500}
          />

          {error ? (
            <p role="alert" className="families-form__problem">
              {error}
            </p>
          ) : null}

          <div className="families-actions">
            <Button type="submit" loading={record.isPending} disabled={!canSubmit}>
              {t("finance.families.payment.submit")}
            </Button>
          </div>
        </form>
      </Card.Body>
    </Card>
  );
}

function PaymentOutcome({
  familyId,
  result,
  retrying,
  onRetry,
}: {
  familyId: string;
  result: FamilyPaymentResponse;
  retrying: boolean;
  onRetry: () => void;
}) {
  const { t } = useTranslation();
  const queryClient = useQueryClient();

  // Each share is posted as "pending"; ERPNext confirms it by webhook a moment later, and only then
  // are the invoice balances refreshed and the receipt available. Poll the household until every
  // share is confirmed, then refresh everything family-related so the family page is current.
  const recordedIds = result.results.flatMap((row) => (row.payment ? [row.payment.id] : []));
  const confirmedIn = (sections: HouseholdStudent[] | undefined) =>
    new Set(
      (sections ?? [])
        .flatMap((section) => section.payments)
        .filter((payment) => payment.status === "confirmed")
        .map((payment) => payment.id),
    );
  const household = useQuery({
    queryKey: [...FAMILIES_KEY, familyId, "household"],
    queryFn: () => fetchHousehold(familyId),
    staleTime: 0,
    refetchInterval: (query) => {
      const confirmed = confirmedIn(query.state.data);
      return recordedIds.every((id) => confirmed.has(id)) ? false : CONFIRM_POLL_MS;
    },
  });
  const confirmed = confirmedIn(household.data);
  const allConfirmed = recordedIds.length > 0 && recordedIds.every((id) => confirmed.has(id));
  useEffect(() => {
    if (allConfirmed) void queryClient.invalidateQueries({ queryKey: FAMILIES_KEY });
  }, [allConfirmed, queryClient]);

  const columns: DataGridColumn<FamilyPaymentResponse["results"][number]>[] = [
    { id: "invoice", header: t("finance.common.invoice"), renderCell: (row) => row.invoice_id },
    {
      id: "amount",
      header: t("finance.common.amount"),
      align: "end",
      renderCell: (row) => `${row.amount} ${result.currency}`,
    },
    {
      id: "status",
      header: t("finance.common.status"),
      renderCell: (row) => {
        if (row.status === "failed") {
          return (
            <span className="families-badge" data-tone="danger" title={row.error ?? undefined}>
              {t("finance.families.payment.results.failed")}
            </span>
          );
        }
        const isConfirmed = row.payment !== null && confirmed.has(row.payment.id);
        return (
          <span className="families-badge" data-tone={isConfirmed ? "success" : "warning"}>
            {t(
              isConfirmed
                ? "finance.families.payment.results.confirmed"
                : "finance.families.payment.results.awaiting",
            )}
          </span>
        );
      },
    },
    {
      id: "receipt",
      header: t("finance.payments.list.receipt"),
      renderCell: (row) =>
        row.payment && confirmed.has(row.payment.id) ? (
          <ReceiptButton paymentId={row.payment.id} />
        ) : (
          "—"
        ),
    },
    {
      id: "detail",
      header: t("finance.families.payment.detail"),
      renderCell: (row) => row.error ?? row.payment?.erpnext_payment_entry_id ?? "—",
    },
  ];

  return (
    <Card as="section" aria-label={t("finance.families.payment.resultLabel")}>
      <Card.Body>
        <p role="status" className="families-outcome" data-outcome={result.outcome}>
          {t(`finance.families.payment.outcome.${result.outcome}`)}
        </p>
        <DataGrid
          caption={t("finance.families.payment.resultLabel")}
          columns={columns}
          rows={result.results}
          getRowId={(row) => row.invoice_id}
          getRowLabel={(row) => row.invoice_id}
          empty="—"
        />
        <p className="families-cell__muted">{t("finance.families.payment.receiptsLater")}</p>
        <div className="families-actions">
          {result.outcome !== "completed" ? (
            <Button type="button" loading={retrying} onClick={onRetry}>
              {t("finance.families.payment.retry")}
            </Button>
          ) : null}
          <Link to={`/portal/finance/families/${familyId}`}>
            {t("finance.families.payment.backToFamily")}
          </Link>
        </div>
      </Card.Body>
    </Card>
  );
}
