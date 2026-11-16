import { ApiError } from "@studafy/api-client";
import { Button, Card, Input, Modal, useToast } from "@studafy/ui";
import { useRef, useState } from "react";

import { useFormatters, useTranslation } from "../../../lib/i18n";
import { formatStorage } from "../../license/storage-format";
import { currencyMinorUnit, fromMinor, toMinor, useMoney } from "../licensing/format";

import { usePlatformStorageQuery, useRefundStorageInvoice } from "./queries";

import type { PlatformStorageInvoice } from "./queries";

/**
 * A school's storage add-on on its platform page: the plan, any change waiting for its renewal, the
 * card, every Stripe invoice with what it took and what was refunded, the overcharges refunded
 * automatically, and a refund of one invoice (full or partial, with a reason).
 */
export function SchoolStorageCard({ schoolId }: { schoolId: string }) {
  const { t } = useTranslation();
  const { formatDate, formatNumber } = useFormatters();
  const money = useMoney();
  const storage = usePlatformStorageQuery(schoolId);
  const [refunding, setRefunding] = useState<PlatformStorageInvoice | null>(null);
  const size = (bytes: number) => formatStorage(bytes, t, formatNumber);
  const date = (iso: string) => formatDate(new Date(iso), { dateStyle: "medium" });

  const data = storage.data;
  const sub = data?.subscription ?? null;

  return (
    <Card as="section" aria-labelledby="platform-storage-title">
      <Card.Header>
        <h2 id="platform-storage-title">{t("platform.storage.title")}</h2>
      </Card.Header>
      <Card.Body>
        {storage.isPending ? (
          <p role="status">{t("site.common.loading")}</p>
        ) : storage.isError || !data ? (
          <p role="alert">{t("platform.storage.loadError")}</p>
        ) : !sub ? (
          <p className="platform-muted">{t("platform.storage.none")}</p>
        ) : (
          <>
            <ul className="platform-cell-stack">
              <li>
                {t("platform.storage.plan", {
                  size: size(sub.capBytes),
                  status: sub.status,
                  price: sub.price ? money(sub.price.amountMinor, sub.price.currency) : "—",
                  interval: sub.price ? t(`platform.storage.interval.${sub.price.interval}`) : "",
                })}
              </li>
              <li>
                {t(sub.cancelAtPeriodEnd ? "platform.storage.ends" : "platform.storage.renews", {
                  date: date(sub.currentPeriodEnd),
                })}
              </li>
              {sub.pendingChange ? (
                <li>
                  {t("platform.storage.pending", {
                    size: size(sub.pendingChange.capBytes),
                    date: date(sub.pendingChange.effectiveAt),
                  })}
                </li>
              ) : null}
              {sub.stripeSubscriptionId ? (
                <li className="platform-muted">
                  <code>{sub.stripeSubscriptionId}</code>
                </li>
              ) : null}
              {data.billing?.paymentMethod ? (
                <li>
                  {t("platform.storage.card", {
                    brand: data.billing.paymentMethod.brand,
                    last4: data.billing.paymentMethod.last4 ?? "—",
                  })}
                </li>
              ) : null}
            </ul>

            {data.billingError ? (
              <p role="alert">{t("platform.storage.billingError", { error: data.billingError })}</p>
            ) : null}

            {data.incidents.length > 0 ? (
              <>
                <h3>{t("platform.storage.incidentsTitle")}</h3>
                <ul>
                  {data.incidents.map((incident) => (
                    <li key={incident.id}>
                      {t(
                        incident.status === "refunded"
                          ? "platform.storage.incidentRefunded"
                          : "platform.storage.incidentReview",
                        {
                          date: date(incident.createdAt),
                          charged: money(incident.chargedMinor, incident.currency),
                          expected: money(incident.expectedMinor, incident.currency),
                          refund: money(incident.refundMinor, incident.currency),
                        },
                      )}
                    </li>
                  ))}
                </ul>
              </>
            ) : null}

            <h3>{t("platform.storage.invoicesTitle")}</h3>
            {!data.billing || data.billing.invoices.length === 0 ? (
              <p className="platform-muted">{t("platform.storage.noInvoices")}</p>
            ) : (
              <div className="platform-table-scroll">
                <table className="platform-table">
                  <caption className="sf-visually-hidden">
                    {t("platform.storage.invoicesTitle")}
                  </caption>
                  <thead>
                    <tr>
                      <th scope="col">{t("platform.storage.columns.date")}</th>
                      <th scope="col">{t("platform.storage.columns.reason")}</th>
                      <th scope="col">{t("platform.storage.columns.paid")}</th>
                      <th scope="col">{t("platform.storage.columns.refunded")}</th>
                      <th scope="col">{t("platform.storage.columns.status")}</th>
                      <th scope="col">{t("platform.storage.columns.actions")}</th>
                    </tr>
                  </thead>
                  <tbody>
                    {data.billing.invoices.map((invoice) => {
                      const refundable = invoice.amountPaidMinor - invoice.amountRefundedMinor;
                      return (
                        <tr key={invoice.id}>
                          <td>{date(invoice.created)}</td>
                          <td>
                            <code>{invoice.billingReason ?? "—"}</code>
                          </td>
                          <td>{money(invoice.amountPaidMinor, invoice.currency)}</td>
                          <td>
                            {invoice.amountRefundedMinor > 0
                              ? money(invoice.amountRefundedMinor, invoice.currency)
                              : "—"}
                          </td>
                          <td>{invoice.status ?? "—"}</td>
                          <td>
                            <div className="platform-actions">
                              {invoice.hostedInvoiceUrl ? (
                                <a
                                  href={invoice.hostedInvoiceUrl}
                                  target="_blank"
                                  rel="noopener noreferrer"
                                >
                                  {t("platform.storage.view")}
                                </a>
                              ) : null}
                              {refundable > 0 ? (
                                <Button
                                  type="button"
                                  variant="secondary"
                                  onClick={() => setRefunding(invoice)}
                                >
                                  {t("platform.storage.refund")}
                                </Button>
                              ) : null}
                            </div>
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            )}
          </>
        )}
      </Card.Body>
      {refunding ? (
        <RefundDialog schoolId={schoolId} invoice={refunding} onClose={() => setRefunding(null)} />
      ) : null}
    </Card>
  );
}

function RefundDialog({
  schoolId,
  invoice,
  onClose,
}: {
  schoolId: string;
  invoice: PlatformStorageInvoice;
  onClose: () => void;
}) {
  const { t } = useTranslation();
  const money = useMoney();
  const { show } = useToast();
  const refund = useRefundStorageInvoice(schoolId);
  const minorUnit = currencyMinorUnit(invoice.currency);
  const refundable = invoice.amountPaidMinor - invoice.amountRefundedMinor;
  const [amount, setAmount] = useState(fromMinor(refundable, minorUnit));
  const [reason, setReason] = useState("");
  // One key for this dialog: a double click, or a retry after a timeout, refunds once.
  const [requestKey] = useState(() => crypto.randomUUID());
  const inFlight = useRef(false);

  const amountMinor = toMinor(amount, minorUnit);
  const amountValid = amountMinor !== null && amountMinor > 0 && amountMinor <= refundable;
  const valid = amountValid && reason.trim().length >= 3;

  function submit() {
    if (!valid || amountMinor === null || inFlight.current) return;
    inFlight.current = true;
    refund.mutate(
      { invoiceId: invoice.id, amountMinor, reason: reason.trim(), requestKey },
      {
        onSuccess: () => {
          inFlight.current = false;
          show({
            variant: "success",
            title: t("platform.storage.refunded", {
              amount: money(amountMinor, invoice.currency),
            }),
          });
          onClose();
        },
        onError: (error) => {
          inFlight.current = false;
          show({
            variant: "error",
            title: t("platform.storage.refundError"),
            description: error instanceof ApiError ? (error.detail ?? error.title) : undefined,
          });
        },
      },
    );
  }

  return (
    <Modal
      open
      onClose={() => (refund.isPending ? undefined : onClose())}
      title={t("platform.storage.refundTitle")}
    >
      <Modal.Body>
        <p>
          {t("platform.storage.refundHelp", {
            paid: money(invoice.amountPaidMinor, invoice.currency),
            refundable: money(refundable, invoice.currency),
          })}
        </p>
        <Input
          label={t("platform.storage.amountLabel", { currency: invoice.currency })}
          value={amount}
          onChange={(event) => setAmount(event.target.value)}
          error={amount !== "" && !amountValid ? t("platform.storage.amountError") : undefined}
        />
        <Input
          label={t("platform.storage.reasonLabel")}
          value={reason}
          onChange={(event) => setReason(event.target.value)}
        />
      </Modal.Body>
      <Modal.Footer>
        <Button type="button" variant="tertiary" disabled={refund.isPending} onClick={onClose}>
          {t("platform.common.cancel")}
        </Button>
        <Button
          type="button"
          variant="primary"
          loading={refund.isPending}
          disabled={!valid}
          onClick={submit}
        >
          {amountMinor !== null && amountValid
            ? t("platform.storage.refundConfirm", {
                amount: money(amountMinor, invoice.currency),
              })
            : t("platform.storage.refund")}
        </Button>
      </Modal.Footer>
    </Modal>
  );
}
