import { ApiError } from "@studafy/api-client";
import {
  Button,
  Checkbox,
  DataGrid,
  Input,
  Modal,
  Select,
  Tab,
  TabList,
  TabPanel,
  Tabs,
} from "@studafy/ui";
import { useEffect, useId, useState } from "react";

import { useFormatters, useTranslation } from "../../lib/i18n";

import { useApproveRefund, useRejectRefund } from "./mutations";
import { PlatformPageHeader } from "./PlatformNav";
import { REFUNDS_PAGE_SIZE, useRefundRequestQuery, useRefundRequestsQuery } from "./queries";

import "./platform.css";

import type { PlatformRefundRequest, PlatformRefundScope, PlatformRefundStatus } from "./queries";
import type { DataGridColumn, SelectOption } from "@studafy/ui";

const SEARCH_DEBOUNCE_MS = 300;
const STATUS_TABS: readonly (PlatformRefundStatus | "all")[] = [
  "pending",
  "approved",
  "failed",
  "refunded",
  "rejected",
  "all",
];
const SCOPES: readonly PlatformRefundScope[] = ["school", "ai"];

const STATUS_TONE: Record<PlatformRefundStatus, "warning" | "success" | "danger" | undefined> = {
  pending: "warning",
  approved: undefined,
  failed: "danger",
  refunded: "success",
  rejected: undefined,
};

/** Fraction digits of an ISO currency (3 for KWD/JOD/BHD/OMR), so minor units convert exactly. */
function currencyDigits(currencyCode: string): number {
  try {
    return (
      new Intl.NumberFormat("en", { style: "currency", currency: currencyCode }).resolvedOptions()
        .maximumFractionDigits ?? 2
    );
  } catch {
    return 2;
  }
}

function apiErrorMessage(error: unknown, fallback: string): string {
  if (!(error instanceof ApiError)) return fallback;
  return error.detail ?? error.title;
}

/**
 * Subscription refund requests from every school (`/portal/platform/refunds`): school plans filed
 * by a school's billing admin, AI add-ons filed by a student or parent. Approving one refunds the
 * chosen payment through the provider that took it; nothing reaches the provider before that.
 */
