import { Button, Card } from "@studafy/ui";

import { useFormatters, useTranslation } from "../../lib/i18n";
import { useMoney } from "../platform/licensing/format";

import { useStorageBillingQuery } from "./storage";
import { formatStorage } from "./storage-format";

import type { StorageCurrent, StorageInvoice } from "./storage";

import "./license-tables.css";

interface Props {
  current: StorageCurrent;
  includedBytes: number;
  busy: boolean;
  cancelling: boolean;
  undoing: boolean;
  openingCard: boolean;
  onCancel: () => void;
  onResume: () => void;
  onUndoChange: () => void;
  onUpdateCard: () => void;
}

/** "Payment", "Change to 1 TB", ... : what an invoice was for, in the school's words. */
function invoiceReasonKey(invoice: StorageInvoice): string {
  switch (invoice.billingReason) {
    case "subscription_create":
      return "schoolLicense.storage.manage.reason.create";
    case "subscription_cycle":
      return "schoolLicense.storage.manage.reason.cycle";
    case "subscription_update":
      return "schoolLicense.storage.manage.reason.update";
    default:
      return "schoolLicense.storage.manage.reason.other";
  }
}

/**
 * The school's storage subscription, the way an app store shows one: the plan and when it renews or
 * ends, a change waiting for the renewal (with a way to undo it), the next bill, the card it is paid
 * with (replaced on the payment provider's own page), cancel or resume, and every bill with its
 * receipt. Shown to license:manage only.
 */
