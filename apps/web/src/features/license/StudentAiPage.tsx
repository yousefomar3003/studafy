import { ApiError } from "@studafy/api-client";
import { PERMISSIONS } from "@studafy/constants";
import { Button, Checkbox, Input, Modal, Select, Table, useToast } from "@studafy/ui";
import { useRef, useState } from "react";
import { Link } from "react-router-dom";

import { usePermissions } from "../../lib/auth";
import { parseCsv } from "../../lib/csv";
import { useFormatters, useTranslation } from "../../lib/i18n";
import { isXlsxFile, xlsxToCsv } from "../../lib/xlsx";
import { useMoney } from "../platform/licensing/format";
import { useDebounced } from "../platform/licensing/useDebounced";
import { pickCurrentYear, useAcademicYears } from "../principal/school/queries";
import { useGradeLevels, useSections } from "../principal/sections/queries";

import { LicenseHeader } from "./LicenseHeader";
import {
  useCloseStudentAiWindow,
  useOpenStudentAiWindow,
  useRecordStudentAiOptIns,
  useReleaseStudentAiOptIn,
  useTransferStudentAiOptIn,
} from "./mutations";
import {
  LEFT_STUDENT_STATUSES,
  STUDENT_AI_PAGE_SIZE,
  useStudentAiQuery,
  useStudentAiStudentsQuery,
} from "./queries";

import type { RecordOptInsResult } from "./mutations";
import type {
  AiOptIn,
  AiOptInStudentFilter,
  AiOptInStudentRow,
  AiOptInWindow,
  StudentAiFilters,
  StudentAiOverview,
} from "./queries";
import type { ReactNode } from "react";

import "./license.css";

const FILTERS: readonly AiOptInStudentFilter[] = [
  "all",
  "opted_in",
  "not_opted_in",
  "waiting",
  "left_with_seat",
];

/** The API takes up to this many admission numbers in one request. */
export const MAX_CSV_ADMISSION_NUMBERS = 2000;

/** A header naming the school's admission number ("Admission number", "Adm. no", "رقم القيد"). */
const ADMISSION_HEADER = /admission|^adm\b|adm\.?\s*no|رقم\s*القيد|القيد/i;

/**
 * The admission numbers in a CSV: the column headed like "Admission number", or the only column
 * when the file has one. `null` when there are several columns and none is headed so. Blank cells
 * and repeats are dropped. Only the school's admission numbers are read -- never a government ID.
 */
export function admissionNumbersFromCsv(text: string): string[] | null {
  const rows = parseCsv(text);
  if (rows.length === 0) return [];
  const header = rows[0]!;
  const index = header.findIndex((cell) => ADMISSION_HEADER.test(cell.trim()));
  let values: string[];
  if (index >= 0) {
    values = rows.slice(1).map((row) => row.at(index) ?? "");
  } else if (rows.every((row) => row.filter((cell) => cell.trim() !== "").length <= 1)) {
    values = rows.map((row) => row.find((cell) => cell.trim() !== "") ?? "");
  } else {
    return null;
  }
  return [...new Set(values.map((value) => value.trim()).filter(Boolean))];
}

/** "2026-11-17" -> "2026-12-01": when a released seat stops being charged. */
export function firstOfNextMonth(today: string): string {
  const [year, month] = today.split("-").map(Number);
  return new Date(Date.UTC(year!, month!, 1)).toISOString().slice(0, 10);
}

function isLeft(row: AiOptInStudentRow): boolean {
  return LEFT_STUDENT_STATUSES.includes(row.studentStatus);
}

function apiErrorText(error: unknown): string | undefined {
  return error instanceof ApiError ? (error.detail ?? error.title) : undefined;
}

/** Dates and months the API sends as "YYYY-MM-DD", shown in the user's locale. */
function useDay() {
  const { formatDate } = useFormatters();
  return {
    day: (iso: string) =>
      formatDate(new Date(`${iso.slice(0, 10)}T00:00:00Z`), {
        dateStyle: "medium",
        timeZone: "UTC",
      }),
    month: (iso: string) =>
      formatDate(new Date(`${iso.slice(0, 10)}T00:00:00Z`), {
        month: "long",
        year: "numeric",
        timeZone: "UTC",
      }),
  };
}

/**
 * Student AI (`/portal/license/student-ai`), gated by `license:read`: parents add Student AI for
 * their child for the rest of the school's academic year, paid with tuition, and can't cancel
 * mid-year. The page shows the licence's student seats, the programme's minimum, the price parents
 * see and what opting in today costs; how many opted in; the opt-in window; and every student with
 * their choice. `license:manage` opens and closes the window (accepting the minimum), records
 * choices on a parent's behalf (one, a selection, or a CSV of admission numbers), and transfers or
 * releases the seat of a student who left.
 */
export default function StudentAiPage() {
  const { t } = useTranslation();
  const canManage = usePermissions().has(PERMISSIONS.LICENSE_MANAGE);
  const overview = useStudentAiQuery();
  const data = overview.data;

  return (
    <>
      <LicenseHeader
        title={t("schoolLicense.studentAi.title")}
        description={t("schoolLicense.studentAi.description")}
      />
      {overview.isPending ? <p role="status">{t("schoolLicense.common.loading")}</p> : null}
      {overview.isError ? <p role="alert">{t("schoolLicense.common.loadError")}</p> : null}
      {data ? (
        <>
          {data.blocker ? (
            <div className="license-banner" data-tone="warning" data-testid="student-ai-blocker">
              <div>
                <p className="license-banner__title">
                  {t("schoolLicense.studentAi.blocker.title")}
                </p>
                <p className="license-banner__body">
                  {t(`schoolLicense.studentAi.blocker.${data.blocker}`)}
                </p>
              </div>
            </div>
          ) : null}
          <SeatRequestNote overview={data} />
          <Summary overview={data} />
          <WindowSection overview={data} canManage={canManage} />
          <StudentsSection overview={data} canManage={canManage} />
        </>
      ) : null}
    </>
  );
}

/**
 * Opt-ins beyond the licence's seats wait for one; the API asks Studafy for the seats on its own
 * (a change request Studafy prices as a quote).
 */
