import { ApiError } from "@studafy/api-client";
import { Button, Card, Input, useToast } from "@studafy/ui";
import { useState } from "react";
import { Link, useParams } from "react-router-dom";

import { useFormatters, useTranslation } from "../../../lib/i18n";
import { ShareStatusPill, StatRow, useDay, usePercent } from "../../ai-programme/components";
import {
  useApproveStatement,
  useHoldStatement,
  usePlatformStatementQuery,
  useRejectStatement,
} from "../../ai-programme/queries";
import { PlatformPageHeader } from "../PlatformNav";

import { StatementStatusPill } from "./AiProgrammeStatementsPage";
import { useMoney } from "./format";

import type { StatItem } from "../../ai-programme/components";
import type { RevenueShareStatus, StatementDetail } from "../../ai-programme/queries";

import "../platform.css";
import "./licensing.css";

const P = "platformLicensing.statements";

function errorText(error: unknown): string | undefined {
  return error instanceof ApiError ? (error.detail ?? error.title) : undefined;
}

/**
 * One Student AI weekly statement
 * (`/portal/platform/ai-programme/statements/:schoolId/:statementId`, platform:read; deciding
 * platform:manage): what the school owes Studafy for the opt-in months it collected that week, its
 * share on them and the net; each student's months; the licence shares it lists. Waiting (or
 * held), it is approved -- Studafy bills the net, and the months are activated once the school pays
 * -- held with a note, or rejected with a reason.
 */
export default function AiProgrammeStatementPage() {
  const { t } = useTranslation();
  const { schoolId = "", statementId = "" } = useParams();
  const statement = usePlatformStatementQuery(schoolId, statementId);
  const day = useDay();

  return (
    <>
      <PlatformPageHeader
        title={
          statement.data
            ? t(`${P}.detailTitle`, { week: day(statement.data.weekStart) })
            : t(`${P}.title`)
        }
      />
      <p>
        <Link to="/portal/platform/ai-programme/statements">{t(`${P}.back`)}</Link>
        {" · "}
        <Link to={`/portal/platform/ai-programme/schools/${schoolId}`}>{t(`${P}.schoolLink`)}</Link>
      </p>
      {statement.isPending ? <p role="status">{t("site.common.loading")}</p> : null}
      {statement.isError ? <p role="alert">{t("platformLicensing.common.loadError")}</p> : null}
      {statement.data ? <Statement statement={statement.data} /> : null}
    </>
  );
}

