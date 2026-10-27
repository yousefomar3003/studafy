import { ApiError } from "@studafy/api-client";
import { PERMISSIONS } from "@studafy/constants";
import { Button, Input, Modal, Select, Table, Tabs, useToast } from "@studafy/ui";
import { useState } from "react";
import { useSearchParams } from "react-router-dom";

import { usePermissions } from "../../lib/auth";
import { useFormatters, useTranslation } from "../../lib/i18n";
import { useDebounced } from "../platform/licensing/useDebounced";
import { pickCurrentYear, useAcademicYears } from "../principal/school/queries";
import { useGradeLevels, useSectionClasses, useSections } from "../principal/sections/queries";

import { LicenseHeader } from "./LicenseHeader";
import { useAssignSeats, useUnassignSeats } from "./mutations";
import {
  AUDIENCES,
  PEOPLE_PAGE_SIZE,
  seatsLeft,
  usePeopleQuery,
  useSchoolLicenseQuery,
} from "./queries";

import type { AssignResult, SeatScope } from "./mutations";
import type {
  LicenseAudience,
  LicensePerson,
  PeopleFilter,
  PeopleFilters,
  SchoolLicense,
} from "./queries";

import "./license.css";

const SHOW: readonly PeopleFilter[] = ["all", "seated", "unseated", "personal"];

type Pending =
  | { kind: "people"; people: LicensePerson[] }
  | { kind: "scope"; scope: SeatScope; scopeName: string | null }
  | { kind: "unassign"; people: LicensePerson[] };

/**
 * Seats (`/portal/license/seats`), gated by `license:read`: a tab per audience (parents only with
 * Family+), everyone in it with their seat status and personal subscription, searchable and narrowed
 * to a grade, section or class. `license:manage` assigns and unassigns -- one person, a selection,
 * or everyone eligible in the grade, section or class shown (or the whole school) while seats last;
 * when seats run out, the people left without one are listed.
 */
export default function SeatsPage() {
  const { t } = useTranslation();
  const overview = useSchoolLicenseQuery();
  const license = overview.data?.license ?? null;
  const [params, setParams] = useSearchParams();

  const audiences = AUDIENCES.filter((a) => a !== "parent" || license?.includeFamilyPlus);
  const requested = params.get("audience") as LicenseAudience | null;
  const audience: LicenseAudience =
    requested && audiences.includes(requested) ? requested : "student";

  return (
    <>
      <LicenseHeader
        title={t("schoolLicense.seats.title")}
        description={t("schoolLicense.seats.description")}
      />
      <div className="license-note" role="note">
        <p>{t("schoolLicense.seats.personalNote")}</p>
        <p>{t("schoolLicense.seats.personalNotePrice")}</p>
      </div>
      {overview.isPending ? <p role="status">{t("schoolLicense.common.loading")}</p> : null}
      {overview.isError ? <p role="alert">{t("schoolLicense.common.loadError")}</p> : null}
      {overview.data && !license ? (
        <p className="license-muted">{t("schoolLicense.overview.noLicense")}</p>
      ) : null}
      {license ? (
        <Tabs
          value={audience}
          defaultValue="student"
          onChange={(value) => setParams({ audience: value })}
        >
          <Tabs.List aria-label={t("schoolLicense.seats.tabsLabel")}>
            {audiences.map((value) => (
              <Tabs.Tab key={value} value={value}>
                {t(`schoolLicense.audience.${value}`)}
              </Tabs.Tab>
            ))}
          </Tabs.List>
          {audiences.map((value) => (
            <Tabs.Panel key={value} value={value}>
              {value === audience ? <AudienceSeats license={license} audience={value} /> : null}
            </Tabs.Panel>
          ))}
        </Tabs>
      ) : null}
    </>
  );
}

const EMPTY_FILTERS = {
  show: "all" as PeopleFilter,
  search: "",
  gradeLevelId: "",
  sectionId: "",
  classId: "",
  page: 0,
};

