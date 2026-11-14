import { ApiError } from "@studafy/api-client";
import { PERMISSIONS } from "@studafy/constants";
import { Button, Input, Modal, Table, useToast } from "@studafy/ui";
import { useState } from "react";
import { useNavigate, useParams } from "react-router-dom";

import { usePermissions } from "../../lib/auth";
import { useFormatters, useTranslation } from "../../lib/i18n";
import { bpsToPercent, useMoney } from "../platform/licensing/format";

import { LicenseHeader } from "./LicenseHeader";
import { useAcceptQuote, useDeclineQuote } from "./mutations";
import { PaymentSchedule } from "./PaymentSchedule";
import { useQuoteQuery } from "./queries";
import { QuoteStatusPill } from "./QuotesPage";

import type { PriceLine, Quote } from "./queries";
import type { ReactNode } from "react";

import "./license.css";

type SeatLine = Extract<PriceLine, { kind: "seats" }>;

/**
 * One quote (`/portal/license/quotes/:quoteId`): the full breakdown Studafy priced -- list price per
 * audience, volume and duration discounts, credits for people who already paid personally, any
 * adjustment, the total and what the school saves. `license:manage` accepts a sent quote that has
 * not expired; that applies it to the license and issues the invoice, which opens next. It can also
 * decline it instead, with an optional reason Studafy reads before pricing a new one.
 */
export default function QuoteDetailPage() {
  const { t } = useTranslation();
  const { formatDate } = useFormatters();
  const { quoteId = "" } = useParams();
  const quote = useQuoteQuery(quoteId);
  const canManage = usePermissions().has(PERMISSIONS.LICENSE_MANAGE);
  const [confirming, setConfirming] = useState(false);
  const [declining, setDeclining] = useState(false);
  const data = quote.data;
  const acceptable =
    data !== undefined && data.status === "sent" && Date.parse(data.validUntil) > Date.now();

  return (
    <>
      <LicenseHeader
        title={
          data
            ? t("schoolLicense.quote.title", { kind: t(`schoolLicense.quoteKind.${data.kind}`) })
            : t("schoolLicense.quotes.title")
        }
        actions={
          canManage && acceptable ? (
            <>
              <Button variant="secondary" onClick={() => setDeclining(true)}>
                {t("schoolLicense.quote.decline")}
              </Button>
              <Button variant="primary" onClick={() => setConfirming(true)}>
                {t("schoolLicense.quote.accept")}
              </Button>
            </>
          ) : null
        }
      />
      {quote.isPending ? <p role="status">{t("schoolLicense.common.loading")}</p> : null}
      {quote.isError ? <p role="alert">{t("schoolLicense.common.loadError")}</p> : null}
      {data ? (
        <>
          <dl className="license-facts">
            <div>
              <dt>{t("schoolLicense.quotes.columns.status")}</dt>
              <dd>
                <QuoteStatusPill status={data.status} />
              </dd>
            </div>
            <div>
              <dt>{t("schoolLicense.quotes.columns.period")}</dt>
              <dd>
                {t("schoolLicense.overview.periodValue", {
                  from: formatDate(new Date(data.startsAt), { dateStyle: "medium" }),
                  to: formatDate(new Date(data.endsAt), { dateStyle: "medium" }),
                })}
              </dd>
            </div>
            <div>
              <dt>{t("schoolLicense.quotes.columns.validUntil")}</dt>
              <dd>{formatDate(new Date(data.validUntil), { dateStyle: "medium" })}</dd>
            </div>
          </dl>
          {data.notes ? <p className="license-note">{data.notes}</p> : null}
          {data.status === "declined" ? (
            <p className="license-note" data-testid="quote-declined">
              {data.declineReason
                ? t("schoolLicense.quote.declinedWithReason", { reason: data.declineReason })
                : t("schoolLicense.quote.declinedNote")}
            </p>
          ) : null}
          <QuoteBreakdown quote={data} />
          <QuoteSchedule quote={data} />
        </>
      ) : null}
      {data && confirming ? (
        <AcceptModal quote={data} onClose={() => setConfirming(false)} />
      ) : null}
      {data && declining ? <DeclineModal quote={data} onClose={() => setDeclining(false)} /> : null}
    </>
  );
}

