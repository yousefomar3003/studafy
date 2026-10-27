import { ApiError } from "@studafy/api-client";
import { Button, Card, Checkbox, Input, Modal, Select, useToast } from "@studafy/ui";
import { useState } from "react";
import { Link } from "react-router-dom";

import { useFormatters, useTranslation } from "../../../lib/i18n";
import { PlatformPageHeader } from "../PlatformNav";

import { LICENSE_STATUSES } from "./constants";
import { useMoney } from "./format";
import { useResolveChangeRequest } from "./mutations";
import { EXPIRING_WITHIN_DAYS, useChangeRequestsQuery, useLicensesQuery } from "./queries";

import "../platform.css";
import "./licensing.css";

import type { ChangeRequest, ConsoleLicense, LicenseListFilters, LicenseStatus } from "./queries";

/**
 * Every school's licenses (`/portal/platform/licenses`), filtered by status, ending within 30
 * days, seats nearly full or an unpaid balance; and the inbox of seat change requests schools send.
 */
export default function LicensesPage() {
  const { t } = useTranslation();
  const [filters, setFilters] = useState<LicenseListFilters>({
    status: "",
    expiring: false,
    nearlyFull: false,
    unpaid: false,
  });
  const licenses = useLicensesQuery(filters);

  return (
    <>
      <PlatformPageHeader
        title={t("platformLicensing.licenses.title")}
        description={t("platformLicensing.licenses.description")}
        actions={
          <Link to="/portal/platform/quotes">{t("platformLicensing.licenses.newQuote")}</Link>
        }
      />

      <ChangeRequestInbox />

      <section aria-labelledby="licenses-list">
        <h2 id="licenses-list">{t("platformLicensing.licenses.listTitle")}</h2>
        <div
          className="platform-toolbar licensing-row"
          role="group"
          aria-label={t("platformLicensing.licenses.filters")}
        >
          <Select
            label={t("platformLicensing.licenses.statusFilter")}
            value={filters.status}
            onChange={(status) => setFilters((prev) => ({ ...prev, status }))}
            options={[
              { value: "" as const, label: t("platformLicensing.licenses.allStatuses") },
              ...LICENSE_STATUSES.map((value) => ({
                value,
                label: t(`platformLicensing.licenseStatus.${value}`),
              })),
            ]}
          />
          <Checkbox
            label={t("platformLicensing.licenses.expiringFilter", { days: EXPIRING_WITHIN_DAYS })}
            checked={filters.expiring}
            onChange={(event) =>
              setFilters((prev) => ({ ...prev, expiring: event.target.checked }))
            }
          />
          <Checkbox
            label={t("platformLicensing.licenses.nearlyFullFilter")}
            checked={filters.nearlyFull}
            onChange={(event) =>
              setFilters((prev) => ({ ...prev, nearlyFull: event.target.checked }))
            }
          />
          <Checkbox
            label={t("platformLicensing.licenses.unpaidFilter")}
            checked={filters.unpaid}
            onChange={(event) => setFilters((prev) => ({ ...prev, unpaid: event.target.checked }))}
          />
        </div>
        {licenses.isPending ? <p role="status">{t("site.common.loading")}</p> : null}
        {licenses.isError ? <p role="alert">{t("platformLicensing.common.loadError")}</p> : null}
        {licenses.data && licenses.data.length === 0 ? (
          <p className="platform-muted">{t("platformLicensing.licenses.empty")}</p>
        ) : null}
        {licenses.data && licenses.data.length > 0 ? (
          <LicenseTable licenses={licenses.data} />
        ) : null}
      </section>
    </>
  );
}