export default function RefundsPage() {
  const { t } = useTranslation();
  const { formatCurrency, formatDate, formatNumber } = useFormatters();
  const [searchInput, setSearchInput] = useState("");
  const [search, setSearch] = useState("");
  const [tab, setTab] = useState<PlatformRefundStatus | "all">("pending");
  const [scope, setScope] = useState<PlatformRefundScope | "">("");
  const [page, setPage] = useState(0);
  const [open, setOpen] = useState<PlatformRefundRequest | null>(null);

  useEffect(() => {
    const handle = setTimeout(() => setSearch(searchInput.trim()), SEARCH_DEBOUNCE_MS);
    return () => clearTimeout(handle);
  }, [searchInput]);

  useEffect(() => setPage(0), [search, tab, scope]);

  const status = tab === "all" ? "" : tab;
  const { data, isPending, isError } = useRefundRequestsQuery({ search, status, scope, page });
  const total = data?.total ?? 0;
  const lastPage = Math.max(0, Math.ceil(total / REFUNDS_PAGE_SIZE) - 1);

  const money = (amountMinor: number | null, currencyCode: string | null) =>
    amountMinor === null || !currencyCode
      ? "—"
      : formatCurrency(amountMinor / 10 ** currencyDigits(currencyCode), currencyCode);

  const scopeOptions: SelectOption<PlatformRefundScope | "">[] = [
    { value: "", label: t("platform.refunds.allScopes") },
    ...SCOPES.map((value) => ({ value, label: t(`platform.refunds.scope.${value}`) })),
  ];

  const columns: DataGridColumn<PlatformRefundRequest>[] = [
    {
      id: "requester",
      header: t("platform.refunds.columns.requester"),
      renderCell: (request) => (
        <div className="platform-cell-stack">
          <Button variant="tertiary" onClick={() => setOpen(request)}>
            {request.requester.name}
          </Button>
          <span className="platform-muted">{request.requester.email}</span>
        </div>
      ),
    },
    {
      id: "school",
      header: t("platform.refunds.columns.school"),
      renderCell: (request) => (
        <div className="platform-cell-stack">
          <span>{request.schoolName}</span>
          <span className="platform-muted">
            {request.studentName
              ? `${t(`platform.refunds.scope.${request.scope}`)} · ${request.studentName}`
              : t(`platform.refunds.scope.${request.scope}`)}
          </span>
        </div>
      ),
    },
    {
      id: "reason",
      header: t("platform.refunds.columns.reason"),
      renderCell: (request) => t(`platform.refunds.reason.${request.reason}`),
    },
    {
      id: "amount",
      header: t("platform.refunds.columns.amount"),
      renderCell: (request) => money(request.amountMinor, request.currencyCode),
    },
    {
      id: "status",
      header: t("platform.refunds.columns.status"),
      renderCell: (request) => <RefundStatusPill status={request.status} />,
    },
    {
      id: "received",
      header: t("platform.refunds.columns.received"),
      renderCell: (request) =>
        formatDate(new Date(request.createdAt), { dateStyle: "medium", timeStyle: "short" }),
    },
  ];

  return (
    <>
      <PlatformPageHeader
        title={t("platform.refunds.title")}
        description={t("platform.refunds.description")}
      />

      {data && data.pendingCount > 0 ? (
        <p className="platform-muted" role="status">
          {t("platform.refunds.pendingCount", { count: data.pendingCount })}
        </p>
      ) : null}

      <Tabs value={tab} defaultValue="pending" onChange={(value) => setTab(value as typeof tab)}>
        <TabList aria-label={t("platform.refunds.statusTabs")}>
          {STATUS_TABS.map((value) => (
            <Tab key={value} value={value}>
              {t(`platform.refunds.tabs.${value}`)}
            </Tab>
          ))}
        </TabList>
        {STATUS_TABS.map((value) => (
          <TabPanel key={value} value={value}>
            {value === tab ? (
              <>
                <div className="platform-toolbar">
                  <Input
                    label={t("platform.refunds.searchLabel")}
                    placeholder={t("platform.refunds.searchPlaceholder")}
                    value={searchInput}
                    onChange={(event) => setSearchInput(event.target.value)}
                    type="search"
                  />
                  <Select
                    label={t("platform.refunds.scopeFilter")}
                    options={scopeOptions}
                    value={scope}
                    onChange={(next) => setScope(next)}
                  />
                </div>

                <DataGrid
                  caption={t("platform.refunds.caption")}
                  columns={columns}
                  rows={data?.requests ?? []}
                  getRowId={(request) => request.id}
                  getRowLabel={(request) => request.requester.name}
                  loading={isPending}
                  empty={isError ? t("platform.refunds.loadError") : t("platform.refunds.empty")}
                />

                <div className="platform-pagination">
                  <span className="platform-muted">
                    {t("platform.refunds.pageSummary", {
                      page: formatNumber(page + 1),
                      pages: formatNumber(lastPage + 1),
                      total: formatNumber(total),
                    })}
                  </span>
                  <Button
                    variant="secondary"
                    disabled={page === 0}
                    onClick={() => setPage(page - 1)}
                  >
                    {t("platform.common.previous")}
                  </Button>
                  <Button
                    variant="secondary"
                    disabled={page >= lastPage}
                    onClick={() => setPage(page + 1)}
                  >
                    {t("platform.common.next")}
                  </Button>
                </div>
              </>
            ) : null}
          </TabPanel>
        ))}
      </Tabs>

      {open ? (
        <RefundModal
          key={open.id}
          schoolId={open.schoolId}
          requestId={open.id}
          onClose={() => setOpen(null)}
        />
      ) : null}
    </>
  );
}

function RefundStatusPill({ status }: { status: PlatformRefundStatus }) {
  const { t } = useTranslation();
  return (
    <span className="platform-pill" data-tone={STATUS_TONE[status]}>
      {t(`platform.refunds.status.${status}`)}
    </span>
  );
}

/**
 * One request: what was asked and why, and -- while it is pending or failed -- the decision. The
 * note is shared by both outcomes and shown to the requester: optional to approve, required to
 * reject.
 */