export function StorageManageCard({
  current,
  includedBytes,
  busy,
  cancelling,
  undoing,
  openingCard,
  onCancel,
  onResume,
  onUndoChange,
  onUpdateCard,
}: Props) {
  const { t } = useTranslation();
  const { formatDate, formatNumber } = useFormatters();
  const money = useMoney();
  const billing = useStorageBillingQuery(true);
  const size = (bytes: number) => formatStorage(bytes, t, formatNumber);
  const date = (iso: string) => formatDate(new Date(iso), { dateStyle: "medium" });
  const priceLabel = (price: NonNullable<StorageCurrent["price"]>) =>
    t(
      price.interval === "yearly"
        ? "schoolLicense.storage.pricePerYear"
        : "schoolLicense.storage.pricePerMonth",
      { price: money(price.amountMinor, price.currency) },
    );

  const pending = current.pendingChange;
  const method = billing.data?.paymentMethod ?? null;
  const nextBill = billing.data?.nextBill ?? null;
  const invoices = billing.data?.invoices ?? [];

  return (
    <Card as="section" aria-labelledby="storage-manage-title">
      <Card.Body>
        <h2 id="storage-manage-title" className="storage-heading">
          {t("schoolLicense.storage.manage.title")}
        </h2>

        <dl className="storage-manage">
          <div>
            <dt>{t("schoolLicense.storage.manage.plan")}</dt>
            <dd>
              {current.price
                ? t("schoolLicense.storage.manage.planValue", {
                    size: size(current.capBytes),
                    price: priceLabel(current.price),
                  })
                : size(current.capBytes)}
            </dd>
          </div>
          <div>
            <dt>
              {t(
                current.cancelAtPeriodEnd
                  ? "schoolLicense.storage.manage.ends"
                  : "schoolLicense.storage.manage.renews",
              )}
            </dt>
            <dd>{date(current.currentPeriodEnd)}</dd>
          </div>
          {!current.cancelAtPeriodEnd ? (
            <div>
              <dt>{t("schoolLicense.storage.manage.nextBill")}</dt>
              <dd data-testid="storage-next-bill">
                {billing.isPending
                  ? t("schoolLicense.common.loading")
                  : nextBill
                    ? t("schoolLicense.storage.manage.nextBillValue", {
                        amount: money(nextBill.amountMinor, nextBill.currency),
                        date: date(nextBill.at),
                      })
                    : "—"}
              </dd>
            </div>
          ) : null}
          <div>
            <dt>{t("schoolLicense.storage.manage.paymentMethod")}</dt>
            <dd data-testid="storage-payment-method">
              {billing.isPending
                ? t("schoolLicense.common.loading")
                : method
                  ? t(
                      method.last4
                        ? "schoolLicense.storage.manage.cardValue"
                        : "schoolLicense.storage.manage.methodValue",
                      {
                        brand: method.brand.charAt(0).toUpperCase() + method.brand.slice(1),
                        last4: method.last4,
                        month: String(method.expMonth ?? "").padStart(2, "0"),
                        year: method.expYear,
                      },
                    )
                  : t("schoolLicense.storage.manage.noMethod")}
            </dd>
          </div>
        </dl>

        {pending ? (
          <div className="license-banner" data-tone="neutral" role="status">
            <div>
              <p className="license-banner__title">
                {t("schoolLicense.storage.manage.pendingTitle", {
                  size: size(pending.capBytes),
                  date: date(pending.effectiveAt),
                })}
              </p>
              <p className="license-banner__body">
                {t("schoolLicense.storage.manage.pendingBody", {
                  current: size(current.capBytes),
                  date: date(pending.effectiveAt),
                  price: pending.price ? priceLabel(pending.price) : "",
                })}
              </p>
            </div>
            <Button
              type="button"
              variant="secondary"
              loading={undoing}
              disabled={busy}
              onClick={onUndoChange}
            >
              {t("schoolLicense.storage.manage.undoChange", { size: size(current.capBytes) })}
            </Button>
          </div>
        ) : null}

        {current.cancelAtPeriodEnd ? (
          <p className="license-muted">
            {t("schoolLicense.storage.currentEnding", {
              size: size(current.capBytes),
              date: date(current.currentPeriodEnd),
              included: size(includedBytes),
            })}
          </p>
        ) : null}

        <div className="storage-manage__actions">
          <Button
            type="button"
            variant="secondary"
            loading={openingCard}
            disabled={busy}
            onClick={onUpdateCard}
          >
            {t("schoolLicense.storage.manage.updateCard")}
          </Button>
          {current.cancelAtPeriodEnd ? (
            <Button
              type="button"
              variant="primary"
              loading={cancelling}
              disabled={busy}
              onClick={onResume}
            >
              {t("schoolLicense.storage.manage.resume")}
            </Button>
          ) : (
            <Button
              type="button"
              variant="secondary"
              loading={cancelling}
              disabled={busy}
              onClick={onCancel}
            >
              {t("schoolLicense.storage.manage.cancel")}
            </Button>
          )}
        </div>

        <h3 className="storage-heading">{t("schoolLicense.storage.manage.historyTitle")}</h3>
        {billing.isError ? (
          <p role="alert">{t("schoolLicense.storage.manage.historyError")}</p>
        ) : billing.isPending ? (
          <p role="status">{t("schoolLicense.common.loading")}</p>
        ) : invoices.length === 0 ? (
          <p className="license-muted">{t("schoolLicense.storage.manage.historyEmpty")}</p>
        ) : (
          <div className="license-table-scroll">
            <table className="license-table">
              <caption className="sf-visually-hidden">
                {t("schoolLicense.storage.manage.historyTitle")}
              </caption>
              <thead>
                <tr>
                  <th scope="col">{t("schoolLicense.storage.manage.columns.date")}</th>
                  <th scope="col">{t("schoolLicense.storage.manage.columns.for")}</th>
                  <th scope="col">{t("schoolLicense.storage.manage.columns.amount")}</th>
                  <th scope="col">{t("schoolLicense.storage.manage.columns.status")}</th>
                  <th scope="col">{t("schoolLicense.storage.manage.columns.receipt")}</th>
                </tr>
              </thead>
              <tbody>
                {invoices.map((invoice) => (
                  <tr key={invoice.id}>
                    <td>{date(invoice.created)}</td>
                    <td>{t(invoiceReasonKey(invoice))}</td>
                    <td>
                      {money(invoice.amountPaidMinor || invoice.amountDueMinor, invoice.currency)}
                      {invoice.amountRefundedMinor > 0 ? (
                        <span className="license-muted">
                          {" "}
                          {t("schoolLicense.storage.manage.refunded", {
                            amount: money(invoice.amountRefundedMinor, invoice.currency),
                          })}
                        </span>
                      ) : null}
                    </td>
                    <td>
                      {t(
                        `schoolLicense.storage.manage.status.${
                          ["paid", "open", "void", "uncollectible"].includes(invoice.status ?? "")
                            ? invoice.status
                            : "other"
                        }`,
                      )}
                    </td>
                    <td>
                      {invoice.hostedInvoiceUrl ? (
                        <a
                          href={invoice.hostedInvoiceUrl}
                          target="_blank"
                          rel="noopener noreferrer"
                        >
                          {t("schoolLicense.storage.manage.receipt")}
                        </a>
                      ) : (
                        "—"
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card.Body>
    </Card>
  );
}
