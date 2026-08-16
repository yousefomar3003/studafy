import { ApiError } from "@studafy/api-client";
import { Button, Select, useToast } from "@studafy/ui";
import { useQuery } from "@tanstack/react-query";
import { useEffect, useState } from "react";

import { STATUS_LABELS } from "./constants";
import { CreateVersionModal } from "./CreateVersionModal";
import { useDeleteVersion, useSubmitVersion } from "./mutations";
import {
  ACADEMIC_YEARS_KEY,
  ROOMS_KEY,
  TEACHER_CONTACTS_KEY,
  classesForTermQueryKey,
  fetchAcademicYears,
  fetchClassesForTerm,
  fetchRooms,
  fetchSlots,
  fetchTeacherContacts,
  fetchTerms,
  fetchVersions,
  slotsQueryKey,
  termsQueryKey,
  versionsQueryKey,
} from "./queries";
import { TimetableGrid } from "./TimetableGrid";

import "./timetable.css";

import type { AcademicYear, Term } from "./queries";
import type { SelectOption } from "@studafy/ui";

/** Picks the school's active year/term by default, falling back to the first one — mirrors the
 * "planned/active/closed/archived" lifecycle terms and years share (`academicYearStatusSchema`). */
function preferActive<T extends { id: string; status: string }>(items: T[]): string {
  return (items.find((item) => item.status === "active") ?? items[0])?.id ?? "";
}

/**
 * Timetable builder (`/portal/admin/timetable`), gated by `organization:manageSettings` like the rest
 * of `/portal/admin` — same boundary `StudentsListPage` uses, since the backend timetable routes
 * (`apps/api/src/modules/academics/routes/timetable-routes.ts`) carry no permission guard of their
 * own beyond authentication (see ST-101/ST-102). A term can have several timetable versions (drafts
 * in progress, one approved-and-live, rejected drafts sent back for rework); this page is a
 * year → term → version drill-down that hands the selected draft to `TimetableGrid` for editing.
 */
export default function TimetableBuilderPage() {
  const { show } = useToast();

  const [yearId, setYearId] = useState("");
  const [termId, setTermId] = useState("");
  const [versionId, setVersionId] = useState("");
  const [createOpen, setCreateOpen] = useState(false);

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
  const slotsQuery = useQuery({
    queryKey: slotsQueryKey(versionId),
    queryFn: () => fetchSlots(versionId),
    enabled: versionId !== "",
  });

  const submitVersion = useSubmitVersion();
  const deleteVersion = useDeleteVersion();

  // Default to the active year, then its active term, then that term's most recent version —
  // re-derived whenever the parent selection changes and the child has no selection of its own yet.
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

  useEffect(() => {
    setVersionId("");
  }, [termId]);

  useEffect(() => {
    if (versionId === "" && versionsQuery.data && versionsQuery.data.length > 0) {
      setVersionId(versionsQuery.data[0]!.id);
    }
  }, [versionId, versionsQuery.data]);

  const yearOptions: SelectOption<string>[] = (yearsQuery.data ?? []).map((year) => ({
    value: year.id,
    label: year.name,
  }));
  const termOptions: SelectOption<string>[] = (termsQuery.data ?? []).map((term) => ({
    value: term.id,
    label: term.name,
  }));
  const versionOptions: SelectOption<string>[] = (versionsQuery.data ?? []).map((version) => ({
    value: version.id,
    label: `${version.name} — ${STATUS_LABELS[version.status]}`,
  }));

  const version = versionsQuery.data?.find((candidate) => candidate.id === versionId);
  const isReadOnly = version ? version.status !== "draft" : true;
  const selectedYear = yearsQuery.data?.find((candidate) => candidate.id === yearId);

  function handleSubmitForApproval() {
    if (!version) return;
    submitVersion.mutate(
      { versionId: version.id, termId },
      {
        onSuccess: () =>
          show({ variant: "success", title: `Submitted "${version.name}" for review` }),
        onError: (err) =>
          show({
            variant: "error",
            title: "Couldn't submit for approval",
            description: err instanceof ApiError ? (err.detail ?? err.title) : undefined,
          }),
      },
    );
  }

  function handleDeleteDraft() {
    if (!version) return;
    deleteVersion.mutate(
      { versionId: version.id, termId },
      {
        onSuccess: () => {
          show({ variant: "success", title: `Deleted draft "${version.name}"` });
          setVersionId("");
        },
        onError: (err) =>
          show({
            variant: "error",
            title: "Couldn't delete draft",
            description: err instanceof ApiError ? (err.detail ?? err.title) : undefined,
          }),
      },
    );
  }

  return (
    <>
      <div className="timetable-builder__header">
        <div>
          <h1>Timetable builder</h1>
          <p>Build a weekly schedule, resolve scheduling conflicts, and submit it for review.</p>
        </div>
      </div>

      <div className="timetable-builder__selectors">
        <Select label="Academic year" options={yearOptions} value={yearId} onChange={setYearId} />
        <Select
          label="Term"
          options={termOptions}
          value={termId}
          onChange={setTermId}
          disabled={yearId === ""}
        />
        <Select
          label="Draft version"
          options={versionOptions}
          value={versionId}
          onChange={setVersionId}
          disabled={termId === ""}
          placeholder={versionsQuery.data?.length ? "Select a version" : "No versions yet"}
        />
        <Button variant="secondary" disabled={termId === ""} onClick={() => setCreateOpen(true)}>
          New draft
        </Button>
      </div>

      {version ? (
        <div className="timetable-builder__version-bar">
          <span className="timetable-builder__status-pill" data-status={version.status}>
            {STATUS_LABELS[version.status]}
          </span>
          {version.status === "draft" ? (
            <>
              <Button
                variant="secondary"
                loading={deleteVersion.isPending}
                onClick={handleDeleteDraft}
              >
                Delete draft
              </Button>
              <Button loading={submitVersion.isPending} onClick={handleSubmitForApproval}>
                Submit for approval
              </Button>
            </>
          ) : (
            <p className="timetable-builder__readonly-note">
              This version is {STATUS_LABELS[version.status].toLowerCase()} and read-only.
            </p>
          )}
          {version.rejected_reason ? (
            <p className="timetable-builder__rejected-note">Sent back: {version.rejected_reason}</p>
          ) : null}
        </div>
      ) : null}

      {termId === "" ? (
        <p>Select a term to build its timetable.</p>
      ) : versionsQuery.isPending ||
        classesQuery.isPending ||
        teachersQuery.isPending ||
        roomsQuery.isPending ? (
        <p>Loading…</p>
      ) : !version ? (
        <p>Create a draft version to start building this term's schedule.</p>
      ) : slotsQuery.isPending ? (
        <p>Loading…</p>
      ) : (
        <TimetableGrid
          version={version}
          slots={slotsQuery.data ?? []}
          classes={classesQuery.data ?? []}
          teachers={teachersQuery.data ?? []}
          rooms={roomsQuery.data ?? []}
          isReadOnly={isReadOnly}
        />
      )}

      {termId !== "" ? (
        <CreateVersionModal
          open={createOpen}
          onClose={() => setCreateOpen(false)}
          termId={termId}
          academicYearId={selectedYear?.id ?? yearId}
          onCreated={(created) => setVersionId(created.id)}
        />
      ) : null}
    </>
  );
}
