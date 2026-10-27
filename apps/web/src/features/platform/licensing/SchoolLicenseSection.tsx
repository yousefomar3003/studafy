import { ApiError } from "@studafy/api-client";
import { Button, Card, Checkbox, Input, Modal, Select, useToast } from "@studafy/ui";
import { useState } from "react";
import { Link } from "react-router-dom";

import { useFormatters, useTranslation } from "../../../lib/i18n";
import { useSchoolMembersQuery } from "../queries";

import { SchoolQuotes } from "./CalculatorPage";
import { AUDIENCES } from "./constants";
import { useMoney } from "./format";
import { ActivateEarlyModal } from "./InvoicePage";
import { LicenseStatusPill, SeatMeter } from "./LicensesPage";
import { useAssignSeats, useExtendLicense, useLicenseStatus, useUnassignSeat } from "./mutations";
import { InvoiceStatusPill } from "./PaymentsPage";
import { useInvoicesQuery, useLicenseSeatsQuery, useSchoolLicenseConsoleQuery } from "./queries";

import "./licensing.css";

import type {
  InvoiceListItem,
  LicenseAudience,
  LicenseStatus,
  PlatformLicense,
  SchoolLicenseConsole,
} from "./queries";
import type { PlatformMemberRole } from "../queries";

const MEMBER_ROLE: Record<LicenseAudience, PlatformMemberRole> = {
  student: "STUDENT",
  teacher: "INSTRUCTOR",
  parent: "PARENT",
};

/** The status moves offered as buttons, keyed by the target status. */
const MOVES: { to: LicenseStatus; key: string; from?: LicenseStatus }[] = [
  { to: "active", key: "activate", from: "draft" },
  { to: "active", key: "activate", from: "awaiting_payment" },
  { to: "active", key: "resume", from: "suspended" },
  { to: "suspended", key: "suspend" },
  { to: "cancelled", key: "cancel" },
];

/**
 * The license section of the console's school page: the school's current license (tier and seats
 * per audience, Family+, dates, status, balance, this month's usage), what can be done to it, its
 * seats, its quotes, invoices and payments, and the licensing entries of its audit log.
 */
export function SchoolLicenseSection({
  schoolId,
  schoolName,
}: {
  schoolId: string;
  schoolName: string;
}) {
  const { t } = useTranslation();
  const overview = useSchoolLicenseConsoleQuery(schoolId);
  const invoices = useInvoicesQuery({ status: "all", schoolId, from: "", to: "" });
  const license = overview.data?.license ?? null;

  return (
    <section aria-labelledby="school-license" className="platform-stack">
      <div className="platform-header__row">
        <h2 id="school-license">{t("platformLicensing.school.title")}</h2>
        <Link to={`/portal/platform/quotes?schoolId=${schoolId}`}>
          {t("platformLicensing.school.newQuote")}
        </Link>
      </div>
      {overview.isPending ? <p role="status">{t("site.common.loading")}</p> : null}
      {overview.isError ? <p role="alert">{t("platformLicensing.common.loadError")}</p> : null}
      {overview.data && !license ? (
        <p className="platform-muted">{t("platformLicensing.school.noLicense")}</p>
      ) : null}
      {license && overview.data ? (
        <>
          <LicenseSummary
            schoolId={schoolId}
            license={license}
            usage={overview.data.usage}
            invoices={invoices.data ?? []}
          />
          <SeatsCard schoolId={schoolId} schoolName={schoolName} license={license} />
        </>
      ) : null}
      <SchoolQuotes schoolId={schoolId} />
      <InvoicesCard schoolId={schoolId} invoices={invoices.data ?? []} />
      {overview.data ? <PaymentsHistory payments={overview.data.payments} /> : null}
      {overview.data ? <HistoryCard history={overview.data.history} /> : null}
    </section>
  );
}

