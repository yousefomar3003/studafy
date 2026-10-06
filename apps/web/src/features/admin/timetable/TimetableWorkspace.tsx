import { ApiError } from "@studafy/api-client";
import { Button, Modal, Select, useToast } from "@studafy/ui";
import { useQuery } from "@tanstack/react-query";
import { useCallback, useEffect, useState } from "react";

import { ExportCsvButton } from "../../../components/ExportCsvButton";
import { allRows } from "../../../lib/data-transfer";
import { useFormatters, useTranslation } from "../../../lib/i18n";

import { weekdayLabel } from "./constants";
import {
  useApproveVersion,
  useDiscardDraft,
  usePublishVersion,
  useReturnToDraft,
  useStartEditing,
} from "./mutations";
import {
  ACADEMIC_YEARS_KEY,
  ROOMS_KEY,
  TEACHER_CONTACTS_KEY,
  TIMETABLE_SETTINGS_KEY,
  classesForTermQueryKey,
  fetchAcademicYears,
  fetchClassesForTerm,
  fetchRooms,
  fetchSlots,
  fetchTeacherContacts,
  fetchTerms,
  fetchTimetableSettings,
  fetchVersions,
  pickLiveVersion,
  pickWorkingVersion,
  slotsQueryKey,
  termsQueryKey,
  versionsQueryKey,
} from "./queries";
import { SchoolWeekModal } from "./SchoolWeekModal";
import { TimetableGrid } from "./TimetableGrid";

import "./timetable.css";

import type { AcademicYear, Term, TimetableSlot, TimetableVersion } from "./queries";
import type { ExportColumn } from "../../../lib/data-transfer";
import type { SelectOption } from "@studafy/ui";
import type { ReactNode } from "react";

const ALL = "all";

/** Picks the school's active year/term by default, falling back to the first one — mirrors the
 * "planned/active/closed/archived" lifecycle terms and years share (`academicYearStatusSchema`). */
function preferActive<T extends { id: string; status: string }>(items: readonly T[]): string {
  return (items.find((item) => item.status === "active") ?? items[0])?.id ?? "";
}

/**
 * Version names are unique per term (`uq_timetable_versions_school_term_name`), and every edit
 * leaves the published version behind as history — so each new draft gets the next free
 * "<name> (n)" rather than reusing the live version's name.
 */
function uniqueVersionName(base: string, versions: readonly TimetableVersion[]): string {
  const taken = new Set(versions.map((version) => version.name));
  if (!taken.has(base)) return base;
  let suffix = 2;
  while (taken.has(`${base} (${suffix})`)) suffix += 1;
  return `${base} (${suffix})`;
}

function apiErrorDescription(error: unknown): string | undefined {
  return error instanceof ApiError ? (error.detail ?? error.title) : undefined;
}

export interface TimetableWorkspaceProps {
  title: string;
  intro: string;
  /** Holds `timetable:manage`: may edit, publish, discard, and change the school week. */
  canManage: boolean;
  /** Rendered under the intro (e.g. the admin page's help link). */
  aside?: ReactNode;
}

/**
 * The timetable screen shared by the admin console and the principal portal.
 *
 * Everyone sees the term's live timetable — the most recently approved version — narrowed to one
 * class or one teacher on demand. Managers edit it the safe way: "Edit timetable" opens a draft copy
 * (`POST …/copy`), changes there are invisible to teachers and students, and "Publish" makes the
 * draft live in one step (`POST …/publish`). "Discard" throws the draft away. A term with no
 * timetable yet starts from an empty draft. Versions someone submitted through the older two-step
 * review flow can still be approved or sent back from here.
 */