function LicenseTable({ licenses }: { licenses: ConsoleLicense[] }) {
  const { t } = useTranslation();
  const { formatDate, formatNumber } = useFormatters();
  const money = useMoney();
  return (
    <table className="platform-table">
      <caption className="sf-visually-hidden">{t("platformLicensing.licenses.listTitle")}</caption>
      <thead>
        <tr>
          <th scope="col">{t("platformLicensing.licenses.columns.school")}</th>
          <th scope="col">{t("platformLicensing.licenses.columns.status")}</th>
          <th scope="col">{t("platformLicensing.licenses.columns.period")}</th>
          <th scope="col">{t("platformLicensing.licenses.columns.seats")}</th>
          <th scope="col">{t("platformLicensing.licenses.columns.balance")}</th>
        </tr>
      </thead>
      <tbody>
        {licenses.map((license) => (
          <tr key={license.id}>
            <td>
              <Link to={`/portal/platform/schools/${license.schoolId}`}>{license.schoolName}</Link>
            </td>
            <td>
              <LicenseStatusPill status={license.status} />
            </td>
            <td>
              <div className="platform-cell-stack">
                <span>
                  {formatDate(new Date(license.startsAt), { dateStyle: "medium" })} –{" "}
                  {formatDate(new Date(license.endsAt), { dateStyle: "medium" })}
                </span>
                {license.status === "active" && license.daysLeft >= 0 ? (
                  <span className="platform-muted">
                    {t("platformLicensing.licenses.daysLeft", { count: license.daysLeft })}
                  </span>
                ) : null}
              </div>
            </td>
            <td>
              <div className="platform-cell-stack">
                {license.audiences
                  .filter((a) => a.purchased > 0)
                  .map((a) => (
                    <span key={a.audience}>
                      {t("platformLicensing.licenses.seatsCell", {
                        audience: t(`platformLicensing.audience.${a.audience}`),
                        assigned: formatNumber(a.assigned),
                        purchased: formatNumber(a.purchased),
                      })}
                      <SeatMeter assigned={a.assigned} purchased={a.purchased} />
                    </span>
                  ))}
              </div>
            </td>
            <td className="licensing-amount">
              {license.balanceMinor > 0
                ? money(license.balanceMinor, license.currencyCode, license.minorUnit)
                : "—"}
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

export function LicenseStatusPill({ status }: { status: LicenseStatus }) {
  const { t } = useTranslation();
  return (
    <span className="platform-pill" data-status={status}>
      {t(`platformLicensing.licenseStatus.${status}`)}
    </span>
  );
}

export function SeatMeter({ assigned, purchased }: { assigned: number; purchased: number }) {
  const share = purchased > 0 ? Math.min(1, assigned / purchased) : 0;
  return (
    <span className="licensing-meter" aria-hidden="true">
      <span
        className="licensing-meter__fill"
        data-level={share >= 0.9 ? "high" : "normal"}
        style={{ width: `${Math.round(share * 100)}%` }}
      />
    </span>
  );
}

type RequestStatus = ChangeRequest["status"];

/** Seat change requests from schools: price one, or close it with a note. */
export function ChangeRequestInbox() {
  const { t } = useTranslation();
  const { formatDate } = useFormatters();
  const [status, setStatus] = useState<RequestStatus>("open");
  const requests = useChangeRequestsQuery(status);
  const [closing, setClosing] = useState<{
    request: ChangeRequest;
    to: "resolved" | "declined";
  } | null>(null);

  const wanted = (request: ChangeRequest) =>
    [
      request.studentSeats !== null
        ? t("platformLicensing.inbox.wants.students", { count: request.studentSeats })
        : null,
      request.teacherSeats !== null
        ? t("platformLicensing.inbox.wants.teachers", { count: request.teacherSeats })
        : null,
      request.parentSeats !== null
        ? t("platformLicensing.inbox.wants.parents", { count: request.parentSeats })
        : null,
      ...(["student", "teacher", "parent"] as const).map((audience) => {
        const tier = request[`${audience}Tier`];
        return tier
          ? t("platformLicensing.inbox.wants.tier", {
              tier: tier.displayName,
              audience: t(`platformLicensing.audience.${audience}`),
            })
          : null;
      }),
      request.includeFamilyPlus !== null
        ? t(
            request.includeFamilyPlus
              ? "platformLicensing.inbox.wants.familyPlusOn"
              : "platformLicensing.inbox.wants.familyPlusOff",
          )
        : null,
    ]
      .filter(Boolean)
      .join(" · ");

  return (
    <Card as="section" aria-labelledby="change-request-inbox">
      <Card.Header>
        <div className="platform-header__row">
          <h2 id="change-request-inbox">{t("platformLicensing.inbox.title")}</h2>
          <div
            className="platform-chips"
            role="group"
            aria-label={t("platformLicensing.inbox.filter")}
          >
            {(["open", "resolved", "declined"] as const).map((value) => (
              <Button
                key={value}
                variant={status === value ? "primary" : "tertiary"}
                aria-pressed={status === value}
                onClick={() => setStatus(value)}
              >
                {t(`platformLicensing.inbox.status.${value}`)}
              </Button>
            ))}
          </div>
        </div>
      </Card.Header>
      <Card.Body>
        {requests.isPending ? <p role="status">{t("site.common.loading")}</p> : null}
        {requests.data && requests.data.length === 0 ? (
          <p className="platform-muted">{t(`platformLicensing.inbox.empty.${status}`)}</p>
        ) : null}
        {requests.data && requests.data.length > 0 ? (
          <ul className="licensing-history" aria-label={t("platformLicensing.inbox.title")}>
            {requests.data.map((request) => (
              <li key={request.id}>
                <div className="platform-cell-stack">
                  <Link to={`/portal/platform/schools/${request.schoolId}`}>
                    {request.schoolName}
                  </Link>
                  <span>{wanted(request)}</span>
                  <span className="platform-muted">“{request.note}”</span>
                  <span className="platform-muted">
                    {formatDate(new Date(request.createdAt), { dateStyle: "medium" })}
                  </span>
                  {request.resolutionNote ? (
                    <span className="platform-muted">{request.resolutionNote}</span>
                  ) : null}
                </div>
                {request.status === "open" ? (
                  <div className="platform-actions">
                    <Link
                      to={`/portal/platform/quotes?schoolId=${request.schoolId}${
                        request.licenseId
                          ? `&licenseId=${request.licenseId}&kind=seat_increase`
                          : ""
                      }`}
                    >
                      {t("platformLicensing.inbox.price")}
                    </Link>
                    <Button
                      variant="secondary"
                      onClick={() => setClosing({ request, to: "resolved" })}
                    >
                      {t("platformLicensing.inbox.resolve")}
                    </Button>
                    <Button
                      variant="tertiary"
                      onClick={() => setClosing({ request, to: "declined" })}
                    >
                      {t("platformLicensing.inbox.decline")}
                    </Button>
                  </div>
                ) : (
                  <span className="platform-pill" data-status={request.status}>
                    {t(`platformLicensing.inbox.status.${request.status}`)}
                  </span>
                )}
              </li>
            ))}
          </ul>
        ) : null}
      </Card.Body>
      <CloseRequestModal target={closing} onClose={() => setClosing(null)} />
    </Card>
  );
}

function CloseRequestModal({
  target,
  onClose,
}: {
  target: { request: ChangeRequest; to: "resolved" | "declined" } | null;
  onClose: () => void;
}) {
  const { t } = useTranslation();
  const { show } = useToast();
  const resolve = useResolveChangeRequest();
  const [note, setNote] = useState("");

  function close() {
    setNote("");
    onClose();
  }

  function submit() {
    if (!target) return;
    resolve.mutate(
      {
        schoolId: target.request.schoolId,
        requestId: target.request.id,
        status: target.to,
        note: note.trim() || null,
      },
      {
        onSuccess: () => {
          show({ variant: "success", title: t(`platformLicensing.inbox.done.${target.to}`) });
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
      open={target !== null}
      onClose={close}
      title={
        target
          ? t(`platformLicensing.inbox.closeTitle.${target.to}`, {
              school: target.request.schoolName,
            })
          : ""
      }
    >
      <Modal.Body>
        <Input
          label={t("platformLicensing.inbox.noteLabel")}
          helperText={t("platformLicensing.inbox.noteHelp")}
          value={note}
          onChange={(event) => setNote(event.target.value)}
        />
      </Modal.Body>
      <Modal.Footer>
        <Button type="button" variant="tertiary" onClick={close}>
          {t("platform.common.cancel")}
        </Button>
        <Button type="button" variant="primary" loading={resolve.isPending} onClick={submit}>
          {t("platformLicensing.common.confirm")}
        </Button>
      </Modal.Footer>
    </Modal>
  );
}
