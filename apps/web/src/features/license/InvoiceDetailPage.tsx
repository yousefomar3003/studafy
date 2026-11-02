import { ApiError } from "@studafy/api-client";
import { PERMISSIONS } from "@studafy/constants";
import { Button, Input, Table, useToast } from "@studafy/ui";
import { useRef, useState } from "react";
import { useParams } from "react-router-dom";

import { usePermissions } from "../../lib/auth";
import { useFormatters, useTranslation } from "../../lib/i18n";
import { useMoney } from "../platform/licensing/format";

import { InvoiceStatusPill, PaymentsTable } from "./InvoicesPage";
import { LicenseHeader } from "./LicenseHeader";
import { receiptFileUrl, useUploadReceipt } from "./mutations";
import { useInvoiceQuery } from "./queries";

import type { InvoiceDetail, Receipt } from "./queries";

import "./license.css";

/** The receipt content class's rules (`license.receipt` in the API's storage content classes). */
const RECEIPT_TYPES = ["application/pdf", "image/jpeg", "image/png"];
const RECEIPT_MAX_BYTES = 10 * 1024 * 1024;

/**
 * One license invoice (`/portal/license/invoices/:invoiceId`): its lines, due date and balance; the
 * bank details and the payment reference to write on the transfer (with a copy button); the receipts
 * the school uploaded and whether Studafy has matched each to a payment; and the payments recorded.
 * `license:manage` uploads a transfer receipt.
 */
export default function InvoiceDetailPage() {
  const { t } = useTranslation();
  const { invoiceId = "" } = useParams();
  const invoice = useInvoiceQuery(invoiceId);
  const canManage = usePermissions().has(PERMISSIONS.LICENSE_MANAGE);
  const data = invoice.data;
  const open = data?.status === "issued" || data?.status === "partially_paid";

  return (
    <>
      <LicenseHeader
        title={
          data
            ? t("schoolLicense.invoice.title", { number: data.number })
            : t("schoolLicense.invoices.title")
        }
        actions={
          data ? (
            <Button variant="secondary" onClick={() => window.print()}>
              {t("schoolLicense.invoice.print")}
            </Button>
          ) : null
        }
      />
      {invoice.isPending ? <p role="status">{t("schoolLicense.common.loading")}</p> : null}
      {invoice.isError ? <p role="alert">{t("schoolLicense.common.loadError")}</p> : null}
      {data ? (
        <>
          <InvoiceSummary invoice={data} />
          <InvoiceLines invoice={data} />
          {data.status !== "void" && data.status !== "paid" ? <HowToPay invoice={data} /> : null}
          <section className="license-section license-no-print" aria-labelledby="invoice-receipts">
            <h2 id="invoice-receipts">{t("schoolLicense.invoice.receiptsTitle")}</h2>
            {canManage && open ? <UploadReceipt invoiceId={data.id} /> : null}
            <ReceiptList receipts={data.receipts} />
          </section>
          <section className="license-section license-no-print" aria-labelledby="invoice-payments">
            <h2 id="invoice-payments">{t("schoolLicense.invoice.paymentsTitle")}</h2>
            <PaymentsTable payments={data.payments} />
          </section>
        </>
      ) : null}
    </>
  );
}

function InvoiceSummary({ invoice }: { invoice: InvoiceDetail }) {
  const { t } = useTranslation();
  const { formatDate } = useFormatters();
  const money = useMoney();
  const m = (amount: number) => money(amount, invoice.currencyCode, invoice.minorUnit);
  return (
    <dl className="license-facts">
      <div>
        <dt>{t("schoolLicense.invoices.columns.status")}</dt>
        <dd>
          <InvoiceStatusPill invoice={invoice} />
        </dd>
      </div>
      <div>
        <dt>{t("schoolLicense.invoices.columns.issued")}</dt>
        <dd>{formatDate(new Date(invoice.issueDate), { dateStyle: "medium" })}</dd>
      </div>
      <div>
        <dt>{t("schoolLicense.invoices.columns.due")}</dt>
        <dd>{formatDate(new Date(invoice.dueDate), { dateStyle: "medium" })}</dd>
      </div>
      <div>
        <dt>{t("schoolLicense.invoices.columns.total")}</dt>
        <dd>{m(invoice.totalMinor)}</dd>
      </div>
      <div>
        <dt>{t("schoolLicense.invoice.paid")}</dt>
        <dd>{m(invoice.paidMinor)}</dd>
      </div>
      <div>
        <dt>{t("schoolLicense.invoices.columns.balance")}</dt>
        <dd>{m(invoice.balanceMinor)}</dd>
      </div>
    </dl>
  );
}