export function TimetableWorkspace({ title, intro, canManage, aside }: TimetableWorkspaceProps) {
  const { t } = useTranslation();
  const { formatDate } = useFormatters();
  const { show } = useToast();

  const [yearId, setYearId] = useState("");
  const [termId, setTermId] = useState("");
  const [view, setView] = useState<"live" | "working">("live");
  const [classFilter, setClassFilter] = useState(ALL);
  const [teacherFilter, setTeacherFilter] = useState(ALL);
  const [weekOpen, setWeekOpen] = useState(false);
  const [confirmDiscard, setConfirmDiscard] = useState(false);

  const yearsQuery = useQuery({ queryKey: ACADEMIC_YEARS_KEY, queryFn: fetchAcademicYears });
  const termsQuery = useQuery({
    queryKey: termsQueryKey(yearId),
    queryFn: () => fetchTerms(yearId),
    enabled: yearId !== "",
  });
  const versionsQuery = useQuery({
    queryKey: versionsQueryKey(termId),
    queryFn: () => fetchVersions(termId),
    enabled: termId !== "",
  });
  const classesQuery = useQuery({
    queryKey: classesForTermQueryKey(termId),
    queryFn: () => fetchClassesForTerm(termId),
    enabled: termId !== "",
  });
  const teachersQuery = useQuery({ queryKey: TEACHER_CONTACTS_KEY, queryFn: fetchTeacherContacts });
  const roomsQuery = useQuery({ queryKey: ROOMS_KEY, queryFn: fetchRooms });
  const settingsQuery = useQuery({
    queryKey: TIMETABLE_SETTINGS_KEY,
    queryFn: fetchTimetableSettings,
  });

  const versions = versionsQuery.data ?? [];
  const live = pickLiveVersion(versions);
  const working = canManage ? pickWorkingVersion(versions) : undefined;
  // A manager sees the draft when they chose to, or when the term has nothing live yet.
  const shown: TimetableVersion | undefined =
    (view === "working" || !live) && working ? working : live;

  const slotsQuery = useQuery({
    queryKey: slotsQueryKey(shown?.id ?? ""),
    queryFn: () => fetchSlots(shown!.id),
    enabled: shown !== undefined,
  });

  const startEditing = useStartEditing();
  const publish = usePublishVersion();
  const discard = useDiscardDraft();
  const approve = useApproveVersion();
  const returnToDraft = useReturnToDraft();

  // Default to the active year, then its active term — re-derived whenever the parent selection
  // changes and the child has no selection of its own yet.
  useEffect(() => {
    if (yearId === "" && yearsQuery.data) {
      setYearId(preferActive(yearsQuery.data as AcademicYear[]));
    }
  }, [yearId, yearsQuery.data]);

  useEffect(() => {
    setTermId("");
  }, [yearId]);

  useEffect(() => {
    if (termId === "" && termsQuery.data) {
      setTermId(preferActive(termsQuery.data as Term[]));
    }
  }, [termId, termsQuery.data]);

  // Each term opens on its live timetable with the filters cleared.
  useEffect(() => {
    setView("live");
    setClassFilter(ALL);
    setTeacherFilter(ALL);
  }, [termId]);

  const classes = [...(classesQuery.data ?? [])].sort((a, b) => a.code.localeCompare(b.code));
  const teachers = [...(teachersQuery.data ?? [])].sort((a, b) =>
    a.display_name.localeCompare(b.display_name),
  );
  const rooms = roomsQuery.data ?? [];
  const slots = slotsQuery.data ?? [];
  const settings = settingsQuery.data ?? { school_days: [7, 1, 2, 3, 4], periods_per_day: 8 };
  const editing = shown !== undefined && shown.status === "draft" && canManage;
  const selectedTerm = termsQuery.data?.find((term) => term.id === termId);

  const isVisible = useCallback(
    (slot: TimetableSlot) =>
      (classFilter === ALL || slot.class_id === classFilter) &&
      (teacherFilter === ALL || slot.teacher_id === teacherFilter),
    [classFilter, teacherFilter],
  );
  const visibleSlots = slots.filter(isVisible);

  // --- Export: the lessons on screen, week order, ids resolved to what the grid shows ---------
  const classById = new Map(classes.map((klass) => [klass.id, klass]));
  const teacherById = new Map(teachers.map((teacher) => [teacher.id, teacher]));
  const roomById = new Map(rooms.map((room) => [room.id, room]));
  const exportColumns: ExportColumn<TimetableSlot>[] = [
    {
      header: t("adminSchool.timetable.export.day"),
      value: (slot) => weekdayLabel(slot.weekday, t),
    },
    { header: t("adminSchool.timetable.grid.period"), value: (slot) => slot.period },
    {
      header: t("adminSchool.timetable.export.class"),
      value: (slot) =>
        classById.get(slot.class_id)?.code ?? t("adminSchool.timetable.unknownClass"),
    },
    {
      header: t("adminSchool.timetable.editModal.teacher"),
      value: (slot) =>
        teacherById.get(slot.teacher_id)?.display_name ?? t("adminSchool.timetable.unknownTeacher"),
    },
    {
      header: t("adminSchool.timetable.export.employeeNumber"),
      value: (slot) => teacherById.get(slot.teacher_id)?.employee_number,
    },
    {
      header: t("adminSchool.timetable.editModal.room"),
      value: (slot) => roomById.get(slot.room_id)?.code ?? t("adminSchool.timetable.unknownRoom"),
    },
  ];
  const dayOrder = (weekday: number) => {
    const index = settings.school_days.indexOf(weekday);
    return index === -1 ? 7 + weekday : index;
  };
  const exportSlots = () =>
    Promise.resolve(
      allRows(
        [...visibleSlots].sort(
          (a, b) =>
            dayOrder(a.weekday) - dayOrder(b.weekday) ||
            a.period - b.period ||
            (classById.get(a.class_id)?.code ?? "").localeCompare(
              classById.get(b.class_id)?.code ?? "",
            ),
        ),
      ),
    );

  // --- Actions ------------------------------------------------------------------------------
  function handleEdit() {
    if (working) {
      setView("working");
      return;
    }
    if (!selectedTerm) return;
    startEditing.mutate(
      {
        termId,
        academicYearId: selectedTerm.academic_year_id,
        name: uniqueVersionName(
          t("adminSchool.timetable.workspace.defaultName", { term: selectedTerm.name }),
          versions,
        ),
        sourceVersionId: live?.id,
      },
      {
        onSuccess: () => setView("working"),
        onError: (err) =>
          show({
            variant: "error",
            title: t("adminSchool.timetable.toast.editFailed"),
            description: apiErrorDescription(err),
          }),
      },
    );
  }

  function handlePublish() {
    if (!working) return;
    publish.mutate(
      { versionId: working.id, termId },
      {
        onSuccess: () => {
          show({ variant: "success", title: t("adminSchool.timetable.toast.published") });
          setView("live");
        },
        onError: (err) =>
          show({
            variant: "error",
            title: t("adminSchool.timetable.toast.publishFailed"),
            description: apiErrorDescription(err),
          }),
      },
    );
  }

  function handleDiscard() {
    if (!working) return;
    discard.mutate(
      { versionId: working.id, termId },
      {
        onSuccess: () => {
          show({ variant: "success", title: t("adminSchool.timetable.toast.discarded") });
          setConfirmDiscard(false);
          setView("live");
        },
        onError: (err) =>
          show({
            variant: "error",
            title: t("adminSchool.timetable.toast.discardFailed"),
            description: apiErrorDescription(err),
          }),
      },
    );
  }

  function handleApprove() {
    if (!working) return;
    approve.mutate(
      { versionId: working.id, termId },
      {
        onSuccess: () => {
          show({ variant: "success", title: t("adminSchool.timetable.toast.published") });
          setView("live");
        },
        onError: (err) =>
          show({
            variant: "error",
            title: t("adminSchool.timetable.toast.publishFailed"),
            description: apiErrorDescription(err),
          }),
      },
    );
  }

  function handleReturnToDraft() {
    if (!working) return;
    returnToDraft.mutate(
      { versionId: working.id, termId },
      {
        onError: (err) =>
          show({
            variant: "error",
            title: t("adminSchool.timetable.toast.returnFailed"),
            description: apiErrorDescription(err),
          }),
      },
    );
  }

  // --- Render -------------------------------------------------------------------------------
  const yearOptions: SelectOption<string>[] = (yearsQuery.data ?? []).map((year) => ({
    value: year.id,
    label: year.name,
  }));
  const termOptions: SelectOption<string>[] = (termsQuery.data ?? []).map((term) => ({
    value: term.id,
    label: term.name,
  }));

  const loadingReference =
    versionsQuery.isPending ||
    classesQuery.isPending ||
    teachersQuery.isPending ||
    roomsQuery.isPending ||
    settingsQuery.isPending;

  const scheduledClassCount = new Set(visibleSlots.map((slot) => slot.class_id)).size;

  function renderStatus() {
    if (!shown) return null;

    if (shown.status === "approved") {
      return (
        <div className="timetable-status" data-tone="live">
          <span className="timetable-status__pill">
            {t("adminSchool.timetable.workspace.live")}
          </span>
          <p className="timetable-status__text">
            {shown.approved_at
              ? t("adminSchool.timetable.workspace.liveSince", {
                  date: formatDate(new Date(shown.approved_at), { dateStyle: "medium" }),
                })
              : t("adminSchool.timetable.workspace.liveNote")}
          </p>
          {working ? (
            <div className="timetable-status__actions">
              <span className="timetable-status__hint">
                {working.status === "pending"
                  ? t("adminSchool.timetable.workspace.pendingWaiting")
                  : t("adminSchool.timetable.workspace.draftWaiting")}
              </span>
              <Button variant="secondary" onClick={() => setView("working")}>
                {working.status === "pending"
                  ? t("adminSchool.timetable.workspace.review")
                  : t("adminSchool.timetable.workspace.continueEditing")}
              </Button>
            </div>
          ) : null}
        </div>
      );
    }

    if (shown.status === "pending") {
      return (
        <div className="timetable-status" data-tone="pending">
          <span className="timetable-status__pill">
            {t("adminSchool.timetable.status.pending")}
          </span>
          <p className="timetable-status__text">
            {t("adminSchool.timetable.workspace.pendingNote")}
          </p>
          <div className="timetable-status__actions">
            {live ? (
              <Button variant="tertiary" onClick={() => setView("live")}>
                {t("adminSchool.timetable.workspace.viewLive")}
              </Button>
            ) : null}
            <Button
              variant="secondary"
              loading={returnToDraft.isPending}
              onClick={handleReturnToDraft}
            >
              {t("adminSchool.timetable.workspace.returnToDraft")}
            </Button>
            <Button loading={approve.isPending} onClick={handleApprove}>
              {t("adminSchool.timetable.workspace.approve")}
            </Button>
          </div>
        </div>
      );
    }

    return (
      <div className="timetable-status" data-tone="draft">
        <span className="timetable-status__pill">{t("adminSchool.timetable.workspace.draft")}</span>
        <p className="timetable-status__text">
          {live
            ? t("adminSchool.timetable.workspace.draftNote")
            : t("adminSchool.timetable.workspace.draftNoteFirst")}
          {shown.rejected_reason
            ? ` ${t("adminSchool.timetable.sentBack", { reason: shown.rejected_reason })}`
            : ""}
        </p>
        <div className="timetable-status__actions">
          {live ? (
            <Button variant="tertiary" onClick={() => setView("live")}>
              {t("adminSchool.timetable.workspace.viewLive")}
            </Button>
          ) : null}
          <Button variant="secondary" onClick={() => setConfirmDiscard(true)}>
            {t("adminSchool.timetable.workspace.discard")}
          </Button>
          <Button loading={publish.isPending} onClick={handlePublish}>
            {t("adminSchool.timetable.workspace.publish")}
          </Button>
        </div>
      </div>
    );
  }

  function renderBody() {
    if (termId === "") return <p>{t("adminSchool.timetable.selectTerm")}</p>;
    if (loadingReference) {
      return (
        <p role="status" aria-live="polite">
          {t("adminSchool.timetable.loading")}
        </p>
      );
    }
    if (versionsQuery.isError) {
      return <p role="alert">{t("adminSchool.timetable.workspace.loadError")}</p>;
    }
    if (!shown) {
      return (
        <div className="timetable-empty">
          <h2>{t("adminSchool.timetable.workspace.emptyTitle")}</h2>
          <p>
            {canManage
              ? t("adminSchool.timetable.workspace.emptyManage")
              : t("adminSchool.timetable.workspace.emptyView")}
          </p>
          {canManage ? (
            <Button loading={startEditing.isPending} onClick={handleEdit}>
              {t("adminSchool.timetable.workspace.create")}
            </Button>
          ) : null}
        </div>
      );
    }
    if (slotsQuery.isPending) {
      return (
        <p role="status" aria-live="polite">
          {t("adminSchool.timetable.loading")}
        </p>
      );
    }
    return (
      <TimetableGrid
        version={shown}
        slots={slots}
        classes={classes}
        teachers={teachers}
        rooms={rooms}
        isReadOnly={!editing}
        days={settings.school_days}
        periodCount={settings.periods_per_day}
        isVisible={isVisible}
      />
    );
  }

  return (
    <div className="timetable-workspace">
      <header className="timetable-workspace__header">
        <div>
          <h1>{title}</h1>
          <p className="timetable-workspace__intro">{intro}</p>
          {aside}
        </div>
        <div className="timetable-workspace__actions">
          <ExportCsvButton
            filename="timetable"
            columns={exportColumns}
            getRows={exportSlots}
            disabled={!shown || slotsQuery.isPending}
          />
          {canManage ? (
            <>
              <Button
                variant="secondary"
                disabled={!settingsQuery.data}
                onClick={() => setWeekOpen(true)}
              >
                {t("adminSchool.timetable.workspace.schoolWeek")}
              </Button>
              {shown && !editing && shown.status === "approved" ? (
                <Button loading={startEditing.isPending} onClick={handleEdit}>
                  {working
                    ? t("adminSchool.timetable.workspace.continueEditing")
                    : t("adminSchool.timetable.workspace.edit")}
                </Button>
              ) : null}
            </>
          ) : null}
        </div>
      </header>

      <div className="timetable-workspace__filters">
        <Select
          label={t("adminSchool.timetable.academicYear")}
          options={yearOptions}
          value={yearId}
          onChange={setYearId}
        />
        <Select
          label={t("adminSchool.timetable.term")}
          options={termOptions}
          value={termId}
          onChange={setTermId}
          disabled={yearId === ""}
        />
        <Select
          label={t("adminSchool.timetable.workspace.classFilter")}
          options={[
            { value: ALL, label: t("adminSchool.timetable.workspace.allClasses") },
            ...classes.map((klass) => ({ value: klass.id, label: klass.code })),
          ]}
          value={classFilter}
          onChange={setClassFilter}
        />
        <Select
          label={t("adminSchool.timetable.workspace.teacherFilter")}
          options={[
            { value: ALL, label: t("adminSchool.timetable.workspace.allTeachers") },
            ...teachers.map((teacher) => ({ value: teacher.id, label: teacher.display_name })),
          ]}
          value={teacherFilter}
          onChange={setTeacherFilter}
        />
      </div>

      {renderStatus()}

      {shown && !slotsQuery.isPending ? (
        <p className="timetable-workspace__summary">
          {t("adminSchool.timetable.workspace.summary", {
            count: visibleSlots.length,
            classes: scheduledClassCount,
          })}
        </p>
      ) : null}

      {renderBody()}

      {settingsQuery.data ? (
        <SchoolWeekModal
          open={weekOpen}
          onClose={() => setWeekOpen(false)}
          settings={settingsQuery.data}
        />
      ) : null}

      <Modal
        open={confirmDiscard}
        onClose={() => setConfirmDiscard(false)}
        title={t("adminSchool.timetable.workspace.discardTitle")}
        description={t("adminSchool.timetable.workspace.discardDescription")}
      >
        <Modal.Footer>
          <Button variant="secondary" onClick={() => setConfirmDiscard(false)}>
            {t("adminSchool.timetable.editModal.cancel")}
          </Button>
          <Button loading={discard.isPending} onClick={handleDiscard}>
            {t("adminSchool.timetable.workspace.discardConfirm")}
          </Button>
        </Modal.Footer>
      </Modal>
    </div>
  );
}