function AudienceSeats({
  license,
  audience,
}: {
  license: SchoolLicense;
  audience: LicenseAudience;
}) {
  const { t } = useTranslation();
  const { show: toast } = useToast();
  const { formatDate, formatNumber } = useFormatters();
  const canManage = usePermissions().has(PERMISSIONS.LICENSE_MANAGE);
  const assign = useAssignSeats();
  const unassign = useUnassignSeats();

  const [filters, setFilters] = useState(EMPTY_FILTERS);
  const search = useDebounced(filters.search.trim(), 300);
  const query: PeopleFilters = { ...filters, search, audience };
  const people = usePeopleQuery(query);
  const [selected, setSelected] = useState<ReadonlySet<string>>(new Set());
  const [pending, setPending] = useState<Pending | null>(null);
  const [result, setResult] = useState<AssignResult | null>(null);

  const years = useAcademicYears();
  const year = pickCurrentYear(years.data ?? []);
  const grades = useGradeLevels();
  const sections = useSections(year?.id);
  const classes = useSectionClasses(filters.sectionId || undefined);
  const sectionOptions = (sections.data ?? []).filter(
    (section) => !filters.gradeLevelId || section.grade_level_id === filters.gradeLevelId,
  );

  const purchased = license.audiences.find((a) => a.audience === audience)?.purchased ?? 0;
  const left = seatsLeft(license, audience);
  const assignable =
    license.status === "active" ||
    license.status === "awaiting_payment" ||
    license.status === "draft";
  const rows = people.data?.people ?? [];
  const total = people.data?.total ?? 0;
  const picked = rows.filter((row) => selected.has(row.userId));
  const toAssign = picked.filter((row) => row.seatId === null && row.eligible);
  const toUnassign = picked.filter((row) => row.seatId !== null);
  const audienceName = t(`schoolLicense.audience.${audience}`);

  function setFilter(patch: Partial<typeof EMPTY_FILTERS>) {
    setFilters((prev) => ({ ...prev, page: 0, ...patch }));
    setSelected(new Set());
  }

  const scope: SeatScope = filters.classId
    ? { kind: "class", classId: filters.classId }
    : filters.sectionId
      ? { kind: "section", sectionId: filters.sectionId }
      : filters.gradeLevelId
        ? { kind: "grade", gradeLevelId: filters.gradeLevelId }
        : { kind: "all" };
  const scopeName =
    scope.kind === "class"
      ? (classes.data?.find((c) => c.id === filters.classId)?.code ?? null)
      : scope.kind === "section"
        ? (() => {
            const section = sectionOptions.find((s) => s.id === filters.sectionId);
            return section
              ? t("schoolLicense.seats.sectionName", {
                  grade: section.grade_level_name,
                  section: section.name,
                })
              : null;
          })()
        : scope.kind === "grade"
          ? (grades.data?.find((g) => g.id === filters.gradeLevelId)?.name ?? null)
          : null;

  function errorToast(error: unknown) {
    toast({
      variant: "error",
      title: t("schoolLicense.common.saveError"),
      description: error instanceof ApiError ? (error.detail ?? error.title) : undefined,
    });
  }

  function runAssign(target: Pending & { kind: "people" | "scope" }) {
    const body =
      target.kind === "people"
        ? { audience, userIds: target.people.map((p) => p.userId) }
        : { audience, scope: target.scope };
    assign.mutate(body, {
      onSuccess: (outcome) => {
        setResult(outcome);
        setSelected(new Set());
        setPending(null);
        toast({
          variant: outcome.notAssigned.length > 0 ? "warning" : "success",
          title: t("schoolLicense.seats.assignedToast", { count: outcome.assigned.length }),
        });
      },
      onError: errorToast,
    });
  }

  function runUnassign(targets: LicensePerson[]) {
    unassign.mutate(
      targets.map((p) => p.seatId!),
      {
        onSuccess: (count) => {
          setSelected(new Set());
          setPending(null);
          setResult(null);
          toast({ variant: "success", title: t("schoolLicense.seats.unassignedToast", { count }) });
        },
        onError: errorToast,
      },
    );
  }

  /** One person without a personal subscription is assigned at once; anything else is confirmed. */
  function askAssign(targets: LicensePerson[]) {
    if (targets.length === 1 && !targets[0]!.hasPersonalSubscription) {
      runAssign({ kind: "people", people: targets });
    } else {
      setPending({ kind: "people", people: targets });
    }
  }

  return (
    <div className="license-section">
      <p className="license-counter" role="status">
        {t("schoolLicense.seats.counter", {
          left: formatNumber(left),
          purchased: formatNumber(purchased),
          audience: audienceName,
        })}
      </p>

      <div className="license-toolbar" role="group" aria-label={t("schoolLicense.seats.filters")}>
        <Input
          label={t("schoolLicense.seats.search")}
          type="search"
          value={filters.search}
          onChange={(event) => setFilter({ search: event.target.value })}
        />
        <Select
          label={t("schoolLicense.seats.show")}
          value={filters.show}
          onChange={(show) => setFilter({ show })}
          options={SHOW.map((value) => ({
            value,
            label: t(`schoolLicense.seats.showOption.${value}`),
          }))}
        />
        <Select
          label={t("schoolLicense.seats.grade")}
          value={filters.gradeLevelId}
          onChange={(gradeLevelId) => setFilter({ gradeLevelId, sectionId: "", classId: "" })}
          options={[
            { value: "", label: t("schoolLicense.seats.anyGrade") },
            ...(grades.data ?? []).map((grade) => ({ value: grade.id, label: grade.name })),
          ]}
        />
        <Select
          label={t("schoolLicense.seats.section")}
          value={filters.sectionId}
          onChange={(sectionId) => setFilter({ sectionId, classId: "" })}
          options={[
            { value: "", label: t("schoolLicense.seats.anySection") },
            ...sectionOptions.map((section) => ({
              value: section.id,
              label: t("schoolLicense.seats.sectionName", {
                grade: section.grade_level_name,
                section: section.name,
              }),
            })),
          ]}
        />
        <Select
          label={t("schoolLicense.seats.class")}
          value={filters.classId}
          onChange={(classId) => setFilter({ classId })}
          disabled={!filters.sectionId}
          options={[
            { value: "", label: t("schoolLicense.seats.anyClass") },
            ...(classes.data ?? []).map((c) => ({ value: c.id, label: c.code })),
          ]}
        />
      </div>

      {canManage && assignable ? (
        <div className="license-toolbar" role="group" aria-label={t("schoolLicense.seats.bulk")}>
          <div className="license-toolbar__actions">
            <Button
              variant="primary"
              disabled={toAssign.length === 0}
              onClick={() => askAssign(toAssign)}
            >
              {t("schoolLicense.seats.assignSelected", { count: toAssign.length })}
            </Button>
            <Button
              variant="secondary"
              disabled={toUnassign.length === 0}
              onClick={() => setPending({ kind: "unassign", people: toUnassign })}
            >
              {t("schoolLicense.seats.unassignSelected", { count: toUnassign.length })}
            </Button>
            <Button
              variant="secondary"
              disabled={left === 0}
              onClick={() => setPending({ kind: "scope", scope, scopeName })}
            >
              {scopeName
                ? t("schoolLicense.seats.assignScope", { scope: scopeName })
                : t("schoolLicense.seats.assignAll")}
            </Button>
          </div>
        </div>
      ) : null}

      {result ? <AssignOutcome result={result} onDismiss={() => setResult(null)} /> : null}

      <Table caption={t("schoolLicense.seats.caption", { audience: audienceName })} hideCaption>
        <Table.Header>
          <Table.Row>
            {canManage ? (
              <Table.HeaderCell>
                <input
                  type="checkbox"
                  aria-label={t("schoolLicense.seats.selectPage")}
                  checked={rows.length > 0 && rows.every((row) => selected.has(row.userId))}
                  disabled={rows.length === 0}
                  onChange={(event) =>
                    setSelected(
                      event.target.checked ? new Set(rows.map((r) => r.userId)) : new Set(),
                    )
                  }
                />
              </Table.HeaderCell>
            ) : null}
            <Table.HeaderCell>{t("schoolLicense.seats.columns.person")}</Table.HeaderCell>
            <Table.HeaderCell>{t("schoolLicense.seats.columns.seat")}</Table.HeaderCell>
            <Table.HeaderCell>{t("schoolLicense.seats.columns.personal")}</Table.HeaderCell>
            {canManage ? (
              <Table.HeaderCell>{t("schoolLicense.common.actions")}</Table.HeaderCell>
            ) : null}
          </Table.Row>
        </Table.Header>
        <Table.Body
          columnCount={canManage ? 5 : 3}
          loading={people.isPending}
          empty={
            people.isError ? t("schoolLicense.common.loadError") : t("schoolLicense.seats.empty")
          }
        >
          {rows.map((person) => (
            <Table.Row
              key={person.userId}
              aria-selected={canManage ? selected.has(person.userId) : undefined}
            >
              {canManage ? (
                <Table.Cell>
                  <input
                    type="checkbox"
                    aria-label={t("schoolLicense.seats.selectPerson", { name: person.name })}
                    checked={selected.has(person.userId)}
                    onChange={(event) =>
                      setSelected((prev) => {
                        const next = new Set(prev);
                        if (event.target.checked) next.add(person.userId);
                        else next.delete(person.userId);
                        return next;
                      })
                    }
                  />
                </Table.Cell>
              ) : null}
              <Table.Cell>
                <div>{person.name}</div>
                <div className="license-muted">{person.email}</div>
              </Table.Cell>
              <Table.Cell>
                {person.seatId ? (
                  <span className="license-pill" data-tone="success">
                    {t("schoolLicense.seats.hasSeat", {
                      date: formatDate(new Date(person.assignedAt!), { dateStyle: "medium" }),
                    })}
                  </span>
                ) : person.eligible ? (
                  <span className="license-pill">{t("schoolLicense.seats.noSeat")}</span>
                ) : (
                  <span className="license-pill" data-tone="warning">
                    {t("schoolLicense.seats.notEligible")}
                  </span>
                )}
              </Table.Cell>
              <Table.Cell>
                {person.personalSubscriptionEndsAt
                  ? t("schoolLicense.seats.personalUntil", {
                      date: formatDate(new Date(person.personalSubscriptionEndsAt), {
                        dateStyle: "medium",
                      }),
                    })
                  : "—"}
              </Table.Cell>
              {canManage ? (
                <Table.Cell>
                  {person.seatId ? (
                    <Button
                      variant="tertiary"
                      disabled={unassign.isPending}
                      aria-label={t("schoolLicense.seats.unassignNamed", { name: person.name })}
                      onClick={() => runUnassign([person])}
                    >
                      {t("schoolLicense.seats.unassign")}
                    </Button>
                  ) : person.eligible && assignable ? (
                    <Button
                      variant="secondary"
                      disabled={assign.isPending || left === 0}
                      aria-label={t("schoolLicense.seats.assignNamed", { name: person.name })}
                      onClick={() => askAssign([person])}
                    >
                      {t("schoolLicense.seats.assign")}
                    </Button>
                  ) : null}
                </Table.Cell>
              ) : null}
            </Table.Row>
          ))}
        </Table.Body>
      </Table>

      {total > PEOPLE_PAGE_SIZE ? (
        <div className="license-pager">
          <span className="license-muted">
            {t("schoolLicense.seats.page", {
              from: formatNumber(filters.page * PEOPLE_PAGE_SIZE + 1),
              to: formatNumber(Math.min(total, (filters.page + 1) * PEOPLE_PAGE_SIZE)),
              total: formatNumber(total),
            })}
          </span>
          <Button
            variant="tertiary"
            disabled={filters.page === 0}
            onClick={() => setFilters((prev) => ({ ...prev, page: prev.page - 1 }))}
          >
            {t("schoolLicense.seats.previous")}
          </Button>
          <Button
            variant="tertiary"
            disabled={(filters.page + 1) * PEOPLE_PAGE_SIZE >= total}
            onClick={() => setFilters((prev) => ({ ...prev, page: prev.page + 1 }))}
          >
            {t("schoolLicense.seats.next")}
          </Button>
        </div>
      ) : null}

      <ConfirmModal
        pending={pending}
        left={left}
        audienceName={audienceName}
        busy={assign.isPending || unassign.isPending}
        onCancel={() => setPending(null)}
        onConfirm={() => {
          if (!pending) return;
          if (pending.kind === "unassign") runUnassign(pending.people);
          else runAssign(pending);
        }}
      />
    </div>
  );
}