function RefundModal({
  schoolId,
  requestId,
  onClose,
}: {
  schoolId: string;
  requestId: string;
  onClose: () => void;
}) {
  const { t } = useTranslation();
  const { formatCurrency, formatDate } = useFormatters();
  const { data, isPending, isError } = useRefundRequestQuery(schoolId, requestId);
  const approve = useApproveRefund();
  const reject = useRejectRefund();
  const noteId = useId();
  const [paymentReference, setPaymentReference] = useState<string | null>(null);
  const [amountInput, setAmountInput] = useState<string | null>(null);
  const [cancelSubscription, setCancelSubscription] = useState(false);
  const [note, setNote] = useState("");
  const [noteError, setNoteError] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);

  const request = data?.request;
  const payments = data?.payments ?? null;
  const reviewable = request?.status === "pending" || request?.status === "failed";

  // The chosen payment: the reviewer's pick, else the requester's, and its full amount.
  const reference = paymentReference ?? request?.paymentReference ?? "";
  const chosen =
    reference && reference === request?.paymentReference && request.amountMinor !== null
      ? { amountMinor: request.amountMinor, currency: request.currencyCode ?? "" }
      : (payments ?? [])
          .filter((payment) => payment.id === reference)
          .map((payment) => ({ amountMinor: payment.amountPaid, currency: payment.currency }))[0];
  const digits = chosen ? currencyDigits(chosen.currency) : 2;
  const fullAmount = chosen ? (chosen.amountMinor / 10 ** digits).toFixed(digits) : "";
  const amountText = amountInput ?? fullAmount;
  const amountMinor = Math.round(Number(amountText) * 10 ** digits);
  const amountValid =
    chosen !== undefined &&
    Number.isFinite(amountMinor) &&
    amountMinor > 0 &&
    amountMinor <= chosen.amountMinor;

  const money = (minor: number | null, currency: string | null) =>
    minor === null || !currency
      ? "—"
      : formatCurrency(minor / 10 ** currencyDigits(currency), currency);
  const when = (iso: string | null) =>
    iso ? formatDate(new Date(iso), { dateStyle: "medium", timeStyle: "short" }) : "—";

  const paymentOptions: SelectOption[] = [
    ...(request?.paymentReference &&
    !(payments ?? []).some((payment) => payment.id === request.paymentReference)
      ? [
          {
            value: request.paymentReference,
            label: `${request.paymentReference} · ${money(request.amountMinor, request.currencyCode)}`,
          },
        ]
      : []),
    ...(payments ?? []).map((payment) => ({
      value: payment.id,
      label: `${formatDate(new Date(payment.created), { dateStyle: "medium" })} · ${money(
        payment.amountPaid,
        payment.currency,
      )}`,
    })),
  ];

  const handleApprove = () => {
    if (!request || !amountValid) return;
    approve.mutate(
      {
        schoolId,
        requestId,
        paymentReference: reference,
        amountMinor,
        cancelSubscription: request.scope === "school" ? cancelSubscription : undefined,
        note: note.trim() || undefined,
      },
      {
        onSuccess: (result) =>
          setNotice(
            result.cancellation === "not_requested"
              ? t("platform.refunds.approve.done")
              : t(`platform.refunds.cancellation.${result.cancellation}`),
          ),
      },
    );
  };

  const handleReject = () => {
    if (!note.trim()) {
      setNoteError(true);
      return;
    }
    reject.mutate({ schoolId, requestId, note: note.trim() }, { onSuccess: onClose });
  };

  const actionError = approve.error ?? reject.error;

  return (
    <Modal
      open
      onClose={onClose}
      title={request ? request.requester.name : t("platform.refunds.title")}
      description={request?.schoolName}
    >
      <Modal.Body>
        {isPending ? <p role="status">{t("platform.refunds.loading")}</p> : null}
        {isError ? <p role="alert">{t("platform.refunds.loadError")}</p> : null}

        {request ? (
          <>
            <dl className="platform-dl">
              {(
                [
                  [
                    t("platform.refunds.detail.status"),
                    <RefundStatusPill key="s" status={request.status} />,
                  ],
                  [
                    t("platform.refunds.detail.scope"),
                    t(`platform.refunds.scope.${request.scope}`),
                  ],
                  ...(request.studentName
                    ? [[t("platform.refunds.detail.student"), request.studentName]]
                    : []),
                  [t("platform.refunds.detail.requester"), request.requester.email],
                  [
                    t("platform.refunds.detail.reason"),
                    t(`platform.refunds.reason.${request.reason}`),
                  ],
                  [t("platform.refunds.detail.received"), when(request.createdAt)],
                  [t("platform.refunds.detail.provider"), request.provider],
                  [
                    t("platform.refunds.detail.payment"),
                    request.paymentReference
                      ? `${request.paymentReference} · ${money(request.amountMinor, request.currencyCode)}`
                      : t("platform.refunds.detail.paymentNone"),
                  ],
                  ...(request.status === "refunded"
                    ? [
                        [
                          t("platform.refunds.detail.refunded"),
                          `${money(request.refundedAmountMinor, request.currencyCode)} · ${when(request.refundedAt)}`,
                        ],
                        [
                          t("platform.refunds.detail.providerRefundId"),
                          request.providerRefundId ?? "—",
                        ],
                      ]
                    : []),
                  ...(request.reviewedAt
                    ? [[t("platform.refunds.detail.reviewed"), when(request.reviewedAt)]]
                    : []),
                  ...(request.reviewNote
                    ? [[t("platform.refunds.detail.reviewNote"), request.reviewNote]]
                    : []),
                  ...(request.failureMessage
                    ? [[t("platform.refunds.detail.failure"), request.failureMessage]]
                    : []),
                ] as [string, React.ReactNode][]
              ).map(([label, value]) => (
                <div key={label} style={{ display: "contents" }}>
                  <dt>{label}</dt>
                  <dd>{value}</dd>
                </div>
              ))}
            </dl>

            {request.details ? (
              <>
                <h3>{t("platform.refunds.detail.details")}</h3>
                <p className="platform-inquiry-message">{request.details}</p>
              </>
            ) : null}

            {notice ? <p role="status">{notice}</p> : null}

            {reviewable ? (
              <div className="platform-refund-decision">
                <h3>{t("platform.refunds.approve.heading")}</h3>
                {payments === null ? (
                  <p className="platform-muted">
                    {t("platform.refunds.approve.paymentsUnavailable")}
                  </p>
                ) : null}
                <Select
                  label={t("platform.refunds.approve.paymentLabel")}
                  placeholder={t("platform.refunds.approve.paymentPlaceholder")}
                  options={paymentOptions}
                  value={reference || undefined}
                  onChange={(value) => {
                    setPaymentReference(value);
                    setAmountInput(null);
                  }}
                />
                <Input
                  label={t("platform.refunds.approve.amountLabel", {
                    currency: chosen?.currency ?? "",
                  })}
                  helperText={
                    chosen
                      ? t("platform.refunds.approve.amountHelp", {
                          amount: money(chosen.amountMinor, chosen.currency),
                        })
                      : undefined
                  }
                  error={
                    chosen && !amountValid ? t("platform.refunds.approve.amountInvalid") : undefined
                  }
                  inputMode="decimal"
                  disabled={!chosen}
                  value={amountText}
                  onChange={(event) => setAmountInput(event.target.value)}
                />
                {request.scope === "school" ? (
                  <Checkbox
                    label={t("platform.refunds.approve.cancelLabel")}
                    checked={cancelSubscription}
                    onChange={(event) => setCancelSubscription(event.target.checked)}
                  />
                ) : null}
                <div className="sf-field">
                  <label className="sf-field__label" htmlFor={noteId}>
                    {t("platform.refunds.noteLabel")}
                  </label>
                  <div className="sf-input platform-inquiry-notes">
                    <textarea
                      id={noteId}
                      className="sf-input__control"
                      rows={3}
                      maxLength={2000}
                      value={note}
                      aria-invalid={noteError || undefined}
                      onChange={(event) => {
                        setNote(event.target.value);
                        setNoteError(false);
                      }}
                    />
                  </div>
                  {noteError ? (
                    <p className="platform-muted" role="alert">
                      {t("platform.refunds.reject.noteRequired")}
                    </p>
                  ) : null}
                </div>
              </div>
            ) : null}

            {actionError ? (
              <p role="alert">
                {t("platform.refunds.actionError", {
                  message: apiErrorMessage(actionError, t("platform.refunds.tryAgain")),
                })}
              </p>
            ) : null}
          </>
        ) : null}
      </Modal.Body>
      <Modal.Footer>
        <Button type="button" variant="tertiary" onClick={onClose}>
          {t("platform.refunds.close")}
        </Button>
        {reviewable ? (
          <>
            {request?.status === "pending" ? (
              <Button
                type="button"
                variant="secondary"
                loading={reject.isPending}
                disabled={approve.isPending}
                onClick={handleReject}
              >
                {t("platform.refunds.reject.submit")}
              </Button>
            ) : null}
            <Button
              type="button"
              variant="primary"
              loading={approve.isPending}
              disabled={!amountValid || reject.isPending}
              onClick={handleApprove}
            >
              {t("platform.refunds.approve.submit")}
            </Button>
          </>
        ) : null}
      </Modal.Footer>
    </Modal>
  );
}
