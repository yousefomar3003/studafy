import { useCallback, useMemo } from "react";
import { useSearchParams } from "react-router-dom";

import type { AttendanceFilters, AttendanceStatus, DashboardView, TrendInterval } from "../types";

const STATUSES = new Set<AttendanceStatus>(["present", "absent", "late", "excused"]);
const INTERVALS = new Set<TrendInterval>(["day", "week", "month", "term"]);

function dateString(date: Date): string {
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${date.getFullYear()}-${month}-${day}`;
}

function defaults(): Pick<AttendanceFilters, "startDate" | "endDate"> {
  const end = new Date();
  const start = new Date();
  start.setDate(end.getDate() - 29);
  return { startDate: dateString(start), endDate: dateString(end) };
}

export function parseAttendanceFilters(params: URLSearchParams): AttendanceFilters {
  const fallback = defaults();
  const status = params.get("status") as AttendanceStatus | null;
  const interval = params.get("interval") as TrendInterval | null;
  const view = params.get("view") as DashboardView | null;
  return {
    view: view === "class" ? "class" : "school",
    startDate: params.get("start") ?? fallback.startDate,
    endDate: params.get("end") ?? fallback.endDate,
    termId: params.get("term_id") ?? undefined,
    classId: params.get("class_id") ?? undefined,
    grade: params.get("grade") ?? undefined,
    sectionId: params.get("section_id") ?? undefined,
    status: status && STATUSES.has(status) ? status : undefined,
    interval: interval && INTERVALS.has(interval) ? interval : "day",
    breachesOnly: params.get("breaches") === "1",
  };
}

export function serializeAttendanceFilters(filters: AttendanceFilters): URLSearchParams {
  const params = new URLSearchParams();
  params.set("view", filters.view);
  params.set("start", filters.startDate);
  params.set("end", filters.endDate);
  params.set("interval", filters.interval);
  if (filters.termId) params.set("term_id", filters.termId);
  if (filters.classId) params.set("class_id", filters.classId);
  if (filters.grade) params.set("grade", filters.grade);
  if (filters.sectionId) params.set("section_id", filters.sectionId);
  if (filters.status) params.set("status", filters.status);
  if (filters.breachesOnly) params.set("breaches", "1");
  return params;
}

export function useAttendanceFilters() {
  const [searchParams, setSearchParams] = useSearchParams();
  const filters = useMemo(() => parseAttendanceFilters(searchParams), [searchParams]);
  const updateFilters = useCallback(
    (patch: Partial<AttendanceFilters>) => {
      setSearchParams(serializeAttendanceFilters({ ...filters, ...patch }), { replace: true });
    },
    [filters, setSearchParams],
  );
  const clearFilters = useCallback(() => {
    const range = defaults();
    setSearchParams(
      serializeAttendanceFilters({
        view: "school",
        ...range,
        interval: "day",
        breachesOnly: false,
      }),
      { replace: true },
    );
  }, [setSearchParams]);
  return { filters, updateFilters, clearFilters };
}