function SeatRequestNote({ overview }: { overview: StudentAiOverview }) {
  const { t } = useTranslation();
  const { formatNumber } = useFormatters();
  const waiting = overview.counts.waitingForSeat;
  const request = overview.openSeatRequest;
  if (waiting === 0 && !request) return null;
  const asked =
    request && request.studentSeats !== null
      ? t("schoolLicense.studentAi.seatRequest.asked", {
          count: request.studentSeats,
          seats: formatNumber(request.studentSeats),
        })
      : request
        ? t("schoolLicense.studentAi.seatRequest.askedMore")
        : t("schoolLicense.studentAi.seatRequest.notAsked");
  return (
    <div className="license-banner" data-tone="warning" role="status" data-testid="seat-request">
      <div>
        <p className="license-banner__title">
          {waiting > 0
            ? t("schoolLicense.studentAi.seatRequest.waiting", {
                count: waiting,
                students: formatNumber(waiting),
              })
            : t("schoolLicense.studentAi.seatRequest.title")}{" "}
          {asked}
        </p>
        <p className="license-banner__body">
          {t("schoolLicense.studentAi.seatRequest.body")}{" "}
          <Link to="/portal/license/quotes">{t("schoolLicense.studentAi.seatRequest.quotes")}</Link>
        </p>
      </div>
    </div>
  );
}

function Summary({ overview }: { overview: StudentAiOverview }) {
  const { t } = useTranslation();
  const { formatNumber } = useFormatters();
  const money = useMoney();
  const { month } = useDay();
  const { license, programme, pricingToday, counts } = overview;
  const price = programme?.monthlyPriceMinor ?? null;
  const m = (amount: number) =>
    programme ? money(amount, programme.currencyCode, programme.minorUnit) : "";
  const conversion =
    counts.eligible > 0
      ? formatNumber(counts.optedIn / counts.eligible, {
          style: "percent",
          maximumFractionDigits: 0,
        })
      : null;

  return (
    <section className="license-section" aria-labelledby="student-ai-summary">
      <h2 id="student-ai-summary">{t("schoolLicense.studentAi.summary.title")}</h2>
      <dl className="license-facts">
        <div>
          <dt>{t("schoolLicense.studentAi.summary.seats")}</dt>
          <dd data-testid="student-ai-seats">
            {license
              ? t("schoolLicense.studentAi.summary.seatsValue", {
                  assigned: formatNumber(license.assignedStudentSeats),
                  total: formatNumber(license.studentSeats),
                })
              : "—"}
          </dd>
        </div>
        {license ? (
          <div>
            <dt>{t("schoolLicense.commitment.label")}</dt>
            <dd>{t(`schoolLicense.commitment.${license.commitment}`)}</dd>
          </div>
        ) : null}
        <div>
          <dt>{t("schoolLicense.studentAi.summary.minimum")}</dt>
          <dd data-testid="student-ai-minimum">
            {programme
              ? t("schoolLicense.studentAi.summary.minimumValue", {
                  count: programme.minSeats,
                  seats: formatNumber(programme.minSeats),
                })
              : "—"}
          </dd>
        </div>
        <div>
          <dt>{t("schoolLicense.studentAi.summary.parentPrice")}</dt>
          <dd data-testid="student-ai-price">
            {price !== null
              ? t("schoolLicense.studentAi.summary.perMonth", { price: m(price) })
              : t("schoolLicense.studentAi.summary.noPrice")}
          </dd>
        </div>
        <div>
          <dt>{t("schoolLicense.studentAi.summary.today")}</dt>
          <dd data-testid="student-ai-today">
            {pricingToday && price !== null ? (
              <>
                {t("schoolLicense.studentAi.priceSum", {
                  price: m(price),
                  count: pricingToday.months,
                  months: formatNumber(pricingToday.months),
                  total: m(pricingToday.totalMinor),
                })}
                <div className="license-muted">
                  {t("schoolLicense.studentAi.summary.todayRange", {
                    from: month(pricingToday.startMonth),
                    to: month(pricingToday.endMonth),
                  })}
                </div>
              </>
            ) : (
              "—"
            )}
          </dd>
        </div>
      </dl>
      <p className="license-muted">{t("schoolLicense.studentAi.summary.rules")}</p>

      <h3>{t("schoolLicense.studentAi.counts.title")}</h3>
      <dl className="license-facts" data-testid="student-ai-counts">
        <div>
          <dt>{t("schoolLicense.studentAi.counts.optedIn")}</dt>
          <dd>
            {t("schoolLicense.studentAi.counts.optedInValue", {
              optedIn: formatNumber(counts.optedIn),
              eligible: formatNumber(counts.eligible),
            })}
          </dd>
        </div>
        <div>
          <dt>{t("schoolLicense.studentAi.counts.conversion")}</dt>
          <dd>{conversion ?? "—"}</dd>
        </div>
        <div>
          <dt>{t("schoolLicense.studentAi.counts.waiting")}</dt>
          <dd>{formatNumber(counts.waitingForSeat)}</dd>
        </div>
        <div>
          <dt>{t("schoolLicense.studentAi.counts.seatsNeeded")}</dt>
          <dd>{formatNumber(overview.seatsNeeded)}</dd>
        </div>
        <div>
          <dt>{t("schoolLicense.studentAi.counts.released")}</dt>
          <dd>{formatNumber(counts.released)}</dd>
        </div>
        <div>
          <dt>{t("schoolLicense.studentAi.counts.transferred")}</dt>
          <dd>{formatNumber(counts.transferred)}</dd>
        </div>
      </dl>
    </section>
  );
}

const WINDOW_TONE: Record<AiOptInWindow["state"], "success" | "warning" | undefined> = {
  scheduled: "warning",
  open: "success",
  ended: undefined,
  closed: undefined,
};

