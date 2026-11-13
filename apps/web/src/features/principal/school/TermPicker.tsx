import { Select } from "@studafy/ui";
import { useState } from "react";

import { useTranslation } from "../../../lib/i18n";

import { pickCurrentTerm, pickCurrentYear, todayIso, useAcademicYears, useTerms } from "./queries";

import type { AcademicYear, Term } from "../../admin/timetable/queries";

export interface TermSelection {
  years: readonly AcademicYear[];
  terms: readonly Term[];
  year: AcademicYear | undefined;
  term: Term | undefined;
  setYearId: (id: string) => void;
  setTermId: (id: string) => void;
  isPending: boolean;
}

/**
 * The academic year and term a principal page is looking at. Defaults to the current year and the
 * term containing today, and falls back to them until the user picks something else — so the page
 * renders the right term on first load without an effect to sync state.
 */
export function useTermSelection(): TermSelection {
  const years = useAcademicYears();
  const [pickedYearId, setPickedYearId] = useState<string>();
  const [pickedTermId, setPickedTermId] = useState<string>();

  const yearList = years.data ?? [];
  const year =
    yearList.find((candidate) => candidate.id === pickedYearId) ?? pickCurrentYear(yearList);
  const terms = useTerms(year?.id);
  const termList = terms.data ?? [];
  const term =
    termList.find((candidate) => candidate.id === pickedTermId) ??
    pickCurrentTerm(termList, todayIso());

  return {
    years: yearList,
    terms: termList,
    year,
    term,
    setYearId: (id) => {
      setPickedYearId(id);
      setPickedTermId(undefined);
    },
    setTermId: setPickedTermId,
    isPending: years.isPending || (year !== undefined && terms.isPending),
  };
}

/** The year and term selects. Renders no wrapper, so a page can put them in its own filter row. */
export function TermPicker({ selection }: { selection: TermSelection }) {
  const { t } = useTranslation();
  return (
    <>
      <Select
        label={t("principal.school.yearLabel")}
        options={selection.years.map((year) => ({ value: year.id, label: year.name }))}
        value={selection.year?.id}
        onChange={selection.setYearId}
        placeholder={t("principal.school.noYears")}
        disabled={selection.years.length === 0}
      />
      <Select
        label={t("principal.school.termLabel")}
        options={selection.terms.map((term) => ({ value: term.id, label: term.name }))}
        value={selection.term?.id}
        onChange={selection.setTermId}
        placeholder={t("principal.school.noTerms")}
        disabled={selection.terms.length === 0}
      />
    </>
  );
}