/** How the quote is to be paid, and when: the invoice's instalments if it were accepted today. */
function QuoteSchedule({ quote }: { quote: Quote }) {
  const { t } = useTranslation();
  const title = t("schoolLicense.schedule.title");
  return (
    <section className="license-section" aria-labelledby="quote-schedule">
      <h2 id="quote-schedule">{title}</h2>
      <p>
        {t(`schoolLicense.schedule.plan.${quote.paymentPlan}`, {
          count: quote.schedulePreview.length,
        })}
      </p>
      {quote.schedulePreview.length > 1 ? (
        <>
          <PaymentSchedule
            rows={quote.schedulePreview}
            currencyCode={quote.currencyCode}
            minorUnit={quote.minorUnit}
            caption={title}
          />
          {quote.status === "sent" ? (
            <p className="license-muted">{t("schoolLicense.schedule.previewNote")}</p>
          ) : null}
        </>
      ) : null}
      <p className="license-muted">{t("schoolLicense.schedule.activationNote")}</p>
    </section>
  );
}

export function QuoteBreakdown({ quote }: { quote: Quote }) {
  const { t } = useTranslation();
  const { formatNumber } = useFormatters();
  const money = useMoney();
  const m = (amount: number) => money(amount, quote.currencyCode, quote.minorUnit);
  const { breakdown } = quote;

  const rows: { key: string; label: ReactNode; amount: string }[] = [];
  breakdown.lines.forEach((line, index) => {
    if (line.kind === "seats") {
      const seat = line as SeatLine;
      const audience = t(`schoolLicense.audience.${seat.audience}`);
      rows.push({
        key: `${index}-list`,
        label: (
          <>
            {t("schoolLicense.quote.seatLine", {
              tier: seat.tierName,
              seats: formatNumber(seat.seats),
              audience,
            })}
            <div className="license-muted">
              {seat.prorateDays
                ? t("schoolLicense.quote.forDays", { count: seat.prorateDays })
                : t("schoolLicense.quote.forMonths", { count: seat.months })}
              {" · "}
              {t("schoolLicense.quote.perSeat", {
                before: m(seat.listPricePerSeatMonthMinor),
                after: m(seat.pricePerSeatMonthMinor),
              })}
            </div>
          </>
        ),
        amount: m(seat.listAmountMinor),
      });
      if (seat.volumeDiscountMinor > 0) {
        rows.push({
          key: `${index}-volume`,
          label: t("schoolLicense.quote.volumeDiscount", {
            percent: bpsToPercent(seat.volumeDiscountBps),
          }),
          amount: m(-seat.volumeDiscountMinor),
        });
      }
      if (seat.durationDiscountMinor > 0) {
        rows.push({
          key: `${index}-duration`,
          label: t("schoolLicense.quote.durationDiscount", {
            percent: bpsToPercent(seat.durationDiscountBps),
          }),
          amount: m(-seat.durationDiscountMinor),
        });
      }
    } else if (line.kind === "overlap_credit") {
      rows.push({ key: `${index}-credit`, label: line.description, amount: m(line.amountMinor) });
    } else {
      rows.push({
        key: `${index}-adjustment`,
        label: t("schoolLicense.quote.adjustment", { reason: line.reason }),
        amount: m(line.amountMinor),
      });
    }
  });

  return (
    <section className="license-section" aria-labelledby="quote-breakdown">
      <h2 id="quote-breakdown">{t("schoolLicense.quote.breakdownTitle")}</h2>
      <Table caption={t("schoolLicense.quote.breakdownTitle")} hideCaption>
        <Table.Header>
          <Table.Row>
            <Table.HeaderCell>{t("schoolLicense.quote.columns.item")}</Table.HeaderCell>
            <Table.HeaderCell>{t("schoolLicense.quote.columns.amount")}</Table.HeaderCell>
          </Table.Row>
        </Table.Header>
        <Table.Body columnCount={2}>
          {rows.map((row) => (
            <Table.Row key={row.key}>
              <Table.Cell>{row.label}</Table.Cell>
              <Table.Cell>
                <span className="license-amount">{row.amount}</span>
              </Table.Cell>
            </Table.Row>
          ))}
        </Table.Body>
      </Table>
      <div className="license-totals">
        <div>
          <span className="license-muted">{t("schoolLicense.quote.listTotal")}</span>
          <strong>{m(breakdown.listTotalMinor)}</strong>
        </div>
        <div>
          <span className="license-muted">{t("schoolLicense.quote.discountTotal")}</span>
          <strong>{m(-breakdown.discountTotalMinor)}</strong>
        </div>
        {breakdown.creditTotalMinor > 0 ? (
          <div>
            <span className="license-muted">{t("schoolLicense.quote.creditTotal")}</span>
            <strong>{m(-breakdown.creditTotalMinor)}</strong>
          </div>
        ) : null}
        <div>
          <span className="license-muted">{t("schoolLicense.quote.total")}</span>
          <strong>{m(breakdown.totalMinor)}</strong>
        </div>
      </div>
      {breakdown.savingsMinor > 0 ? (
        <p className="license-savings">
          {t("schoolLicense.quote.youSave", {
            amount: m(breakdown.savingsMinor),
            percent: bpsToPercent(breakdown.savingsBps),
          })}
        </p>
      ) : null}
      {breakdown.creditTotalMinor > 0 ? (
        <p className="license-muted">{t("schoolLicense.quote.creditHelp")}</p>
      ) : null}
    </section>
  );
}

