import { Table } from "@studafy/ui";
import { Link } from "react-router-dom";

import { useFormatters, useTranslation } from "../../lib/i18n";
import { useMoney } from "../platform/licensing/format";

import { LicenseHeader } from "./LicenseHeader";
import { useQuotesQuery } from "./queries";

import type { Quote } from "./queries";

import "./license.css";

const QUOTE_TONE: Record<Quote["status"], "success" | "warning" | "neutral"> = {
  draft: "neutral",
  sent: "warning",
  accepted: "success",
  expired: "neutral",
  withdrawn: "neutral",
};

export function QuoteStatusPill({ status }: { status: Quote["status"] }) {
  const { t } = useTranslation();
  return (
    <span className="license-pill" data-tone={QUOTE_TONE[status]}>
      {t(`schoolLicense.quoteStatus.${status}`)}
    </span>
  );
}

/**
 * The school's quotes (`/portal/license/quotes`): what Studafy sent, accepted and expired ones
 * included. A quote opens on its own page with the full breakdown, where it can be accepted.
 */
export default function QuotesPage() {
  const { t } = useTranslation();
  const { formatDate } = useFormatters();
  const money = useMoney();
  const quotes = useQuotesQuery();
  const date = (iso: string) => formatDate(new Date(iso), { dateStyle: "medium" });

  return (
    <>
      <LicenseHeader
        title={t("schoolLicense.quotes.title")}
        description={t("schoolLicense.quotes.description")}
      />
      <Table caption={t("schoolLicense.quotes.title")} hideCaption>
        <Table.Header>
          <Table.Row>
            <Table.HeaderCell>{t("schoolLicense.quotes.columns.quote")}</Table.HeaderCell>
            <Table.HeaderCell>{t("schoolLicense.quotes.columns.period")}</Table.HeaderCell>
            <Table.HeaderCell>{t("schoolLicense.quotes.columns.total")}</Table.HeaderCell>
            <Table.HeaderCell>{t("schoolLicense.quotes.columns.validUntil")}</Table.HeaderCell>
            <Table.HeaderCell>{t("schoolLicense.quotes.columns.status")}</Table.HeaderCell>
          </Table.Row>
        </Table.Header>
        <Table.Body
          columnCount={5}
          loading={quotes.isPending}
          empty={
            quotes.isError ? t("schoolLicense.common.loadError") : t("schoolLicense.quotes.empty")
          }
        >
          {(quotes.data ?? []).map((quote) => (
            <Table.Row key={quote.id}>
              <Table.Cell>
                <Link to={`/portal/license/quotes/${quote.id}`}>
                  {t(`schoolLicense.quoteKind.${quote.kind}`)}
                </Link>
                <div className="license-muted">{date(quote.sentAt ?? quote.createdAt)}</div>
              </Table.Cell>
              <Table.Cell>
                {t("schoolLicense.overview.periodValue", {
                  from: date(quote.startsAt),
                  to: date(quote.endsAt),
                })}
              </Table.Cell>
              <Table.Cell>
                <span className="license-amount">
                  {money(quote.totalMinor, quote.currencyCode, quote.minorUnit)}
                </span>
              </Table.Cell>
              <Table.Cell>{date(quote.validUntil)}</Table.Cell>
              <Table.Cell>
                <QuoteStatusPill status={quote.status} />
              </Table.Cell>
            </Table.Row>
          ))}
        </Table.Body>
      </Table>
    </>
  );
}