function ConfirmModal({
  pending,
  left,
  audienceName,
  busy,
  onCancel,
  onConfirm,
}: {
  pending: Pending | null;
  left: number;
  audienceName: string;
  busy: boolean;
  onCancel: () => void;
  onConfirm: () => void;
}) {
  const { t } = useTranslation();
  const { formatNumber } = useFormatters();
  if (!pending) return null;

  const personal =
    pending.kind === "people" ? pending.people.filter((p) => p.hasPersonalSubscription) : [];
  const title =
    pending.kind === "unassign"
      ? t("schoolLicense.seats.confirm.unassignTitle", { count: pending.people.length })
      : pending.kind === "people"
        ? t("schoolLicense.seats.confirm.assignTitle", { count: pending.people.length })
        : pending.scopeName
          ? t("schoolLicense.seats.confirm.scopeTitle", { scope: pending.scopeName })
          : t("schoolLicense.seats.confirm.allTitle", { audience: audienceName });

  return (
    <Modal open onClose={onCancel} title={title}>
      <Modal.Body>
        {pending.kind === "scope" ? (
          <p>
            {t("schoolLicense.seats.confirm.scopeBody", {
              left: formatNumber(left),
              audience: audienceName,
            })}
          </p>
        ) : null}
        {pending.kind === "people" && pending.people.length > left ? (
          <p role="alert">
            {t("schoolLicense.seats.confirm.notEnough", {
              count: pending.people.length,
              left: formatNumber(left),
            })}
          </p>
        ) : null}
        {pending.kind === "unassign" ? (
          <p>{t("schoolLicense.seats.confirm.unassignBody")}</p>
        ) : (
          <div className="license-note">
            {personal.length > 0 ? (
              <p>
                {t("schoolLicense.seats.confirm.personalNamed", {
                  count: personal.length,
                  names: personal.map((p) => p.name).join(", "),
                })}
              </p>
            ) : null}
            <p>{t("schoolLicense.seats.personalNote")}</p>
            <p>{t("schoolLicense.seats.personalNotePrice")}</p>
          </div>
        )}
      </Modal.Body>
      <Modal.Footer>
        <Button type="button" variant="tertiary" onClick={onCancel}>
          {t("schoolLicense.common.cancel")}
        </Button>
        <Button type="button" variant="primary" loading={busy} onClick={onConfirm}>
          {pending.kind === "unassign"
            ? t("schoolLicense.seats.confirm.unassignConfirm")
            : t("schoolLicense.seats.confirm.assignConfirm")}
        </Button>
      </Modal.Footer>
    </Modal>
  );
}