function InvoiceLines({ invoice }: { invoice: InvoiceDetail }) {
  const { t } = useTranslation();
  const money = useMoney();
  const m = (amount: number) => money(amount, invoice.currencyCode, invoice.minorUnit);
  return (
    <section className="license-section" aria-labelledby="invoice-lines">
      <h2 id="invoice-lines">{t("schoolLicense.invoice.linesTitle")}</h2>
      <Table caption={t("schoolLicense.invoice.linesTitle")} hideCaption>
        <Table.Header>
          <Table.Row>
            <Table.HeaderCell>{t("schoolLicense.quote.columns.item")}</Table.HeaderCell>
            <Table.HeaderCell>{t("schoolLicense.quote.columns.amount")}</Table.HeaderCell>
          </Table.Row>
        </Table.Header>
        <Table.Body columnCount={2}>
          {invoice.lines.map((line) => (
            <Table.Row key={line.position}>
              <Table.Cell>{line.description}</Table.Cell>
              <Table.Cell>
                <span className="license-amount">{m(line.amountMinor)}</span>
              </Table.Cell>
            </Table.Row>
          ))}
        </Table.Body>
      </Table>
      {invoice.voidReason ? (
        <p role="note">{t("schoolLicense.invoice.voided", { reason: invoice.voidReason })}</p>
      ) : null}
    </section>
  );
}

function HowToPay({ invoice }: { invoice: InvoiceDetail }) {
  const { t } = useTranslation();
  const { show } = useToast();
  const money = useMoney();
  const bank = invoice.bankDetails;

  async function copy() {
    try {
      await navigator.clipboard.writeText(invoice.paymentReference);
      show({ variant: "success", title: t("schoolLicense.invoice.copied") });
    } catch {
      show({ variant: "error", title: t("schoolLicense.invoice.copyFailed") });
    }
  }

  return (
    <section className="license-section" aria-labelledby="invoice-pay">
      <h2 id="invoice-pay">{t("schoolLicense.invoice.howToPay")}</h2>
      <p>
        {t("schoolLicense.invoice.howToPayBody", {
          amount: money(invoice.balanceMinor, invoice.currencyCode, invoice.minorUnit),
        })}
      </p>
      <dl className="license-pay">
        <dt>{t("schoolLicense.invoice.reference")}</dt>
        <dd>
          <code className="license-reference">{invoice.paymentReference}</code>
          <span className="license-no-print">
            <Button
              variant="secondary"
              onClick={() => void copy()}
              aria-label={t("schoolLicense.invoice.copyReference", {
                reference: invoice.paymentReference,
              })}
            >
              {t("schoolLicense.invoice.copy")}
            </Button>
          </span>
        </dd>
        {bank ? (
          <>
            <dt>{t("schoolLicense.invoice.bankName")}</dt>
            <dd>{bank.bankName}</dd>
            <dt>{t("schoolLicense.invoice.accountName")}</dt>
            <dd>{bank.accountName}</dd>
            <dt>{t("schoolLicense.invoice.iban")}</dt>
            <dd>
              <code>{bank.iban}</code>
            </dd>
            <dt>{t("schoolLicense.invoice.swift")}</dt>
            <dd>
              <code>{bank.swift}</code>
            </dd>
            <dt>{t("schoolLicense.invoice.bankCurrency")}</dt>
            <dd>{bank.currencyCode}</dd>
          </>
        ) : (
          <>
            <dt>{t("schoolLicense.invoice.bankName")}</dt>
            <dd>{t("schoolLicense.invoice.noBankDetails")}</dd>
          </>
        )}
      </dl>
      <p className="license-muted">{t("schoolLicense.invoice.referenceHelp")}</p>
    </section>
  );
}