function LicenseSummary({
  schoolId,
  license,
  usage,
  invoices,
}: {
  schoolId: string;
  license: PlatformLicense;
  usage: SchoolLicenseConsole["usage"];
  invoices: InvoiceListItem[];
}) {
  const { t } = useTranslation();
  const { show } = useToast();
  const { formatDate, formatNumber } = useFormatters();
  const money = useMoney();
  const status = useLicenseStatus();
  const [confirming, setConfirming] = useState<{ to: LicenseStatus; key: string } | null>(null);
  const [extending, setExtending] = useState(false);
  const [early, setEarly] = useState(false);

  const open = invoices.filter(
    (invoice) =>
      invoice.licenseId === license.id &&
      (invoice.status === "issued" || invoice.status === "partially_paid"),
  );
  const balance = open.reduce((sum, invoice) => sum + invoice.balanceMinor, 0);
  const moves = MOVES.filter(
    (move) =>
      license.allowedTransitions.includes(move.to) && (!move.from || move.from === license.status),
  );
  const changeKind =
    license.status === "active" || license.status === "suspended" ? "seat_increase" : "new";

  function confirm() {
    if (!confirming) return;
    status.mutate(
      { schoolId, licenseId: license.id, status: confirming.to },
      {
        onSuccess: () => {
          show({ variant: "success", title: t(`platformLicensing.school.done.${confirming.key}`) });
          setConfirming(null);
        },
        onError: (error) =>
          show({
            variant: "error",
            title: t("platformLicensing.common.saveError"),
            description: error instanceof ApiError ? (error.detail ?? error.title) : undefined,
          }),
      },
    );
  }

  return (
    <Card as="section" aria-labelledby="school-license-summary">
      <Card.Header>
        <div className="platform-header__row">
          <div className="platform-cell-stack">
            <h3 id="school-license-summary">{t("platformLicensing.school.summaryTitle")}</h3>
            <span className="platform-muted">
              {formatDate(new Date(license.startsAt), { dateStyle: "medium" })} –{" "}
              {formatDate(new Date(license.endsAt), { dateStyle: "medium" })}
            </span>
          </div>
          <LicenseStatusPill status={license.status} />
        </div>
      </Card.Header>
      <Card.Body>
        <table className="platform-table">
          <caption className="sf-visually-hidden">
            {t("platformLicensing.school.seatsCaption")}
          </caption>
          <thead>
            <tr>
              <th scope="col">{t("platformLicensing.school.columns.audience")}</th>
              <th scope="col">{t("platformLicensing.school.columns.tier")}</th>
              <th scope="col">{t("platformLicensing.school.columns.seats")}</th>
            </tr>
          </thead>
          <tbody>
            {license.audiences.map((row) => (
              <tr key={row.audience}>
                <td>{t(`platformLicensing.audience.${row.audience}`)}</td>
                <td>{row.tier?.displayName ?? "—"}</td>
                <td>
                  {t("platformLicensing.school.seatsUsed", {
                    assigned: formatNumber(row.assigned),
                    purchased: formatNumber(row.purchased),
                  })}
                  <SeatMeter assigned={row.assigned} purchased={row.purchased} />
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        <dl className="platform-dl">
          <dt>{t("platformLicensing.school.familyPlus")}</dt>
          <dd>
            {license.includeFamilyPlus
              ? t("platform.common.yes")
              : t("platformLicensing.common.no")}
          </dd>
          <dt>{t("platformLicensing.school.currency")}</dt>
          <dd>{license.currencyCode}</dd>
          <dt>{t("platformLicensing.school.balance")}</dt>
          <dd>
            {balance > 0
              ? money(balance, license.currencyCode, open[0]?.minorUnit)
              : t("platformLicensing.school.noBalance")}
          </dd>
        </dl>
        <h4>{t("platformLicensing.school.usageTitle")}</h4>
        <ul className="platform-breakdown" aria-label={t("platformLicensing.school.usageTitle")}>
          {usage.map((row) => (
            <li key={row.feature}>
              <span>
                {t(`platformLicensing.featureName.${row.feature}`, { defaultValue: row.feature })}
              </span>
              <strong>
                {row.unit
                  ? t("platformLicensing.school.usageValue", {
                      used: formatNumber(row.used),
                      unit: t(`platformLicensing.unit.${row.unit}`),
                    })
                  : "—"}
              </strong>
            </li>
          ))}
        </ul>
      </Card.Body>
      <Card.Footer>
        <div
          className="platform-actions"
          role="group"
          aria-label={t("platformLicensing.school.actionsLabel")}
        >
          {moves.map((move) => (
            <Button
              key={`${move.key}-${move.to}`}
              variant={move.key === "activate" || move.key === "resume" ? "primary" : "secondary"}
              onClick={() => setConfirming({ to: move.to, key: move.key })}
            >
              {t(`platformLicensing.school.actions.${move.key}`)}
            </Button>
          ))}
          {open.length > 0 && license.status !== "active" ? (
            <Button variant="secondary" onClick={() => setEarly(true)}>
              {t("platformLicensing.school.actions.activateEarly")}
            </Button>
          ) : null}
          {license.status === "active" || license.status === "suspended" ? (
            <Button variant="secondary" onClick={() => setExtending(true)}>
              {t("platformLicensing.school.actions.extend")}
            </Button>
          ) : null}
          {license.status !== "expired" && license.status !== "cancelled" ? (
            <Link
              to={`/portal/platform/quotes?schoolId=${schoolId}&licenseId=${license.id}&kind=${changeKind}`}
            >
              {t("platformLicensing.school.actions.changeSeats")}
            </Link>
          ) : null}
        </div>
      </Card.Footer>

      <Modal
        open={confirming !== null}
        onClose={() => setConfirming(null)}
        title={confirming ? t(`platformLicensing.school.confirm.${confirming.key}`) : ""}
        description={
          confirming ? t(`platformLicensing.school.confirmHelp.${confirming.key}`) : undefined
        }
      >
        <Modal.Body>
          <p>{t("platformLicensing.school.confirmQuestion")}</p>
        </Modal.Body>
        <Modal.Footer>
          <Button type="button" variant="tertiary" onClick={() => setConfirming(null)}>
            {t("platform.common.cancel")}
          </Button>
          <Button type="button" variant="primary" loading={status.isPending} onClick={confirm}>
            {t("platformLicensing.common.confirm")}
          </Button>
        </Modal.Footer>
      </Modal>
      <ExtendModal
        open={extending}
        schoolId={schoolId}
        license={license}
        onClose={() => setExtending(false)}
      />
      {open[0] ? (
        <ActivateEarlyModal
          open={early}
          invoice={open[0]}
          schoolId={schoolId}
          onClose={() => setEarly(false)}
        />
      ) : null}
    </Card>
  );
}

function ExtendModal({
  open,
  schoolId,
  license,
  onClose,
}: {
  open: boolean;
  schoolId: string;
  license: PlatformLicense;
  onClose: () => void;
}) {
  const { t } = useTranslation();
  const { show } = useToast();
  const extend = useExtendLicense();
  const [endsOn, setEndsOn] = useState("");
  const current = license.endsAt.slice(0, 10);
  const valid = endsOn > current;

  function close() {
    setEndsOn("");
    onClose();
  }

  function submit() {
    if (!valid) return;
    extend.mutate(
      { schoolId, licenseId: license.id, endsAt: new Date(`${endsOn}T00:00:00Z`).toISOString() },
      {
        onSuccess: () => {
          show({ variant: "success", title: t("platformLicensing.school.done.extend") });
          close();
        },
        onError: (error) =>
          show({
            variant: "error",
            title: t("platformLicensing.common.saveError"),
            description: error instanceof ApiError ? (error.detail ?? error.title) : undefined,
          }),
      },
    );
  }

  return (
    <Modal
      open={open}
      onClose={close}
      title={t("platformLicensing.school.extendTitle")}
      description={t("platformLicensing.school.extendHelp")}
    >
      <Modal.Body>
        <Input
          label={t("platformLicensing.school.extendLabel")}
          type="date"
          min={current}
          value={endsOn}
          error={endsOn !== "" && !valid ? t("platformLicensing.school.extendError") : undefined}
          onChange={(event) => setEndsOn(event.target.value)}
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
          loading={extend.isPending}
          onClick={submit}
        >
          {t("platformLicensing.school.actions.extend")}
        </Button>
      </Modal.Footer>
    </Modal>
  );
}

function SeatsCard({
  schoolId,
  schoolName,
  license,
}: {
  schoolId: string;
  schoolName: string;
  license: PlatformLicense;
}) {
  const { t } = useTranslation();
  const { show } = useToast();
  const { formatDate } = useFormatters();
  const audiences = AUDIENCES.filter(
    (a) => (license.audiences.find((row) => row.audience === a)?.purchased ?? 0) > 0,
  );
  const [audience, setAudience] = useState<LicenseAudience>(audiences[0] ?? "student");
  const [search, setSearch] = useState("");
  const seats = useLicenseSeatsQuery(schoolId, license.id, { audience, search });
  const unassign = useUnassignSeat();
  const [assigning, setAssigning] = useState(false);
  const assignable =
    license.status === "draft" ||
    license.status === "awaiting_payment" ||
    license.status === "active";

  function remove(seatId: string) {
    unassign.mutate(
      { schoolId, licenseId: license.id, seatId },
      {
        onSuccess: () =>
          show({ variant: "success", title: t("platformLicensing.seats.unassigned") }),
        onError: (error) =>
          show({
            variant: "error",
            title: t("platformLicensing.common.saveError"),
            description: error instanceof ApiError ? (error.detail ?? error.title) : undefined,
          }),
      },
    );
  }

  return (
    <Card as="section" aria-labelledby="school-license-seats">
      <Card.Header>
        <div className="platform-header__row">
          <h3 id="school-license-seats">{t("platformLicensing.seats.title")}</h3>
          {assignable && audiences.length > 0 ? (
            <Button variant="secondary" onClick={() => setAssigning(true)}>
              {t("platformLicensing.seats.assign")}
            </Button>
          ) : null}
        </div>
      </Card.Header>
      <Card.Body>
        {audiences.length === 0 ? (
          <p className="platform-muted">{t("platformLicensing.seats.noSeats")}</p>
        ) : (
          <>
            <div className="platform-toolbar licensing-form-grid">
              <Select
                label={t("platformLicensing.seats.audienceLabel")}
                value={audience}
                onChange={setAudience}
                options={audiences.map((value) => ({
                  value,
                  label: t(`platformLicensing.audience.${value}`),
                }))}
              />
              <Input
                label={t("platformLicensing.seats.searchLabel")}
                type="search"
                value={search}
                onChange={(event) => setSearch(event.target.value)}
              />
            </div>
            {seats.data && seats.data.seats.length === 0 ? (
              <p className="platform-muted">{t("platformLicensing.seats.empty")}</p>
            ) : null}
            {seats.data && seats.data.seats.length > 0 ? (
              <table className="platform-table">
                <caption className="sf-visually-hidden">
                  {t("platformLicensing.seats.caption", { school: schoolName })}
                </caption>
                <thead>
                  <tr>
                    <th scope="col">{t("platformLicensing.seats.columns.person")}</th>
                    <th scope="col">{t("platformLicensing.seats.columns.assigned")}</th>
                    <th scope="col">{t("platformLicensing.seats.columns.overlap")}</th>
                    <th scope="col">
                      <span className="sf-visually-hidden">
                        {t("platformLicensing.common.actions")}
                      </span>
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {seats.data.seats.map((seat) => (
                    <tr key={seat.seatId}>
                      <td>
                        <div className="platform-cell-stack">
                          <span>{seat.name}</span>
                          <span className="platform-muted">{seat.email}</span>
                        </div>
                      </td>
                      <td>
                        {formatDate(new Date(seat.assignedAt), { dateStyle: "medium" })}
                        {seat.assignedByPlatform ? (
                          <span className="platform-muted">
                            {" "}
                            · {t("platformLicensing.seats.byPlatform")}
                          </span>
                        ) : null}
                      </td>
                      <td>
                        {seat.overlap
                          ? t("platformLicensing.seats.overlap", { days: seat.overlap.overlapDays })
                          : "—"}
                      </td>
                      <td>
                        <Button
                          variant="tertiary"
                          disabled={unassign.isPending}
                          onClick={() => remove(seat.seatId)}
                          aria-label={t("platformLicensing.seats.unassignNamed", {
                            name: seat.name,
                          })}
                        >
                          {t("platformLicensing.seats.unassign")}
                        </Button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            ) : null}
          </>
        )}
      </Card.Body>
      <AssignSeatsModal
        open={assigning}
        schoolId={schoolId}
        licenseId={license.id}
        audiences={audiences}
        onClose={() => setAssigning(false)}
      />
    </Card>
  );
}

/** Assign seats on the school's behalf: to everyone eligible, or to people picked from the school. */
function AssignSeatsModal({
  open,
  schoolId,
  licenseId,
  audiences,
  onClose,
}: {
  open: boolean;
  schoolId: string;
  licenseId: string;
  audiences: LicenseAudience[];
  onClose: () => void;
}) {
  const { t } = useTranslation();
  const { show } = useToast();
  const assign = useAssignSeats();
  const [audience, setAudience] = useState<LicenseAudience>(audiences[0] ?? "student");
  const [search, setSearch] = useState("");
  const [picked, setPicked] = useState<string[]>([]);
  const members = useSchoolMembersQuery(schoolId, {
    role: MEMBER_ROLE[audience],
    status: "",
    search,
    page: 0,
  });

  function close() {
    setPicked([]);
    setSearch("");
    onClose();
  }

  function submit(everyone: boolean) {
    assign.mutate(
      {
        schoolId,
        licenseId,
        body: everyone ? { audience, scope: { kind: "all" } } : { audience, userIds: picked },
      },
      {
        onSuccess: (result) => {
          show({
            variant: "success",
            title: t("platformLicensing.seats.assignedCount", {
              count: result.assigned.length,
              skipped: result.notAssigned.length,
            }),
          });
          close();
        },
        onError: (error) =>
          show({
            variant: "error",
            title: t("platformLicensing.common.saveError"),
            description: error instanceof ApiError ? (error.detail ?? error.title) : undefined,
          }),
      },
    );
  }

  return (
    <Modal open={open} onClose={close} title={t("platformLicensing.seats.assignTitle")}>
      <Modal.Body>
        <Select
          label={t("platformLicensing.seats.audienceLabel")}
          value={audience}
          onChange={(value) => {
            setAudience(value);
            setPicked([]);
          }}
          options={audiences.map((value) => ({
            value,
            label: t(`platformLicensing.audience.${value}`),
          }))}
        />
        <Input
          label={t("platformLicensing.seats.searchPeople")}
          type="search"
          value={search}
          onChange={(event) => setSearch(event.target.value)}
        />
        <div
          className="licensing-row-list"
          role="group"
          aria-label={t("platformLicensing.seats.people")}
        >
          {(members.data?.members ?? []).map((member) => (
            <Checkbox
              key={member.userId}
              label={`${member.displayName} · ${member.email}`}
              checked={picked.includes(member.userId)}
              onChange={(event) =>
                setPicked((prev) =>
                  event.target.checked
                    ? [...prev, member.userId]
                    : prev.filter((id) => id !== member.userId),
                )
              }
            />
          ))}
        </div>
      </Modal.Body>
      <Modal.Footer>
        <Button type="button" variant="tertiary" onClick={close}>
          {t("platform.common.cancel")}
        </Button>
        <Button
          type="button"
          variant="secondary"
          loading={assign.isPending}
          onClick={() => submit(true)}
        >
          {t("platformLicensing.seats.assignEveryone")}
        </Button>
        <Button
          type="button"
          variant="primary"
          disabled={picked.length === 0}
          loading={assign.isPending}
          onClick={() => submit(false)}
        >
          {t("platformLicensing.seats.assignPicked", { count: picked.length })}
        </Button>
      </Modal.Footer>
    </Modal>
  );
}

function InvoicesCard({ schoolId, invoices }: { schoolId: string; invoices: InvoiceListItem[] }) {
  const { t } = useTranslation();
  const { formatDate } = useFormatters();
  const money = useMoney();
  return (
    <Card as="section" aria-labelledby="school-license-invoices">
      <Card.Header>
        <h3 id="school-license-invoices">{t("platformLicensing.school.invoicesTitle")}</h3>
      </Card.Header>
      <Card.Body>
        {invoices.length === 0 ? (
          <p className="platform-muted">{t("platformLicensing.school.noInvoices")}</p>
        ) : (
          <table className="platform-table">
            <caption className="sf-visually-hidden">
              {t("platformLicensing.school.invoicesTitle")}
            </caption>
            <thead>
              <tr>
                <th scope="col">{t("platformLicensing.payments.columns.number")}</th>
                <th scope="col">{t("platformLicensing.payments.columns.due")}</th>
                <th scope="col">{t("platformLicensing.payments.columns.total")}</th>
                <th scope="col">{t("platformLicensing.payments.columns.balance")}</th>
                <th scope="col">{t("platformLicensing.payments.columns.status")}</th>
              </tr>
            </thead>
            <tbody>
              {invoices.map((invoice) => (
                <tr key={invoice.id}>
                  <td>
                    <Link to={`/portal/platform/payments/${schoolId}/${invoice.id}`}>
                      {invoice.number}
                    </Link>
                  </td>
                  <td>{formatDate(new Date(invoice.dueDate), { dateStyle: "medium" })}</td>
                  <td className="licensing-amount">
                    {money(invoice.totalMinor, invoice.currencyCode, invoice.minorUnit)}
                  </td>
                  <td className="licensing-amount">
                    {money(invoice.balanceMinor, invoice.currencyCode, invoice.minorUnit)}
                  </td>
                  <td>
                    <InvoiceStatusPill status={invoice.status} overdue={invoice.overdue} />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </Card.Body>
    </Card>
  );
}

function PaymentsHistory({ payments }: { payments: SchoolLicenseConsole["payments"] }) {
  const { t } = useTranslation();
  const { formatDate } = useFormatters();
  const money = useMoney();
  return (
    <Card as="section" aria-labelledby="school-license-payments">
      <Card.Header>
        <h3 id="school-license-payments">{t("platformLicensing.school.paymentsTitle")}</h3>
      </Card.Header>
      <Card.Body>
        {payments.length === 0 ? (
          <p className="platform-muted">{t("platformLicensing.school.noPayments")}</p>
        ) : (
          <ul
            className="licensing-history"
            aria-label={t("platformLicensing.school.paymentsTitle")}
          >
            {payments.map((payment) => (
              <li key={payment.id}>
                <span>
                  {formatDate(new Date(payment.receivedAt), { dateStyle: "medium" })} ·{" "}
                  {payment.bankReference}
                  {payment.voidedAt ? ` · ${t("platformLicensing.school.voided")}` : ""}
                </span>
                <strong className="licensing-amount">
                  {money(payment.amountMinor, payment.currencyCode)}
                </strong>
              </li>
            ))}
          </ul>
        )}
      </Card.Body>
    </Card>
  );
}

function HistoryCard({ history }: { history: SchoolLicenseConsole["history"] }) {
  const { t } = useTranslation();
  const { formatDate } = useFormatters();
  return (
    <Card as="section" aria-labelledby="school-license-history">
      <Card.Header>
        <h3 id="school-license-history">{t("platformLicensing.school.historyTitle")}</h3>
      </Card.Header>
      <Card.Body>
        {history.length === 0 ? (
          <p className="platform-muted">{t("platformLicensing.school.noHistory")}</p>
        ) : (
          <ul className="licensing-history" aria-label={t("platformLicensing.school.historyTitle")}>
            {history.map((entry) => (
              <li key={entry.id}>
                <span>
                  {t(`platformLicensing.history.table.${entry.targetTable}`, {
                    defaultValue: entry.targetTable,
                  })}
                  {" · "}
                  {t(`platformLicensing.history.action.${entry.action}`, {
                    defaultValue: entry.action,
                  })}
                  {entry.newValues && typeof entry.newValues.status === "string"
                    ? ` → ${String(entry.newValues.status)}`
                    : ""}
                  {entry.actorId ? "" : ` · ${t("platformLicensing.history.byStudafy")}`}
                </span>
                <span className="platform-muted">
                  {formatDate(new Date(entry.createdAt), {
                    dateStyle: "medium",
                    timeStyle: "short",
                  })}
                </span>
              </li>
            ))}
          </ul>
        )}
      </Card.Body>
    </Card>
  );
}