function WindowSection({
  overview,
  canManage,
}: {
  overview: StudentAiOverview;
  canManage: boolean;
}) {
  const { t } = useTranslation();
  const { formatDate } = useFormatters();
  const { day } = useDay();
  const { show } = useToast();
  const close = useCloseStudentAiWindow();
  const [opening, setOpening] = useState(false);
  const [closing, setClosing] = useState(false);
  const optInWindow = overview.window;
  const live =
    optInWindow !== null && (optInWindow.state === "scheduled" || optInWindow.state === "open");
  const canOpen = canManage && overview.blocker === null && overview.programme !== null && !live;

  function confirmClose() {
    if (!optInWindow) return;
    close.mutate(optInWindow.id, {
      onSuccess: () => {
        show({ variant: "success", title: t("schoolLicense.studentAi.window.closed") });
        setClosing(false);
      },
      onError: (error) =>
        show({
          variant: "error",
          title: t("schoolLicense.common.saveError"),
          description: apiErrorText(error),
        }),
    });
  }

  const scope = optInWindow
    ? [...optInWindow.gradeLevels.map((g) => g.name), ...optInWindow.sections.map((s) => s.name)]
    : [];

  return (
    <section className="license-section" aria-labelledby="student-ai-window">
      <div className="license-section__head">
        <h2 id="student-ai-window">{t("schoolLicense.studentAi.window.title")}</h2>
        <div className="license-toolbar__actions">
          {canManage && live ? (
            <Button variant="secondary" onClick={() => setClosing(true)}>
              {t("schoolLicense.studentAi.window.close")}
            </Button>
          ) : null}
          {canOpen ? (
            <Button variant="primary" onClick={() => setOpening(true)}>
              {t("schoolLicense.studentAi.window.open")}
            </Button>
          ) : null}
        </div>
      </div>
      {optInWindow ? (
        <dl className="license-facts" data-testid="student-ai-window">
          <div>
            <dt>{t("schoolLicense.studentAi.window.state")}</dt>
            <dd>
              <span className="license-pill" data-tone={WINDOW_TONE[optInWindow.state]}>
                {t(`schoolLicense.studentAi.window.states.${optInWindow.state}`)}
              </span>
            </dd>
          </div>
          <div>
            <dt>{t("schoolLicense.studentAi.window.dates")}</dt>
            <dd>
              {t("schoolLicense.overview.periodValue", {
                from: day(optInWindow.opensOn),
                to: day(optInWindow.closesOn),
              })}
            </dd>
          </div>
          <div>
            <dt>{t("schoolLicense.studentAi.window.year")}</dt>
            <dd>{optInWindow.academicYear.name}</dd>
          </div>
          <div>
            <dt>{t("schoolLicense.studentAi.window.scope")}</dt>
            <dd>{scope.length > 0 ? scope.join(", ") : t("schoolLicense.studentAi.window.all")}</dd>
          </div>
          <div>
            <dt>{t("schoolLicense.studentAi.window.openedBy")}</dt>
            <dd>
              {t("schoolLicense.studentAi.window.byOn", {
                name: optInWindow.openedBy.name,
                date: formatDate(new Date(optInWindow.openedAt), { dateStyle: "medium" }),
              })}
            </dd>
          </div>
          {optInWindow.closedBy && optInWindow.closedAt ? (
            <div>
              <dt>{t("schoolLicense.studentAi.window.closedBy")}</dt>
              <dd>
                {t("schoolLicense.studentAi.window.byOn", {
                  name: optInWindow.closedBy.name,
                  date: formatDate(new Date(optInWindow.closedAt), { dateStyle: "medium" }),
                })}
              </dd>
            </div>
          ) : null}
          {optInWindow.note ? (
            <div>
              <dt>{t("schoolLicense.studentAi.window.note")}</dt>
              <dd>{optInWindow.note}</dd>
            </div>
          ) : null}
        </dl>
      ) : (
        <p className="license-muted">{t("schoolLicense.studentAi.window.none")}</p>
      )}
      {opening && overview.programme ? (
        <OpenWindowModal
          today={overview.today}
          minSeats={overview.programme.minSeats}
          onClose={() => setOpening(false)}
        />
      ) : null}
      <Modal
        open={closing}
        onClose={() => setClosing(false)}
        title={t("schoolLicense.studentAi.window.closeTitle")}
      >
        <Modal.Body>
          <p>{t("schoolLicense.studentAi.window.closeBody")}</p>
        </Modal.Body>
        <Modal.Footer>
          <Button type="button" variant="tertiary" onClick={() => setClosing(false)}>
            {t("schoolLicense.common.cancel")}
          </Button>
          <Button type="button" variant="primary" loading={close.isPending} onClick={confirmClose}>
            {t("schoolLicense.studentAi.window.closeConfirm")}
          </Button>
        </Modal.Footer>
      </Modal>
    </section>
  );
}

function toggle(list: readonly string[], id: string, on: boolean): string[] {
  return on ? [...list, id] : list.filter((value) => value !== id);
}

/**
 * Open a window: the academic year (the current one by default), its dates, optionally only some
 * grades or sections, a note, and the school's acceptance that it pays for the programme's minimum
 * seats even if fewer students opt in -- which the API requires.
 */
