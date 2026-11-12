import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import { api } from "../../../lib/api";

import { GRADING_KEY } from "./queries";

import type { components } from "@studafy/api-client";

type Schemas = components["schemas"];

export type ReportCardSettings = Schemas["ReportCardSettings"];
export type ReportCardConductRating = Schemas["ReportCardConductRating"];
export type UpdateReportCardSettingsBody = Schemas["UpdateReportCardSettingsBody"];
export type SectionReportNotes = Schemas["SectionReportNotes"];
export type SectionReportNotesStudent = SectionReportNotes["students"][number];
export type SaveStudentNoteItem = Schemas["SaveStudentNoteItem"];
export type SaveSubjectCommentItem = Schemas["SaveSubjectCommentItem"];
export type ReportCardNotes = Schemas["ReportCardNotes"];

/**
 * Report card notes (000208): the school's choice of report card sections and conduct ratings, and
 * a section's draft comments for a period. Kept under {@link GRADING_KEY} so finalizing (which
 * freezes the notes) and saving notes refresh each other.
 */
export const reportCardKeys = {
  settings: () => [...GRADING_KEY, "report-card-settings"] as const,
  notes: (sectionId: string, termId: string | null) =>
    [...GRADING_KEY, "report-notes", sectionId, termId ?? "annual"] as const,
};

function required<T>(data: unknown, what: string): T {
  if (data === undefined || data === null) throw new Error(`${what} returned no data.`);
  return data as T;
}

export function useReportCardSettings() {
  return useQuery({
    queryKey: reportCardKeys.settings(),
    queryFn: async () => {
      const { data } = await api.GET("/api/grading/report-card-settings");
      return required<ReportCardSettings>(data, "Report card settings");
    },
  });
}

export function useSectionReportNotes(sectionId: string | undefined, termId: string | null) {
  return useQuery({
    queryKey: reportCardKeys.notes(sectionId ?? "", termId),
    enabled: sectionId !== undefined,
    queryFn: async () => {
      const { data } = await api.GET("/api/grading/sections/{sectionId}/report-notes", {
        params: {
          path: { sectionId: sectionId! },
          query: termId === null ? {} : { term_id: termId },
        },
      });
      return required<SectionReportNotes>(data, "Report card notes");
    },
  });
}

function useReportCardMutation<Input, Output>(mutationFn: (input: Input) => Promise<Output>) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn,
    onSuccess: () => queryClient.invalidateQueries({ queryKey: GRADING_KEY }),
  });
}

export function useUpdateReportCardSettings() {
  return useReportCardMutation(async (body: UpdateReportCardSettingsBody) => {
    const { data } = await api.PUT("/api/grading/report-card-settings", { body });
    return required<ReportCardSettings>(data, "Report card settings");
  });
}

export function useSaveStudentNotes() {
  return useReportCardMutation(
    async ({
      sectionId,
      termId,
      students,
    }: {
      sectionId: string;
      termId: string | null;
      students: SaveStudentNoteItem[];
    }) => {
      const { data } = await api.PUT("/api/grading/sections/{sectionId}/report-notes", {
        params: { path: { sectionId } },
        body: { term_id: termId, students },
      });
      return required<SectionReportNotes>(data, "Report card notes");
    },
  );
}

export function useSaveSubjectComments() {
  return useReportCardMutation(
    async ({
      sectionId,
      subjectId,
      termId,
      comments,
    }: {
      sectionId: string;
      subjectId: string;
      termId: string | null;
      comments: SaveSubjectCommentItem[];
    }) => {
      const { data } = await api.PUT(
        "/api/grading/sections/{sectionId}/subjects/{subjectId}/report-comments",
        { params: { path: { sectionId, subjectId } }, body: { term_id: termId, comments } },
      );
      return required<SectionReportNotes>(data, "Report card notes");
    },
  );
}

/** The rating's label in the reader's language: Arabic when there is one and the UI is Arabic. */
export function conductLabel(
  rating: { label: string; label_ar: string | null },
  language: string,
): string {
  return language.startsWith("ar") && rating.label_ar ? rating.label_ar : rating.label;
}

/** A rating code from a label: lower-case letters, digits and underscores, unique in `taken`. */
export function conductCode(label: string, taken: ReadonlySet<string>): string {
  const base =
    label
      .toLowerCase()
      .normalize("NFKD")
      .replace(/[^a-z0-9]+/g, "_")
      .replace(/^_+|_+$/g, "")
      .slice(0, 30) || "rating";
  let code = base;
  for (let n = 2; taken.has(code); n += 1) code = `${base}_${n}`;
  return code;
}
