import { ApiError } from "@studafy/api-client";
import { Button, Card, Input, Modal, Select, useToast } from "@studafy/ui";
import { useRef, useState } from "react";
import { useParams } from "react-router-dom";

import { useFormatters, useTranslation } from "../../../lib/i18n";
import { PlatformPageHeader } from "../PlatformNav";
import { useSchoolDetailQuery } from "../queries";

import { bpsToPercent, fromMinor, todayIso, toMinor, useMoney } from "./format";
import {
  fileUrl,
  useActivateEarly,
  useMatchReceipt,
  useRecordPayment,
  useVoidInvoice,
  useVoidPayment,
} from "./mutations";
import { InvoiceStatusPill } from "./PaymentsPage";
import { useInvoiceQuery } from "./queries";

import "../platform.css";
import "./licensing.css";

import type { InvoiceDetail, Payment } from "./queries";

type Receipt = InvoiceDetail["receipts"][number];

/**
 * One license invoice (`/portal/platform/payments/:schoolId/:invoiceId`): its lines, the bank details
 * and payment reference the school transfers against, the payments recorded and the receipts the
 * school uploaded. Record a transfer, match a receipt, void a payment or the invoice, activate the
 * license early, or print it (the browser's print-to-PDF downloads it).
 */
export default function InvoicePage() {
  const { t } = useTranslation();
  const { schoolId = "", invoiceId = "" } = useParams();
  const invoice = useInvoiceQuery(schoolId, invoiceId);
  const school = useSchoolDetailQuery(schoolId, schoolId !== "");
  const [modal, setModal] = useState<
    | { kind: "record"; receipt: Receipt | null }
    | { kind: "voidPayment"; payment: Payment }
    | { kind: "voidInvoice" }
    | { kind: "match"; receipt: Receipt }
    | { kind: "activate" }
    | null
  >(null);

  const data = invoice.data;
  const open = data?.status === "issued" || data?.status === "partially_paid";

  return (
    <>
      <PlatformPageHeader
        title={
          data
            ? t("platformLicensing.invoice.title", { number: data.number })
            : t("platformLicensing.invoice.loading")
        }
        description={t("platformLicensing.invoice.description")}
        actions={
          data ? (
            <>
              {open ? (
                <Button
                  variant="primary"
                  onClick={() => setModal({ kind: "record", receipt: null })}
                >
                  {t("platformLicensing.invoice.record")}
                </Button>
              ) : null}
              {open ? (
                <Button variant="secondary" onClick={() => setModal({ kind: "activate" })}>
                  {t("platformLicensing.invoice.activateEarly")}
                </Button>
              ) : null}
              <Button variant="secondary" onClick={() => window.print()}>
                {t("platformLicensing.invoice.print")}
              </Button>
              {data.status !== "void" && data.paidMinor === 0 ? (
                <Button variant="tertiary" onClick={() => setModal({ kind: "voidInvoice" })}>
                  {t("platformLicensing.invoice.voidInvoice")}
                </Button>
              ) : null}
            </>
          ) : null
        }
      />
      {invoice.isPending ? <p role="status">{t("site.common.loading")}</p> : null}
      {invoice.isError ? <p role="alert">{t("platformLicensing.common.loadError")}</p> : null}
      {data ? (
        <div className="platform-stack">
          <InvoiceDocument invoice={data} schoolName={school.data?.name ?? null} />
          <PaymentsCard
            invoice={data}
            schoolId={schoolId}
            onVoid={(payment) => setModal({ kind: "voidPayment", payment })}
          />
          <ReceiptsCard
            invoice={data}
            schoolId={schoolId}
            onMatch={(receipt) => setModal({ kind: "match", receipt })}
            onRecord={(receipt) => setModal({ kind: "record", receipt })}
          />
        </div>
      ) : null}

      {data ? (
        <>
          <RecordPaymentModal
            open={modal?.kind === "record"}
            receipt={modal?.kind === "record" ? modal.receipt : null}
            invoice={data}
            schoolId={schoolId}
            onClose={() => setModal(null)}
          />
          <ReasonModal
            open={modal?.kind === "voidPayment" || modal?.kind === "voidInvoice"}
            title={
              modal?.kind === "voidPayment"
                ? t("platformLicensing.invoice.voidPaymentTitle", {
                    reference: modal.payment.bankReference,
                  })
                : t("platformLicensing.invoice.voidInvoiceTitle", { number: data.number })
            }
            target={
              modal?.kind === "voidPayment"
                ? { schoolId, paymentId: modal.payment.id }
                : modal?.kind === "voidInvoice"
                  ? { schoolId, invoiceId: data.id }
                  : null
            }
            onClose={() => setModal(null)}
          />
          <MatchReceiptModal
            receipt={modal?.kind === "match" ? modal.receipt : null}
            invoice={data}
            schoolId={schoolId}
            onClose={() => setModal(null)}
          />
          <ActivateEarlyModal
            open={modal?.kind === "activate"}
            invoice={data}
            schoolId={schoolId}
            onClose={() => setModal(null)}
          />
        </>
      ) : null}
    </>
  );
}