function AcceptModal({ quote, onClose }: { quote: Quote; onClose: () => void }) {
  const { t } = useTranslation();
  const { show } = useToast();
  const navigate = useNavigate();
  const money = useMoney();
  const accept = useAcceptQuote();

  function submit() {
    accept.mutate(quote.id, {
      onSuccess: (result) => {
        show({
          variant: "success",
          title: t("schoolLicense.quote.accepted", { number: result.invoice.number }),
        });
        onClose();
        navigate(`/portal/license/invoices/${result.invoice.id}`);
      },
      onError: (error) =>
        show({
          variant: "error",
          title: t("schoolLicense.quote.acceptError"),
          description: error instanceof ApiError ? (error.detail ?? error.title) : undefined,
        }),
    });
  }

  return (
    <Modal
      open
      onClose={onClose}
      title={t("schoolLicense.quote.acceptTitle")}
      description={t("schoolLicense.quote.acceptBody", {
        total: money(quote.totalMinor, quote.currencyCode, quote.minorUnit),
      })}
    >
      <Modal.Body>
        <p>{t("schoolLicense.quote.acceptHelp")}</p>
      </Modal.Body>
      <Modal.Footer>
        <Button type="button" variant="tertiary" onClick={onClose}>
          {t("schoolLicense.common.cancel")}
        </Button>
        <Button type="button" variant="primary" loading={accept.isPending} onClick={submit}>
          {t("schoolLicense.quote.acceptConfirm")}
        </Button>
      </Modal.Footer>
    </Modal>
  );
}

function DeclineModal({ quote, onClose }: { quote: Quote; onClose: () => void }) {
  const { t } = useTranslation();
  const { show } = useToast();
  const decline = useDeclineQuote();
  const [reason, setReason] = useState("");
  const tooLong = reason.trim().length > 1000;

  function submit() {
    if (decline.isPending || tooLong) return;
    decline.mutate(
      { quoteId: quote.id, reason: reason.trim() || null },
      {
        onSuccess: () => {
          show({ variant: "success", title: t("schoolLicense.quote.declined") });
          onClose();
        },
        onError: (error) =>
          show({
            variant: "error",
            title: t("schoolLicense.quote.declineError"),
            description: error instanceof ApiError ? (error.detail ?? error.title) : undefined,
          }),
      },
    );
  }

  return (
    <Modal
      open
      onClose={onClose}
      title={t("schoolLicense.quote.declineTitle")}
      description={t("schoolLicense.quote.declineBody")}
    >
      <Modal.Body>
        <Input
          label={t("schoolLicense.quote.declineReasonLabel")}
          helperText={t("schoolLicense.quote.declineReasonHelp")}
          value={reason}
          maxLength={1000}
          error={tooLong ? t("schoolLicense.quote.declineReasonTooLong") : undefined}
          onChange={(event) => setReason(event.target.value)}
        />
      </Modal.Body>
      <Modal.Footer>
        <Button type="button" variant="tertiary" onClick={onClose}>
          {t("schoolLicense.common.cancel")}
        </Button>
        <Button
          type="button"
          variant="primary"
          loading={decline.isPending}
          disabled={tooLong}
          onClick={submit}
        >
          {t("schoolLicense.quote.declineConfirm")}
        </Button>
      </Modal.Footer>
    </Modal>
  );
}