function OpenWindowModal({
  today,
  minSeats,
  onClose,
}: {
  today: string;
  minSeats: number;
  onClose: () => void;
}) {
  const { t } = useTranslation();
  const { formatNumber } = useFormatters();
  const { show } = useToast();
  const open = useOpenStudentAiWindow();
  const years = useAcademicYears();
  const grades = useGradeLevels();
  const current = pickCurrentYear(years.data ?? []);
  const [yearId, setYearId] = useState("");
  const academicYearId = yearId || current?.id || "";
  const sections = useSections(academicYearId || undefined);
  const [opensOn, setOpensOn] = useState(today);
  const [closesOn, setClosesOn] = useState("");
  const [gradeIds, setGradeIds] = useState<string[]>([]);
  const [sectionIds, setSectionIds] = useState<string[]>([]);
  const [note, setNote] = useState("");
  const [acknowledged, setAcknowledged] = useState(false);
  const datesInvalid = opensOn !== "" && closesOn !== "" && closesOn < opensOn;
  const ready = opensOn !== "" && closesOn !== "" && !datesInvalid && acknowledged;

  function submit() {
    if (!ready || open.isPending) return;
    open.mutate(
      {
        academicYearId: academicYearId || undefined,
        opensOn,
        closesOn,
        gradeLevelIds: gradeIds.length > 0 ? gradeIds : undefined,
        sectionIds: sectionIds.length > 0 ? sectionIds : undefined,
        note: note.trim() || undefined,
        acknowledgeMinimumSeats: true,
      },
      {
        onSuccess: () => {
          show({ variant: "success", title: t("schoolLicense.studentAi.window.opened") });
          onClose();
        },
        onError: (error) =>
          show({
            variant: "error",
            title: t("schoolLicense.studentAi.window.openError"),
            description: apiErrorText(error),
          }),
      },
    );
  }

  return (
    <Modal
      open
      onClose={onClose}
      title={t("schoolLicense.studentAi.window.openTitle")}
      description={t("schoolLicense.studentAi.window.openHelp")}
    >
      <Modal.Body>
        <Select
          label={t("schoolLicense.studentAi.window.year")}
          value={academicYearId}
          onChange={(value) => {
            setYearId(value);
            setSectionIds([]);
          }}
          options={(years.data ?? []).map((year) => ({ value: year.id, label: year.name }))}
        />
        <Input
          label={t("schoolLicense.studentAi.window.opensOn")}
          type="date"
          value={opensOn}
          onChange={(event) => setOpensOn(event.target.value)}
        />
        <Input
          label={t("schoolLicense.studentAi.window.closesOn")}
          type="date"
          min={opensOn || undefined}
          value={closesOn}
          error={datesInvalid ? t("schoolLicense.studentAi.window.datesError") : undefined}
          onChange={(event) => setClosesOn(event.target.value)}
        />
        <fieldset className="license-terms">
          <legend className="license-terms__legend">
            {t("schoolLicense.studentAi.window.grades")}
          </legend>
          <p className="license-muted">{t("schoolLicense.studentAi.window.scopeHelp")}</p>
          {(grades.data ?? []).map((grade) => (
            <Checkbox
              key={grade.id}
              label={grade.name}
              checked={gradeIds.includes(grade.id)}
              onChange={(event) =>
                setGradeIds((prev) => toggle(prev, grade.id, event.target.checked))
              }
            />
          ))}
        </fieldset>
        {(sections.data ?? []).length > 0 ? (
          <fieldset className="license-terms">
            <legend className="license-terms__legend">
              {t("schoolLicense.studentAi.window.sections")}
            </legend>
            {(sections.data ?? []).map((section) => (
              <Checkbox
                key={section.id}
                label={t("schoolLicense.seats.sectionName", {
                  grade: section.grade_level_name,
                  section: section.name,
                })}
                checked={sectionIds.includes(section.id)}
                onChange={(event) =>
                  setSectionIds((prev) => toggle(prev, section.id, event.target.checked))
                }
              />
            ))}
          </fieldset>
        ) : null}
        <Input
          label={t("schoolLicense.studentAi.window.noteLabel")}
          value={note}
          maxLength={1000}
          onChange={(event) => setNote(event.target.value)}
        />
        <div className="license-banner" data-tone="warning" data-testid="minimum-warning">
          <div>
            <p className="license-banner__title">
              {t("schoolLicense.studentAi.minimum.title", {
                count: minSeats,
                seats: formatNumber(minSeats),
              })}
            </p>
            <p className="license-banner__body">{t("schoolLicense.studentAi.minimum.body")}</p>
          </div>
        </div>
        <Checkbox
          label={t("schoolLicense.studentAi.minimum.acknowledge", {
            count: minSeats,
            seats: formatNumber(minSeats),
          })}
          required
          checked={acknowledged}
          onChange={(event) => setAcknowledged(event.target.checked)}
        />
      </Modal.Body>
      <Modal.Footer>
        <Button type="button" variant="tertiary" onClick={onClose}>
          {t("schoolLicense.common.cancel")}
        </Button>
        <Button
          type="button"
          variant="primary"
          disabled={!ready}
          loading={open.isPending}
          onClick={submit}
        >
          {t("schoolLicense.studentAi.window.openConfirm")}
        </Button>
      </Modal.Footer>
    </Modal>
  );
}

const EMPTY_FILTERS: StudentAiFilters = {
  filter: "all",
  search: "",
  gradeLevelId: "",
  sectionId: "",
  page: 0,
};

type RecordTarget =
  | { kind: "students"; rows: AiOptInStudentRow[] }
  | { kind: "csv"; fileName: string; admissionNumbers: string[] };