function UploadReceipt({ invoiceId }: { invoiceId: string }) {
  const { t } = useTranslation();
  const { show } = useToast();
  const upload = useUploadReceipt();
  const fileInput = useRef<HTMLInputElement>(null);
  const [file, setFile] = useState<File | null>(null);
  const [note, setNote] = useState("");

  const fileError = !file
    ? null
    : !RECEIPT_TYPES.includes(file.type)
      ? t("schoolLicense.invoice.fileType")
      : file.size > RECEIPT_MAX_BYTES
        ? t("schoolLicense.invoice.fileSize")
        : null;

  function submit() {
    if (!file || fileError) return;
    upload.mutate(
      { invoiceId, file, note: note.trim() || null },
      {
        onSuccess: () => {
          show({ variant: "success", title: t("schoolLicense.invoice.uploaded") });
          setFile(null);
          setNote("");
          if (fileInput.current) fileInput.current.value = "";
        },
        onError: (error) =>
          show({
            variant: "error",
            title: t("schoolLicense.invoice.uploadError"),
            description: error instanceof ApiError ? (error.detail ?? error.title) : undefined,
          }),
      },
    );
  }

  return (
    <div
      className="license-toolbar"
      role="group"
      aria-label={t("schoolLicense.invoice.uploadTitle")}
    >
      <label>
        <span>{t("schoolLicense.invoice.fileLabel")}</span>
        <input
          ref={fileInput}
          type="file"
          accept={RECEIPT_TYPES.join(",")}
          onChange={(event) => setFile(event.target.files?.[0] ?? null)}
        />
        {fileError ? (
          <span role="alert" className="license-muted">
            {fileError}
          </span>
        ) : null}
      </label>
      <Input
        label={t("schoolLicense.invoice.noteLabel")}
        value={note}
        onChange={(event) => setNote(event.target.value)}
      />
      <div className="license-toolbar__actions">
        <Button
          variant="primary"
          disabled={!file || fileError !== null}
          loading={upload.isPending}
          onClick={submit}
        >
          {t("schoolLicense.invoice.upload")}
        </Button>
      </div>
    </div>
  );
}

/**
 * Open a receipt in a new tab. The tab opens on the click itself -- one opened after the URL request
 * resolves is blocked as a popup -- and is pointed at the short-lived URL once it arrives.
 */
async function openReceipt(receiptId: string, onError: () => void) {
  const tab = window.open("", "_blank");
  if (tab) tab.opener = null;
  try {
    const url = await receiptFileUrl(receiptId);
    if (tab) tab.location.href = url;
    else window.location.assign(url);
  } catch {
    tab?.close();
    onError();
  }
}

function ReceiptList({ receipts }: { receipts: readonly Receipt[] }) {
  const { t } = useTranslation();
  const { show } = useToast();
  const { formatDate } = useFormatters();
  return (
    <Table caption={t("schoolLicense.invoice.receiptsTitle")} hideCaption>
      <Table.Header>
        <Table.Row>
          <Table.HeaderCell>{t("schoolLicense.invoice.receiptColumns.file")}</Table.HeaderCell>
          <Table.HeaderCell>{t("schoolLicense.invoice.receiptColumns.uploaded")}</Table.HeaderCell>
          <Table.HeaderCell>{t("schoolLicense.invoice.receiptColumns.status")}</Table.HeaderCell>
          <Table.HeaderCell>{t("schoolLicense.common.actions")}</Table.HeaderCell>
        </Table.Row>
      </Table.Header>
      <Table.Body columnCount={4} empty={t("schoolLicense.invoice.noReceipts")}>
        {receipts.map((receipt) => (
          <Table.Row key={receipt.id}>
            <Table.Cell>
              <div>{receipt.fileName}</div>
              {receipt.note ? <div className="license-muted">{receipt.note}</div> : null}
            </Table.Cell>
            <Table.Cell>
              {formatDate(new Date(receipt.createdAt), { dateStyle: "medium" })}
            </Table.Cell>
            <Table.Cell>
              <span
                className="license-pill"
                data-tone={receipt.status === "matched" ? "success" : "warning"}
              >
                {t(`schoolLicense.receiptStatus.${receipt.status}`)}
              </span>
            </Table.Cell>
            <Table.Cell>
              <Button
                variant="tertiary"
                aria-label={t("schoolLicense.invoice.openReceipt", { file: receipt.fileName })}
                onClick={() =>
                  void openReceipt(receipt.id, () =>
                    show({ variant: "error", title: t("schoolLicense.common.loadError") }),
                  )
                }
              >
                {t("schoolLicense.invoice.open")}
              </Button>
            </Table.Cell>
          </Table.Row>
        ))}
      </Table.Body>
    </Table>
  );
}
