import type { GradingOverview, GradingStatus } from "./queries";
import type { AcademicYear } from "../../admin/timetable/queries";

export const SETUP_BASE = "/portal/principal/academic-setup";

/** What every academic setup screen needs to know about the year being worked on and the viewer. */
export interface SetupContext {
  year: AcademicYear;
  years: readonly AcademicYear[];
  overview: GradingOverview | undefined;
  /** Undefined while the overview loads. */
  status: GradingStatus | undefined;
  /** Rules can change in a draft or active year; finalized and archived years are locked. */
  configEditable: boolean;
  can: {
    manage: boolean;
    finalize: boolean;
    certify: boolean;
    review: boolean;
  };
  /** `?year=…`, carried on every link so the chosen year survives moving between screens. */
  search: string;
}

/** A link inside the area that keeps the selected year. */
export function setupHref(ctx: Pick<SetupContext, "search">, path = ""): string {
  return `${SETUP_BASE}${path ? `/${path}` : ""}${ctx.search}`;
}