const REASONS = ["no_seats_left", "not_eligible", "already_assigned"] as const;

/** What a bulk assignment did, and who it left without a seat and why. */
function AssignOutcome({ result, onDismiss }: { result: AssignResult; onDismiss: () => void }) {
  const { t } = useTranslation();
  const stopped = result.renewalStops.length;
  return (
    <section
      className="license-banner"
      data-tone={
        result.notAssigned.some((n) => n.reason === "no_seats_left") ? "warning" : "neutral"
      }
      aria-labelledby="assign-outcome"
      role="status"
    >
      <div>
        <p id="assign-outcome" className="license-banner__title">
          {t("schoolLicense.seats.outcome.assigned", { count: result.assigned.length })}
        </p>
        {stopped > 0 ? (
          <p className="license-banner__body">
            {t("schoolLicense.seats.outcome.renewalsStopped", { count: stopped })}
          </p>
        ) : null}
        {REASONS.map((reason) => {
          const names = result.notAssigned.filter((n) => n.reason === reason);
          if (names.length === 0) return null;
          return (
            <div key={reason}>
              <p className="license-banner__body">
                {t(`schoolLicense.seats.outcome.${reason}`, { count: names.length })}
              </p>
              <ul
                className="license-list"
                aria-label={t(`schoolLicense.seats.outcome.${reason}`, { count: names.length })}
              >
                {names.map((n) => (
                  <li key={n.userId}>{n.name ?? t("schoolLicense.seats.outcome.unnamed")}</li>
                ))}
              </ul>
            </div>
          );
        })}
      </div>
      <Button variant="tertiary" onClick={onDismiss}>
        {t("schoolLicense.seats.outcome.dismiss")}
      </Button>
    </section>
  );
}