function Statement({ statement }: { statement: StatementDetail }) {
  const { t } = useTranslation();
  const { formatDate, formatNumber } = useFormatters();
  const money = useMoney();
  const day = useDay();
  const pct = usePercent();
  const amount = (minor: number) => money(minor, statement.currencyCode, statement.minorUnit);
  const undecided = statement.status === "awaiting_approval" || statement.status === "held";

  const stats: StatItem[] = [
    { key: "months", label: t(`${P}.stats.months`), value: formatNumber(statement.monthsCount) },
    { key: "gross", label: t(`${P}.stats.gross`), value: amount(statement.grossMinor) },
    { key: "share", label: t(`${P}.stats.share`), value: amount(statement.shareMinor) },
    { key: "net", label: t(`${P}.stats.net`), value: amount(statement.netMinor) },
    {
      key: "licence-shares",
      label: t(`${P}.stats.licenceShares`),
      value: amount(statement.licenceShareMinor),
    },
  ];

  return (
    <>
      <p>
        <StatementStatusPill status={statement.status} />{" "}
        {statement.decisionNote ? (
          <span data-testid="decision-note">{statement.decisionNote}</span>
        ) : null}
        {statement.invoiceNumber ? (
          <span data-testid="statement-invoice">
            {" "}
            {t(`${P}.invoice`, { number: statement.invoiceNumber })}
          </span>
        ) : null}
      </p>
      <StatRow items={stats} label={t(`${P}.statsLabel`)} />

      {undecided ? <Decision statement={statement} amount={amount} /> : null}

      <section className="aip-section" aria-labelledby="statement-months">
        <h2 id="statement-months">{t(`${P}.monthsTitle`)}</h2>
        {statement.months.length === 0 ? (
          <p className="platform-muted">{t(`${P}.noMonths`)}</p>
        ) : (
          <div className="platform-table-scroll">
            <table className="platform-table" data-testid="statement-months">
              <thead>
                <tr>
                  <th scope="col">{t(`${P}.columns.student`)}</th>
                  <th scope="col">{t(`${P}.columns.month`)}</th>
                  <th scope="col">{t(`${P}.columns.collectedOn`)}</th>
                  <th scope="col" className="licensing-amount">
                    {t(`${P}.columns.price`)}
                  </th>
                  <th scope="col" className="licensing-amount">
                    {t(`${P}.columns.share`)}
                  </th>
                  <th scope="col">{t(`${P}.columns.status`)}</th>
                </tr>
              </thead>
              <tbody>
                {statement.months.map((m) => (
                  <tr key={m.id}>
                    <th scope="row">{m.studentName}</th>
                    <td>
                      {formatDate(new Date(`${m.month}T00:00:00Z`), {
                        month: "long",
                        year: "numeric",
                        timeZone: "UTC",
                      })}
                    </td>
                    <td>{day(m.collectedOn)}</td>
                    <td className="licensing-amount">{amount(m.priceMinor)}</td>
                    <td className="licensing-amount">
                      {m.shareMinor === null
                        ? "—"
                        : `${amount(m.shareMinor)} (${pct(m.shareBps ?? 0)})`}
                    </td>
                    <td>{t(`${P}.monthStatus.${m.status}`)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      <section className="aip-section" aria-labelledby="statement-shares">
        <h2 id="statement-shares">{t(`${P}.sharesTitle`)}</h2>
        {statement.shares.length === 0 ? (
          <p className="platform-muted">{t(`${P}.noShares`)}</p>
        ) : (
          <div className="platform-table-scroll">
            <table className="platform-table" data-testid="statement-shares">
              <thead>
                <tr>
                  <th scope="col">{t(`${P}.columns.invoice`)}</th>
                  <th scope="col">{t(`${P}.columns.period`)}</th>
                  <th scope="col" className="licensing-amount">
                    {t(`${P}.columns.rate`)}
                  </th>
                  <th scope="col" className="licensing-amount">
                    {t(`${P}.columns.share`)}
                  </th>
                  <th scope="col">{t(`${P}.columns.status`)}</th>
                </tr>
              </thead>
              <tbody>
                {statement.shares.map((share) => (
                  <tr key={share.id}>
                    <th scope="row">{share.invoiceNumber}</th>
                    <td>
                      {day(share.periodFrom)} – {day(share.periodTo)}
                    </td>
                    <td className="licensing-amount">{pct(share.totalBps)}</td>
                    <td className="licensing-amount">{amount(share.amountMinor)}</td>
                    <td>
                      <ShareStatusPill status={share.status as RevenueShareStatus} />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>
    </>
  );
}

function Decision({
  statement,
  amount,
}: {
  statement: StatementDetail;
  amount: (minor: number) => string;
}) {
  const { t } = useTranslation();
  const { show } = useToast();
  const approve = useApproveStatement();
  const hold = useHoldStatement();
  const reject = useRejectStatement();
  const [note, setNote] = useState("");
  const path = { schoolId: statement.schoolId, statementId: statement.id };
  const failed = (error: unknown) =>
    show({
      variant: "error",
      title: t("platformLicensing.common.saveError"),
      description: errorText(error),
    });
  const busy = approve.isPending || hold.isPending || reject.isPending;

  return (
    <Card as="section" aria-labelledby="statement-decision">
      <Card.Body>
        <h2 id="statement-decision">{t(`${P}.decisionTitle`)}</h2>
        <p data-testid="approve-explainer">
          {t(`${P}.approveExplainer`, {
            net: amount(statement.netMinor),
            shares: amount(statement.licenceShareMinor),
          })}
        </p>
        <div className="aip-form">
          <Input
            label={t(`${P}.note`)}
            helperText={t(`${P}.noteHint`)}
            value={note}
            maxLength={1000}
            onChange={(event) => setNote(event.target.value)}
          />
          <div className="licensing-row">
            <Button
              variant="primary"
              loading={approve.isPending}
              disabled={busy}
              onClick={() =>
                approve.mutate(
                  {
                    ...path,
                    expectedNetMinor: statement.netMinor,
                    expectedLicenceShareMinor: statement.licenceShareMinor,
                  },
                  {
                    onSuccess: () => show({ variant: "success", title: t(`${P}.approved`) }),
                    onError: failed,
                  },
                )
              }
            >
              {t(`${P}.approve`)}
            </Button>
            <Button
              variant="secondary"
              loading={hold.isPending}
              disabled={busy || note.trim() === ""}
              onClick={() =>
                hold.mutate(
                  { ...path, note: note.trim() },
                  {
                    onSuccess: () => {
                      setNote("");
                      show({ variant: "success", title: t(`${P}.held`) });
                    },
                    onError: failed,
                  },
                )
              }
            >
              {t(`${P}.hold`)}
            </Button>
            <Button
              variant="tertiary"
              loading={reject.isPending}
              disabled={busy || note.trim() === ""}
              onClick={() =>
                reject.mutate(
                  { ...path, reason: note.trim() },
                  {
                    onSuccess: () => {
                      setNote("");
                      show({ variant: "success", title: t(`${P}.rejected`) });
                    },
                    onError: failed,
                  },
                )
              }
            >
              {t(`${P}.reject`)}
            </Button>
          </div>
        </div>
      </Card.Body>
    </Card>
  );
}