function InvoiceDocument({
  invoice,
  schoolName,
}: {
  invoice: InvoiceDetail;
  schoolName: string | null;
}) {
  const { t } = useTranslation();
  const { formatDate } = useFormatters();
  const money = useMoney();
  const m = (amount: number | null) =>
    amount === null ? "—" : money(amount, invoice.currencyCode, invoice.minorUnit);

  return (
    <div className="licensing-invoice">
      <Card as="article" aria-labelledby="invoice-document">
        <Card.Header>
          <div className="platform-header__row">
            <div className="platform-cell-stack">
              <h2 id="invoice-document">{invoice.number}</h2>
              {schoolName ? (
                <span>{t("platformLicensing.invoice.billedTo", { school: schoolName })}</span>
              ) : null}
              <span className="platform-muted">
                {t("platformLicensing.invoice.issuedDue", {
                  issued: formatDate(new Date(invoice.issueDate), { dateStyle: "medium" }),
                  due: formatDate(new Date(invoice.dueDate), { dateStyle: "medium" }),
                })}
              </span>
            </div>
            <InvoiceStatusPill status={invoice.status} overdue={invoice.overdue} />
          </div>
        </Card.Header>
        <Card.Body>
          <table className="platform-table">
            <caption className="sf-visually-hidden">
              {t("platformLicensing.invoice.linesCaption")}
            </caption>
            <thead>
              <tr>
                <th scope="col">{t("platformLicensing.invoice.columns.description")}</th>
                <th scope="col">{t("platformLicensing.invoice.columns.list")}</th>
                <th scope="col">{t("platformLicensing.invoice.columns.discounts")}</th>
                <th scope="col">{t("platformLicensing.invoice.columns.amount")}</th>
              </tr>
            </thead>
            <tbody>
              {invoice.lines.map((line) => (
                <tr key={line.position}>
                  <td>{line.description}</td>
                  <td className="licensing-amount">{m(line.listAmountMinor)}</td>
                  <td>
                    {line.kind === "seats"
                      ? [
                          line.volumeDiscountBps
                            ? t("platformLicensing.invoice.volume", {
                                percent: bpsToPercent(line.volumeDiscountBps),
                              })
                            : null,
                          line.durationDiscountBps
                            ? t("platformLicensing.invoice.duration", {
                                percent: bpsToPercent(line.durationDiscountBps),
                              })
                            : null,
                        ]
                          .filter(Boolean)
                          .join(" · ") || "—"
                      : "—"}
                  </td>
                  <td className="licensing-amount">{m(line.amountMinor)}</td>
                </tr>
              ))}
            </tbody>
          </table>
          <ul className="platform-breakdown">
            <li>
              <span>{t("platformLicensing.invoice.total")}</span>
              <strong>{m(invoice.totalMinor)}</strong>
            </li>
            <li>
              <span>{t("platformLicensing.invoice.paid")}</span>
              <strong>{m(invoice.paidMinor)}</strong>
            </li>
            <li>
              <span>{t("platformLicensing.invoice.balance")}</span>
              <strong>{m(invoice.balanceMinor)}</strong>
            </li>
          </ul>
          <h3>{t("platformLicensing.invoice.howToPay")}</h3>
          <dl className="platform-dl">
            <dt>{t("platformLicensing.invoice.reference")}</dt>
            <dd>
              <code>{invoice.paymentReference}</code>
            </dd>
            {invoice.bankDetails ? (
              <>
                <dt>{t("platformLicensing.pricing.bankName")}</dt>
                <dd>{invoice.bankDetails.bankName}</dd>
                <dt>{t("platformLicensing.pricing.accountName")}</dt>
                <dd>{invoice.bankDetails.accountName}</dd>
                <dt>{t("platformLicensing.pricing.iban")}</dt>
                <dd>
                  <code>{invoice.bankDetails.iban}</code>
                </dd>
                <dt>{t("platformLicensing.pricing.swift")}</dt>
                <dd>
                  <code>{invoice.bankDetails.swift}</code>
                </dd>
              </>
            ) : (
              <>
                <dt>{t("platformLicensing.pricing.bankTitle")}</dt>
                <dd>{t("platformLicensing.invoice.noBankDetails")}</dd>
              </>
            )}
          </dl>
          {invoice.voidReason ? (
            <p role="note">
              {t("platformLicensing.invoice.voided", { reason: invoice.voidReason })}
            </p>
          ) : null}
        </Card.Body>
      </Card>
    </div>
  );
}