function StudentsSection({
  overview,
  canManage,
}: {
  overview: StudentAiOverview;
  canManage: boolean;
}) {
  const { t } = useTranslation();
  const { formatNumber } = useFormatters();
  const { show } = useToast();
  const [filters, setFilters] = useState(EMPTY_FILTERS);
  const search = useDebounced(filters.search.trim(), 300);
  const students = useStudentAiStudentsQuery({ ...filters, search });
  const [selected, setSelected] = useState<ReadonlySet<string>>(new Set());
  const [recording, setRecording] = useState<RecordTarget | null>(null);
  const [report, setReport] = useState<{
    result: RecordOptInsResult;
    names: Map<string, string>;
  } | null>(null);
  const [transferring, setTransferring] = useState<AiOptInStudentRow | null>(null);
  const [releasing, setReleasing] = useState<AiOptInStudentRow | null>(null);
  const fileInput = useRef<HTMLInputElement>(null);

  const years = useAcademicYears();
  const yearId = overview.window?.academicYear.id ?? pickCurrentYear(years.data ?? [])?.id;
  const grades = useGradeLevels();
  const sections = useSections(yearId);
  const sectionOptions = (sections.data ?? []).filter(
    (section) => !filters.gradeLevelId || section.grade_level_id === filters.gradeLevelId,
  );

  const windowOpen = overview.window?.state === "open";
  const rows = students.data?.students ?? [];
  const total = students.data?.total ?? 0;
  const selectable = (row: AiOptInStudentRow) =>
    canManage && windowOpen && row.eligible && row.optIn?.status !== "active";
  const selectableRows = rows.filter(selectable);
  const picked = rows.filter((row) => selected.has(row.studentId) && selectable(row));

  function setFilter(patch: Partial<StudentAiFilters>) {
    setFilters((prev) => ({ ...prev, page: 0, ...patch }));
    setSelected(new Set());
  }

  async function readCsv(file: File) {
    let numbers: string[] | null;
    try {
      const text = isXlsxFile(file)
        ? xlsxToCsv(new Uint8Array(await file.arrayBuffer()))
        : await file.text();
      numbers = admissionNumbersFromCsv(text);
    } catch {
      numbers = null;
    }
    if (numbers === null) {
      show({ variant: "error", title: t("schoolLicense.studentAi.csv.noColumn") });
      return;
    }
    if (numbers.length === 0) {
      show({ variant: "error", title: t("schoolLicense.studentAi.csv.empty") });
      return;
    }
    if (numbers.length > MAX_CSV_ADMISSION_NUMBERS) {
      show({
        variant: "error",
        title: t("schoolLicense.studentAi.csv.tooMany", {
          max: formatNumber(MAX_CSV_ADMISSION_NUMBERS),
        }),
      });
      return;
    }
    setRecording({ kind: "csv", fileName: file.name, admissionNumbers: numbers });
  }

  return (
    <section className="license-section" aria-labelledby="student-ai-students">
      <h2 id="student-ai-students">{t("schoolLicense.studentAi.students.title")}</h2>
      <div
        className="license-toolbar"
        role="group"
        aria-label={t("schoolLicense.studentAi.students.filters")}
      >
        <Input
          label={t("schoolLicense.studentAi.students.search")}
          type="search"
          value={filters.search}
          onChange={(event) => setFilter({ search: event.target.value })}
        />
        <Select
          label={t("schoolLicense.studentAi.students.show")}
          value={filters.filter}
          onChange={(filter) => setFilter({ filter })}
          options={FILTERS.map((value) => ({
            value,
            label: t(`schoolLicense.studentAi.students.filter.${value}`),
          }))}
        />
        <Select
          label={t("schoolLicense.seats.grade")}
          value={filters.gradeLevelId}
          onChange={(gradeLevelId) => setFilter({ gradeLevelId, sectionId: "" })}
          options={[
            { value: "", label: t("schoolLicense.seats.anyGrade") },
            ...(grades.data ?? []).map((grade) => ({ value: grade.id, label: grade.name })),
          ]}
        />
        <Select
          label={t("schoolLicense.seats.section")}
          value={filters.sectionId}
          onChange={(sectionId) => setFilter({ sectionId })}
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
      </div>

      {canManage ? (
        <div
          className="license-toolbar"
          role="group"
          aria-label={t("schoolLicense.studentAi.students.bulk")}
        >
          <div className="license-toolbar__actions">
            <Button
              variant="primary"
              disabled={picked.length === 0}
              onClick={() => setRecording({ kind: "students", rows: picked })}
            >
              {t("schoolLicense.studentAi.record.selected", { count: picked.length })}
            </Button>
            <Button
              variant="secondary"
              disabled={!windowOpen}
              onClick={() => fileInput.current?.click()}
            >
              {t("schoolLicense.studentAi.csv.import")}
            </Button>
            <input
              ref={fileInput}
              type="file"
              hidden
              accept=".csv,text/csv,.xlsx"
              aria-label={t("schoolLicense.studentAi.csv.fileLabel")}
              onChange={(event) => {
                const file = event.target.files?.[0];
                event.target.value = "";
                if (file) void readCsv(file);
              }}
            />
          </div>
          <p className="license-muted">
            {windowOpen
              ? t("schoolLicense.studentAi.csv.help")
              : t("schoolLicense.studentAi.record.needsWindow")}
          </p>
        </div>
      ) : null}

      {report ? (
        <RecordReport
          result={report.result}
          names={report.names}
          onDismiss={() => setReport(null)}
        />
      ) : null}

      <Table caption={t("schoolLicense.studentAi.students.title")} hideCaption>
        <Table.Header>
          <Table.Row>
            {canManage ? (
              <Table.HeaderCell>
                <input
                  type="checkbox"
                  aria-label={t("schoolLicense.seats.selectPage")}
                  checked={
                    selectableRows.length > 0 &&
                    selectableRows.every((row) => selected.has(row.studentId))
                  }
                  disabled={selectableRows.length === 0}
                  onChange={(event) =>
                    setSelected(
                      event.target.checked
                        ? new Set(selectableRows.map((row) => row.studentId))
                        : new Set(),
                    )
                  }
                />
              </Table.HeaderCell>
            ) : null}
            <Table.HeaderCell>
              {t("schoolLicense.studentAi.students.columns.student")}
            </Table.HeaderCell>
            <Table.HeaderCell>
              {t("schoolLicense.studentAi.students.columns.class")}
            </Table.HeaderCell>
            <Table.HeaderCell>
              {t("schoolLicense.studentAi.students.columns.status")}
            </Table.HeaderCell>
            <Table.HeaderCell>
              {t("schoolLicense.studentAi.students.columns.price")}
            </Table.HeaderCell>
            {canManage ? (
              <Table.HeaderCell>{t("schoolLicense.common.actions")}</Table.HeaderCell>
            ) : null}
          </Table.Row>
        </Table.Header>
        <Table.Body
          columnCount={canManage ? 6 : 4}
          loading={students.isPending}
          empty={
            students.isError
              ? t("schoolLicense.common.loadError")
              : t("schoolLicense.studentAi.students.empty")
          }
        >
          {rows.map((row) => (
            <Table.Row
              key={row.studentId}
              aria-selected={canManage ? selected.has(row.studentId) : undefined}
            >
              {canManage ? (
                <Table.Cell>
                  {selectable(row) ? (
                    <input
                      type="checkbox"
                      aria-label={t("schoolLicense.seats.selectPerson", { name: row.name })}
                      checked={selected.has(row.studentId)}
                      onChange={(event) =>
                        setSelected((prev) => {
                          const next = new Set(prev);
                          if (event.target.checked) next.add(row.studentId);
                          else next.delete(row.studentId);
                          return next;
                        })
                      }
                    />
                  ) : null}
                </Table.Cell>
              ) : null}
              <Table.Cell>
                <div>{row.name}</div>
                <div className="license-muted">
                  {t("schoolLicense.studentAi.students.admission", {
                    number: row.admissionNumber,
                  })}
                </div>
              </Table.Cell>
              <Table.Cell>
                {row.gradeLevelName && row.sectionName
                  ? t("schoolLicense.seats.sectionName", {
                      grade: row.gradeLevelName,
                      section: row.sectionName,
                    })
                  : (row.gradeLevelName ?? "—")}
              </Table.Cell>
              <Table.Cell>
                <StatusBadges row={row} />
              </Table.Cell>
              <Table.Cell>{row.optIn ? <OptInPrice optIn={row.optIn} /> : "—"}</Table.Cell>
              {canManage ? (
                <Table.Cell>
                  <RowActions
                    row={row}
                    selectable={selectable(row)}
                    onRecord={() => setRecording({ kind: "students", rows: [row] })}
                    onTransfer={() => setTransferring(row)}
                    onRelease={() => setReleasing(row)}
                  />
                </Table.Cell>
              ) : null}
            </Table.Row>
          ))}
        </Table.Body>
      </Table>

      {total > STUDENT_AI_PAGE_SIZE ? (
        <div className="license-pager">
          <span className="license-muted">
            {t("schoolLicense.seats.page", {
              from: formatNumber(filters.page * STUDENT_AI_PAGE_SIZE + 1),
              to: formatNumber(Math.min(total, (filters.page + 1) * STUDENT_AI_PAGE_SIZE)),
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
            disabled={(filters.page + 1) * STUDENT_AI_PAGE_SIZE >= total}
            onClick={() => setFilters((prev) => ({ ...prev, page: prev.page + 1 }))}
          >
            {t("schoolLicense.seats.next")}
          </Button>
        </div>
      ) : null}

      {recording ? (
        <RecordModal
          target={recording}
          overview={overview}
          onClose={() => setRecording(null)}
          onRecorded={(result) => {
            const names = new Map<string, string>(
              recording.kind === "students"
                ? recording.rows.map((row) => [row.studentId, row.name] as const)
                : [],
            );
            setReport({ result, names });
            setSelected(new Set());
            setRecording(null);
          }}
        />
      ) : null}
      {transferring ? (
        <TransferModal from={transferring} onClose={() => setTransferring(null)} />
      ) : null}
      {releasing ? (
        <ReleaseModal row={releasing} today={overview.today} onClose={() => setReleasing(null)} />
      ) : null}
    </section>
  );
}

/** "$6.00 × 8 months = $48.00". */
function OptInPrice({ optIn }: { optIn: AiOptIn }) {
  const { t } = useTranslation();
  const { formatNumber } = useFormatters();
  const money = useMoney();
  const m = (amount: number) => money(amount, optIn.currencyCode, optIn.minorUnit);
  return (
    <span className="license-amount">
      {t("schoolLicense.studentAi.priceSum", {
        price: m(optIn.monthlyPriceMinor),
        count: optIn.months,
        months: formatNumber(optIn.months),
        total: m(optIn.totalMinor),
      })}
    </span>
  );
}

function Pill({
  tone,
  children,
}: {
  tone?: "success" | "warning" | "danger";
  children: ReactNode;
}) {
  return (
    <span className="license-pill" data-tone={tone}>
      {children}
    </span>
  );
}

/**
 * Where a student stands: who opted them in (the parent, the school on the parent's behalf, or a
 * transferred seat), still waiting for a seat, released (and from which month) or transferred
 * away; plus whether they have left the school.
 */
function StatusBadges({ row }: { row: AiOptInStudentRow }) {
  const { t } = useTranslation();
  const { month } = useDay();
  const optIn = row.optIn;
  const badges: ReactNode[] = [];
  if (!optIn || optIn.status !== "active") {
    if (optIn?.status === "released") {
      badges.push(
        <Pill key="released">
          {optIn.releasedEffectiveMonth
            ? t("schoolLicense.studentAi.badge.releasedFrom", {
                month: month(optIn.releasedEffectiveMonth),
              })
            : t("schoolLicense.studentAi.badge.released")}
        </Pill>,
      );
    } else if (optIn?.status === "transferred") {
      badges.push(<Pill key="transferred">{t("schoolLicense.studentAi.badge.transferred")}</Pill>);
    } else if (!isLeft(row)) {
      badges.push(
        <Pill key="none">
          {row.eligible
            ? t("schoolLicense.studentAi.badge.notOptedIn")
            : t("schoolLicense.studentAi.badge.notInWindow")}
        </Pill>,
      );
    }
  } else {
    badges.push(
      <Pill key="source" tone="success">
        {t(`schoolLicense.studentAi.badge.source.${optIn.source}`)}
      </Pill>,
    );
    if (optIn.seatId === null) {
      badges.push(
        <Pill key="waiting" tone="warning">
          {t("schoolLicense.studentAi.badge.waiting")}
        </Pill>,
      );
    }
  }
  if (isLeft(row)) {
    badges.push(
      <Pill key="left" tone={optIn?.status === "active" ? "danger" : undefined}>
        {t("schoolLicense.studentAi.badge.left")}
      </Pill>,
    );
  }
  return <span className="license-badges">{badges}</span>;
}

function RowActions({
  row,
  selectable,
  onRecord,
  onTransfer,
  onRelease,
}: {
  row: AiOptInStudentRow;
  selectable: boolean;
  onRecord: () => void;
  onTransfer: () => void;
  onRelease: () => void;
}) {
  const { t } = useTranslation();
  // Only a student who left the school can give up their seat: it moves to another student, or
  // stops being charged from next month.
  if (row.optIn?.status === "active" && isLeft(row)) {
    return (
      <div className="license-toolbar__actions">
        <Button
          variant="secondary"
          aria-label={t("schoolLicense.studentAi.transfer.named", { name: row.name })}
          onClick={onTransfer}
        >
          {t("schoolLicense.studentAi.transfer.action")}
        </Button>
        <Button
          variant="tertiary"
          aria-label={t("schoolLicense.studentAi.release.named", { name: row.name })}
          onClick={onRelease}
        >
          {t("schoolLicense.studentAi.release.action")}
        </Button>
      </div>
    );
  }
  if (selectable) {
    return (
      <Button
        variant="tertiary"
        aria-label={t("schoolLicense.studentAi.record.named", { name: row.name })}
        onClick={onRecord}
      >
        {t("schoolLicense.studentAi.record.action")}
      </Button>
    );
  }
  return null;
}

/**
 * Record parents' choices on their behalf. It is the same commitment the parent makes in the app
 * (the rest of the school year, paid with tuition, no cancelling mid-year), so the price and total
 * are shown, and a note saying how the choice reached the school is required.
 */
function RecordModal({
  target,
  overview,
  onClose,
  onRecorded,
}: {
  target: RecordTarget;
  overview: StudentAiOverview;
  onClose: () => void;
  onRecorded: (result: RecordOptInsResult) => void;
}) {
  const { t } = useTranslation();
  const { formatNumber } = useFormatters();
  const money = useMoney();
  const { show } = useToast();
  const record = useRecordStudentAiOptIns();
  const [note, setNote] = useState("");
  const [touched, setTouched] = useState(false);
  const count = target.kind === "students" ? target.rows.length : target.admissionNumbers.length;
  const noteMissing = note.trim() === "";
  const { programme, pricingToday } = overview;
  const price = programme?.monthlyPriceMinor ?? null;
  const m = (amount: number) =>
    programme ? money(amount, programme.currencyCode, programme.minorUnit) : "";

  function submit() {
    setTouched(true);
    if (noteMissing || record.isPending) return;
    record.mutate(
      target.kind === "students"
        ? { studentIds: target.rows.map((row) => row.studentId), note: note.trim() }
        : { admissionNumbers: target.admissionNumbers, note: note.trim() },
      {
        onSuccess: (result) => {
          show({
            variant: result.notRecorded.length > 0 ? "warning" : "success",
            title: t("schoolLicense.studentAi.record.done", { count: result.recorded.length }),
          });
          onRecorded(result);
        },
        onError: (error) =>
          show({
            variant: "error",
            title: t("schoolLicense.studentAi.record.error"),
            description: apiErrorText(error),
          }),
      },
    );
  }

  return (
    <Modal
      open
      onClose={onClose}
      title={t("schoolLicense.studentAi.record.title", {
        count,
        students: formatNumber(count),
      })}
    >
      <Modal.Body>
        {target.kind === "students" && target.rows.length <= 10 ? (
          <ul className="license-list">
            {target.rows.map((row) => (
              <li key={row.studentId}>{row.name}</li>
            ))}
          </ul>
        ) : null}
        {target.kind === "csv" ? (
          <p data-testid="csv-summary">
            {t("schoolLicense.studentAi.csv.found", {
              count,
              numbers: formatNumber(count),
              file: target.fileName,
            })}
          </p>
        ) : null}
        {pricingToday && price !== null ? (
          <div className="license-note" data-testid="record-price">
            <p>
              {t("schoolLicense.studentAi.record.each", {
                sum: t("schoolLicense.studentAi.priceSum", {
                  price: m(price),
                  count: pricingToday.months,
                  months: formatNumber(pricingToday.months),
                  total: m(pricingToday.totalMinor),
                }),
              })}
            </p>
            <p>
              {t(
                target.kind === "csv"
                  ? "schoolLicense.studentAi.record.totalUpTo"
                  : "schoolLicense.studentAi.record.total",
                {
                  count,
                  students: formatNumber(count),
                  total: m(pricingToday.totalMinor * count),
                },
              )}
            </p>
            <p>{t("schoolLicense.studentAi.record.commitment")}</p>
          </div>
        ) : null}
        <Input
          label={t("schoolLicense.studentAi.record.noteLabel")}
          helperText={t("schoolLicense.studentAi.record.noteHelp")}
          required
          value={note}
          maxLength={1000}
          error={touched && noteMissing ? t("schoolLicense.studentAi.noteRequired") : undefined}
          onBlur={() => setTouched(true)}
          onChange={(event) => setNote(event.target.value)}
        />
      </Modal.Body>
      <Modal.Footer>
        <Button type="button" variant="tertiary" onClick={onClose}>
          {t("schoolLicense.common.cancel")}
        </Button>
        <Button
          type="button"
          variant="primary"
          disabled={noteMissing}
          loading={record.isPending}
          onClick={submit}
        >
          {t("schoolLicense.studentAi.record.confirm")}
        </Button>
      </Modal.Footer>
    </Modal>
  );
}

const NOT_RECORDED = ["already_opted_in", "not_eligible", "not_found"] as const;

/** What a recording did: how many were recorded, and who was not and why. */
function RecordReport({
  result,
  names,
  onDismiss,
}: {
  result: RecordOptInsResult;
  names: Map<string, string>;
  onDismiss: () => void;
}) {
  const { t } = useTranslation();
  return (
    <section
      className="license-banner"
      data-tone={result.notRecorded.length > 0 ? "warning" : "neutral"}
      aria-labelledby="record-report"
      role="status"
    >
      <div>
        <p id="record-report" className="license-banner__title">
          {t("schoolLicense.studentAi.report.recorded", { count: result.recorded.length })}
        </p>
        {result.recorded.some((optIn) => optIn?.seatId === null) ? (
          <p className="license-banner__body">
            {t("schoolLicense.studentAi.report.waiting", {
              count: result.recorded.filter((optIn) => optIn?.seatId === null).length,
            })}
          </p>
        ) : null}
        {NOT_RECORDED.map((reason) => {
          const rows = result.notRecorded.filter((row) => row.reason === reason);
          if (rows.length === 0) return null;
          const label = t(`schoolLicense.studentAi.report.${reason}`, { count: rows.length });
          return (
            <div key={reason}>
              <p className="license-banner__body">{label}</p>
              <ul className="license-list" aria-label={label}>
                {rows.map((row) => (
                  <li key={`${row.studentId ?? ""}-${row.reference}`}>
                    {(row.studentId && names.get(row.studentId)) || row.reference}
                  </li>
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

/**
 * Give a left student's seat to another enrolled student who has not opted in. The opt-in moves
 * with its months and price; nothing changes on the bill.
 */
function TransferModal({ from, onClose }: { from: AiOptInStudentRow; onClose: () => void }) {
  const { t } = useTranslation();
  const { show } = useToast();
  const transfer = useTransferStudentAiOptIn();
  const [search, setSearch] = useState("");
  const debounced = useDebounced(search.trim(), 300);
  const candidates = useStudentAiStudentsQuery({
    filter: "not_opted_in",
    search: debounced,
    gradeLevelId: "",
    sectionId: "",
    page: 0,
    limit: 20,
  });
  const [toId, setToId] = useState("");
  const [note, setNote] = useState("");
  const [touched, setTouched] = useState(false);
  const noteMissing = note.trim() === "";
  const options = (candidates.data?.students ?? []).filter(
    (row) => row.studentId !== from.studentId,
  );
  const to = options.find((row) => row.studentId === toId);

  function submit() {
    setTouched(true);
    if (!from.optIn || !to || noteMissing || transfer.isPending) return;
    transfer.mutate(
      { optInId: from.optIn.id, toStudentId: to.studentId, note: note.trim() },
      {
        onSuccess: () => {
          show({
            variant: "success",
            title: t("schoolLicense.studentAi.transfer.done", { from: from.name, to: to.name }),
          });
          onClose();
        },
        onError: (error) =>
          show({
            variant: "error",
            title: t("schoolLicense.common.saveError"),
            description: apiErrorText(error),
          }),
      },
    );
  }

  return (
    <Modal
      open
      onClose={onClose}
      title={t("schoolLicense.studentAi.transfer.title", { name: from.name })}
      description={t("schoolLicense.studentAi.transfer.help")}
    >
      <Modal.Body>
        <Input
          label={t("schoolLicense.studentAi.transfer.search")}
          type="search"
          value={search}
          onChange={(event) => setSearch(event.target.value)}
        />
        <fieldset className="license-terms">
          <legend className="license-terms__legend">
            {t("schoolLicense.studentAi.transfer.to")}
          </legend>
          {candidates.isPending ? (
            <p role="status">{t("schoolLicense.common.loading")}</p>
          ) : options.length === 0 ? (
            <p className="license-muted">{t("schoolLicense.studentAi.transfer.none")}</p>
          ) : (
            options.map((row) => (
              <label key={row.studentId} className="license-radio">
                <input
                  type="radio"
                  name="transfer-to"
                  value={row.studentId}
                  checked={toId === row.studentId}
                  onChange={() => setToId(row.studentId)}
                />{" "}
                {t("schoolLicense.studentAi.transfer.option", {
                  name: row.name,
                  number: row.admissionNumber,
                })}
              </label>
            ))
          )}
        </fieldset>
        <Input
          label={t("schoolLicense.studentAi.noteLabel")}
          required
          value={note}
          maxLength={1000}
          error={touched && noteMissing ? t("schoolLicense.studentAi.noteRequired") : undefined}
          onBlur={() => setTouched(true)}
          onChange={(event) => setNote(event.target.value)}
        />
      </Modal.Body>
      <Modal.Footer>
        <Button type="button" variant="tertiary" onClick={onClose}>
          {t("schoolLicense.common.cancel")}
        </Button>
        <Button
          type="button"
          variant="primary"
          disabled={!to || noteMissing}
          loading={transfer.isPending}
          onClick={submit}
        >
          {t("schoolLicense.studentAi.transfer.confirm")}
        </Button>
      </Modal.Footer>
    </Modal>
  );
}

/** End a left student's seat: the school is no longer charged for it from next month. */
function ReleaseModal({
  row,
  today,
  onClose,
}: {
  row: AiOptInStudentRow;
  today: string;
  onClose: () => void;
}) {
  const { t } = useTranslation();
  const { month } = useDay();
  const { show } = useToast();
  const release = useReleaseStudentAiOptIn();
  const [note, setNote] = useState("");
  const [touched, setTouched] = useState(false);
  const noteMissing = note.trim() === "";

  function submit() {
    setTouched(true);
    if (!row.optIn || noteMissing || release.isPending) return;
    release.mutate(
      { optInId: row.optIn.id, note: note.trim() },
      {
        onSuccess: (optIn) => {
          show({
            variant: "success",
            title: t("schoolLicense.studentAi.release.done", {
              name: row.name,
              month: month(optIn.releasedEffectiveMonth ?? firstOfNextMonth(today)),
            }),
          });
          onClose();
        },
        onError: (error) =>
          show({
            variant: "error",
            title: t("schoolLicense.common.saveError"),
            description: apiErrorText(error),
          }),
      },
    );
  }

  return (
    <Modal
      open
      onClose={onClose}
      title={t("schoolLicense.studentAi.release.title", { name: row.name })}
    >
      <Modal.Body>
        <p data-testid="release-effective">
          {t("schoolLicense.studentAi.release.body", { month: month(firstOfNextMonth(today)) })}
        </p>
        <p className="license-muted">{t("schoolLicense.studentAi.release.refunds")}</p>
        <Input
          label={t("schoolLicense.studentAi.noteLabel")}
          required
          value={note}
          maxLength={1000}
          error={touched && noteMissing ? t("schoolLicense.studentAi.noteRequired") : undefined}
          onBlur={() => setTouched(true)}
          onChange={(event) => setNote(event.target.value)}
        />
      </Modal.Body>
      <Modal.Footer>
        <Button type="button" variant="tertiary" onClick={onClose}>
          {t("schoolLicense.common.cancel")}
        </Button>
        <Button
          type="button"
          variant="primary"
          disabled={noteMissing}
          loading={release.isPending}
          onClick={submit}
        >
          {t("schoolLicense.studentAi.release.confirm")}
        </Button>
      </Modal.Footer>
    </Modal>
  );
}