function PaymentsCard({
  invoice,
  schoolId,
  onVoid,
}: {
  invoice: InvoiceDetail;
  schoolId: string;
  onVoid: (payment: Payment) => void;
}) {
  const { t } = useTranslation();
  const { show } = useToast();
  const { formatDate } = useFormatters();
  const money = useMoney();
  return (
    <div className="licensing-no-print">
      <Card as="section" aria-labelledby="invoice-payments">
        <Card.Header>
          <h2 id="invoice-payments">{t("platformLicensing.invoice.paymentsTitle")}</h2>
        </Card.Header>
        <Card.Body>
          {invoice.payments.length === 0 ? (
            <p className="platform-muted">{t("platformLicensing.invoice.noPayments")}</p>
          ) : (
            <table className="platform-table">
              <caption className="sf-visually-hidden">
                {t("platformLicensing.invoice.paymentsTitle")}
              </caption>
              <thead>
                <tr>
                  <th scope="col">{t("platformLicensing.invoice.paymentColumns.received")}</th>
                  <th scope="col">{t("platformLicensing.invoice.paymentColumns.reference")}</th>
                  <th scope="col">{t("platformLicensing.invoice.paymentColumns.amount")}</th>
                  <th scope="col">{t("platformLicensing.invoice.paymentColumns.status")}</th>
                  <th scope="col">
                    <span className="sf-visually-hidden">
                      {t("platformLicensing.common.actions")}
                    </span>
                  </th>
                </tr>
              </thead>
              <tbody>
                {invoice.payments.map((payment) => (
                  <tr key={payment.id}>
                    <td>{formatDate(new Date(payment.receivedAt), { dateStyle: "medium" })}</td>
                    <td>
                      <div className="platform-cell-stack">
                        <span>{payment.bankReference}</span>
                        {payment.note ? (
                          <span className="platform-muted">{payment.note}</span>
                        ) : null}
                      </div>
                    </td>
                    <td className="licensing-amount">
                      {money(payment.amountMinor, payment.currencyCode, invoice.minorUnit)}
                    </td>
                    <td>
                      {payment.voidedAt
                        ? t("platformLicensing.invoice.paymentVoided", {
                            reason: payment.voidReason,
                          })
                        : t("platformLicensing.invoice.paymentRecorded")}
                    </td>
                    <td>
                      <div className="platform-actions">
                        {payment.hasReceiptFile ? (
                          <Button
                            variant="tertiary"
                            onClick={() =>
                              void openFile(
                                { schoolId, paymentId: payment.id },
                                errorToast(show, t),
                              )
                            }
                          >
                            {t("platformLicensing.invoice.openFile")}
                          </Button>
                        ) : null}
                        {payment.voidedAt ? null : (
                          <Button
                            variant="tertiary"
                            onClick={() => onVoid(payment)}
                            aria-label={t("platformLicensing.invoice.voidPaymentNamed", {
                              reference: payment.bankReference,
                            })}
                          >
                            {t("platformLicensing.invoice.voidPayment")}
                          </Button>
                        )}
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </Card.Body>
      </Card>
    </div>
  );
}

function ReceiptsCard({
  invoice,
  schoolId,
  onMatch,
  onRecord,
}: {
  invoice: InvoiceDetail;
  schoolId: string;
  onMatch: (receipt: Receipt) => void;
  onRecord: (receipt: Receipt) => void;
}) {
  const { t } = useTranslation();
  const { show } = useToast();
  const { formatDate } = useFormatters();
  const open = invoice.status === "issued" || invoice.status === "partially_paid";
  const livePayments = invoice.payments.filter((p) => !p.voidedAt);
  return (
    <div className="licensing-no-print">
      <Card as="section" aria-labelledby="invoice-receipts">
        <Card.Header>
          <h2 id="invoice-receipts">{t("platformLicensing.invoice.receiptsTitle")}</h2>
        </Card.Header>
        <Card.Body>
          {invoice.receipts.length === 0 ? (
            <p className="platform-muted">{t("platformLicensing.invoice.noReceipts")}</p>
          ) : (
            <ul
              className="licensing-history"
              aria-label={t("platformLicensing.invoice.receiptsTitle")}
            >
              {invoice.receipts.map((receipt) => (
                <li key={receipt.id}>
                  <div className="platform-cell-stack">
                    <span>{receipt.fileName}</span>
                    <span className="platform-muted">
                      {formatDate(new Date(receipt.createdAt), { dateStyle: "medium" })}
                      {receipt.note ? ` · “${receipt.note}”` : ""}
                    </span>
                  </div>
                  <div className="platform-actions">
                    <Button
                      variant="tertiary"
                      onClick={() =>
                        void openFile({ schoolId, receiptId: receipt.id }, errorToast(show, t))
                      }
                    >
                      {t("platformLicensing.invoice.openFile")}
                    </Button>
                    {receipt.status === "matched" ? (
                      <span className="platform-pill" data-status="matched">
                        {t("platformLicensing.invoice.matched")}
                      </span>
                    ) : (
                      <>
                        {open ? (
                          <Button variant="secondary" onClick={() => onRecord(receipt)}>
                            {t("platformLicensing.invoice.recordFromReceipt")}
                          </Button>
                        ) : null}
                        {livePayments.length > 0 ? (
                          <Button
                            variant="tertiary"
                            onClick={() => onMatch(receipt)}
                            aria-label={t("platformLicensing.invoice.matchNamed", {
                              file: receipt.fileName,
                            })}
                          >
                            {t("platformLicensing.invoice.match")}
                          </Button>
                        ) : null}
                      </>
                    )}
                  </div>
                </li>
              ))}
            </ul>
          )}
        </Card.Body>
      </Card>
    </div>
  );
}

function errorToast(
  show: ReturnType<typeof useToast>["show"],
  t: ReturnType<typeof useTranslation>["t"],
) {
  return (error: unknown) =>
    show({
      variant: "error",
      title: t("platformLicensing.common.saveError"),
      description: error instanceof ApiError ? (error.detail ?? error.title) : undefined,
    });
}

/**
 * Open a receipt or payment file in a new tab. The tab opens on the click itself -- one opened after
 * the URL request resolves is blocked as a popup -- and is pointed at the short-lived URL once it
 * arrives.
 */
async function openFile(target: Parameters<typeof fileUrl>[0], onError: (error: unknown) => void) {
  const tab = window.open("", "_blank");
  if (tab) tab.opener = null;
  try {
    const url = await fileUrl(target);
    if (tab) tab.location.href = url;
    else window.location.assign(url);
  } catch (error) {
    tab?.close();
    onError(error);
  }
}

/** Record a bank transfer: amount (up to the balance), date, bank reference, receipt. */
function RecordPaymentModal({
  open,
  receipt,
  invoice,
  schoolId,
  onClose,
}: {
  open: boolean;
  receipt: Receipt | null;
  invoice: InvoiceDetail;
  schoolId: string;
  onClose: () => void;
}) {
  const { t } = useTranslation();
  const { show } = useToast();
  const money = useMoney();
  const record = useRecordPayment();
  const fileInput = useRef<HTMLInputElement>(null);
  const [amount, setAmount] = useState("");
  const [receivedOn, setReceivedOn] = useState(todayIso());
  const [reference, setReference] = useState("");
  const [note, setNote] = useState("");
  const [receiptId, setReceiptId] = useState("");
  const [file, setFile] = useState<File | null>(null);
  const [seeded, setSeeded] = useState(false);

  if (open && !seeded) {
    setSeeded(true);
    setAmount(fromMinor(invoice.balanceMinor, invoice.minorUnit));
    setReceivedOn(todayIso());
    setReference("");
    setNote("");
    setReceiptId(receipt?.id ?? "");
    setFile(null);
  }

  function close() {
    setSeeded(false);
    onClose();
  }

  const amountMinor = toMinor(amount, invoice.minorUnit);
  const tooMuch = amountMinor !== null && amountMinor > invoice.balanceMinor;
  const valid =
    amountMinor !== null &&
    amountMinor > 0 &&
    !tooMuch &&
    reference.trim() !== "" &&
    receivedOn !== "";
  const pending = invoice.receipts.filter((r) => r.status === "pending");

  function submit() {
    if (!valid) return;
    record.mutate(
      {
        schoolId,
        invoiceId: invoice.id,
        amountMinor: amountMinor!,
        receivedAt: new Date(`${receivedOn}T12:00:00Z`).toISOString(),
        bankReference: reference.trim(),
        note: note.trim() || null,
        receiptId: receiptId || null,
        file,
      },
      {
        onSuccess: (result) => {
          show({
            variant: "success",
            title: result.licenseActivated
              ? t("platformLicensing.invoice.recordedActivated")
              : t("platformLicensing.invoice.recorded"),
          });
          close();
        },
        onError: errorToast(show, t),
      },
    );
  }

  return (
    <Modal
      open={open}
      onClose={close}
      title={t("platformLicensing.invoice.recordTitle", { number: invoice.number })}
      description={t("platformLicensing.invoice.balanceDue", {
        amount: money(invoice.balanceMinor, invoice.currencyCode, invoice.minorUnit),
      })}
    >
      <Modal.Body>
        <div className="licensing-form-grid">
          <Input
            label={t("platformLicensing.invoice.amountLabel", { currency: invoice.currencyCode })}
            value={amount}
            inputMode="decimal"
            error={
              tooMuch
                ? t("platformLicensing.invoice.amountTooMuch")
                : amountMinor === null
                  ? t("platformLicensing.invoice.amountError")
                  : undefined
            }
            onChange={(event) => setAmount(event.target.value)}
          />
          <Input
            label={t("platformLicensing.invoice.receivedLabel")}
            type="date"
            value={receivedOn}
            onChange={(event) => setReceivedOn(event.target.value)}
          />
          <Input
            label={t("platformLicensing.invoice.bankReferenceLabel")}
            value={reference}
            onChange={(event) => setReference(event.target.value)}
            required
          />
        </div>
        <Input
          label={t("platformLicensing.invoice.noteLabel")}
          value={note}
          onChange={(event) => setNote(event.target.value)}
        />
        {pending.length > 0 ? (
          <Select
            label={t("platformLicensing.invoice.receiptLabel")}
            value={receiptId}
            onChange={setReceiptId}
            options={[
              { value: "", label: t("platformLicensing.invoice.noReceipt") },
              ...pending.map((r) => ({ value: r.id, label: r.fileName })),
            ]}
          />
        ) : null}
        <label className="platform-cell-stack">
          <span>{t("platformLicensing.invoice.fileLabel")}</span>
          <input
            ref={fileInput}
            type="file"
            accept="application/pdf,image/jpeg,image/png"
            onChange={(event) => setFile(event.target.files?.[0] ?? null)}
          />
        </label>
      </Modal.Body>
      <Modal.Footer>
        <Button type="button" variant="tertiary" onClick={close}>
          {t("platform.common.cancel")}
        </Button>
        <Button
          type="button"
          variant="primary"
          disabled={!valid}
          loading={record.isPending}
          onClick={submit}
        >
          {t("platformLicensing.invoice.recordConfirm")}
        </Button>
      </Modal.Footer>
    </Modal>
  );
}

/** Void a payment or the invoice: a reason is required. */
function ReasonModal({
  open,
  title,
  target,
  onClose,
}: {
  open: boolean;
  title: string;
  target: { schoolId: string; paymentId: string } | { schoolId: string; invoiceId: string } | null;
  onClose: () => void;
}) {
  const { t } = useTranslation();
  const { show } = useToast();
  const voidPayment = useVoidPayment();
  const voidInvoice = useVoidInvoice();
  const [reason, setReason] = useState("");
  const pending = voidPayment.isPending || voidInvoice.isPending;

  function close() {
    setReason("");
    onClose();
  }

  function submit() {
    if (!target || reason.trim() === "") return;
    const options = {
      onSuccess: () => {
        show({ variant: "success", title: t("platformLicensing.invoice.voidDone") });
        close();
      },
      onError: errorToast(show, t),
    };
    if ("paymentId" in target) voidPayment.mutate({ ...target, reason: reason.trim() }, options);
    else voidInvoice.mutate({ ...target, reason: reason.trim() }, options);
  }

  return (
    <Modal open={open} onClose={close} title={title}>
      <Modal.Body>
        <Input
          label={t("platformLicensing.invoice.reasonLabel")}
          value={reason}
          onChange={(event) => setReason(event.target.value)}
          required
        />
        <p className="platform-muted">{t("platformLicensing.invoice.voidHelp")}</p>
      </Modal.Body>
      <Modal.Footer>
        <Button type="button" variant="tertiary" onClick={close}>
          {t("platform.common.cancel")}
        </Button>
        <Button
          type="button"
          variant="primary"
          disabled={reason.trim() === ""}
          loading={pending}
          onClick={submit}
        >
          {t("platformLicensing.common.confirm")}
        </Button>
      </Modal.Footer>
    </Modal>
  );
}

/** Tie a school's receipt to a payment already recorded on this invoice. */
function MatchReceiptModal({
  receipt,
  invoice,
  schoolId,
  onClose,
}: {
  receipt: Receipt | null;
  invoice: InvoiceDetail;
  schoolId: string;
  onClose: () => void;
}) {
  const { t } = useTranslation();
  const { show } = useToast();
  const { formatDate } = useFormatters();
  const money = useMoney();
  const match = useMatchReceipt();
  const [paymentId, setPaymentId] = useState("");
  const payments = invoice.payments.filter((p) => !p.voidedAt);

  function close() {
    setPaymentId("");
    onClose();
  }

  function submit() {
    if (!receipt || !paymentId) return;
    match.mutate(
      { schoolId, receiptId: receipt.id, paymentId },
      {
        onSuccess: () => {
          show({ variant: "success", title: t("platformLicensing.invoice.matchDone") });
          close();
        },
        onError: errorToast(show, t),
      },
    );
  }

  return (
    <Modal
      open={receipt !== null}
      onClose={close}
      title={t("platformLicensing.invoice.matchTitle", { file: receipt?.fileName ?? "" })}
    >
      <Modal.Body>
        <Select
          label={t("platformLicensing.invoice.paymentLabel")}
          value={paymentId}
          onChange={setPaymentId}
          placeholder={t("platformLicensing.invoice.paymentPlaceholder")}
          options={payments.map((p) => ({
            value: p.id,
            label: t("platformLicensing.invoice.paymentOption", {
              reference: p.bankReference,
              amount: money(p.amountMinor, p.currencyCode, invoice.minorUnit),
              date: formatDate(new Date(p.receivedAt), { dateStyle: "medium" }),
            }),
          }))}
        />
      </Modal.Body>
      <Modal.Footer>
        <Button type="button" variant="tertiary" onClick={close}>
          {t("platform.common.cancel")}
        </Button>
        <Button
          type="button"
          variant="primary"
          disabled={!paymentId}
          loading={match.isPending}
          onClick={submit}
        >
          {t("platformLicensing.invoice.match")}
        </Button>
      </Modal.Footer>
    </Modal>
  );
}

/** Activate the license before payment, with the date payment is now due. */
export function ActivateEarlyModal({
  open,
  invoice,
  schoolId,
  onClose,
}: {
  open: boolean;
  invoice: { id: string; number: string; issueDate: string; dueDate: string };
  schoolId: string;
  onClose: () => void;
}) {
  const { t } = useTranslation();
  const { show } = useToast();
  const activate = useActivateEarly();
  const [dueDate, setDueDate] = useState("");
  const value = dueDate || invoice.dueDate;
  const valid = value >= invoice.issueDate;

  function close() {
    setDueDate("");
    onClose();
  }

  function submit() {
    if (!valid) return;
    activate.mutate(
      { schoolId, invoiceId: invoice.id, dueDate: value },
      {
        onSuccess: (result) => {
          show({
            variant: "success",
            title: result.licenseActivated
              ? t("platformLicensing.invoice.activated")
              : t("platformLicensing.invoice.dueDateMoved"),
          });
          close();
        },
        onError: errorToast(show, t),
      },
    );
  }

  return (
    <Modal
      open={open}
      onClose={close}
      title={t("platformLicensing.invoice.activateTitle", { number: invoice.number })}
      description={t("platformLicensing.invoice.activateHelp")}
    >
      <Modal.Body>
        <Input
          label={t("platformLicensing.invoice.dueDateLabel")}
          type="date"
          value={value}
          min={invoice.issueDate}
          error={valid ? undefined : t("platformLicensing.invoice.dueDateError")}
          onChange={(event) => setDueDate(event.target.value)}
        />
      </Modal.Body>
      <Modal.Footer>
        <Button type="button" variant="tertiary" onClick={close}>
          {t("platform.common.cancel")}
        </Button>
        <Button
          type="button"
          variant="primary"
          disabled={!valid}
          loading={activate.isPending}
          onClick={submit}
        >
          {t("platformLicensing.invoice.activateConfirm")}
        </Button>
      </Modal.Footer>
    </Modal>
  );
}
