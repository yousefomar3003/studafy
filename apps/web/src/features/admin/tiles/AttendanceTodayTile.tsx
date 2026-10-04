import { useQuery } from "@tanstack/react-query";

import { DashboardTile } from "../../../components/DashboardTile";
import { api } from "../../../lib/api";
import { useFormatters, useTranslation } from "../../../lib/i18n";

/** No realtime event is routed for attendance marks yet, so this polls instead. */
const ATTENDANCE_TODAY_POLL_MS = 60_000;

/** Local calendar date as YYYY-MM-DD — "today" is what the viewer's clock says, not UTC's. */
function todayDateString(): string {
  const now = new Date();
  const month = String(now.getMonth() + 1).padStart(2, "0");
  const day = String(now.getDate()).padStart(2, "0");
  return `${now.getFullYear()}-${month}-${day}`;
}

/**
 * Today's attendance, backed by the attendance reports summary endpoint scoped to a single-day
 * range (`start_date === end_date === today`). That endpoint is shaped as a scoped report, not a
 * dedicated "today" scalar, so only `totals` from the response is used here.
 */
export function AttendanceTodayTile() {
  const { t } = useTranslation();
  const { formatNumber } = useFormatters();
  const today = todayDateString();

  const { data, isPending, isError } = useQuery({
    queryKey: ["attendance-summary", "today"],
    queryFn: async () => {
      const { data } = await api.GET("/api/attendance/reports/summary", {
        params: { query: { start_date: today, end_date: today, group_by: "class" } },
      });
      return data;
    },
    refetchInterval: ATTENDANCE_TODAY_POLL_MS,
  });

  const totals = data?.totals;
  const totalRecords = totals?.total_records ?? 0;

  return (
    <DashboardTile
      title={t("adminSchool.tiles.attendance.title")}
      status={isPending ? "pending" : isError ? "error" : "ready"}
      errorMessage={t("adminSchool.tiles.attendance.error")}
    >
      {totalRecords === 0 || !totals ? (
        <p className="dashboard-tile__caption">{t("adminSchool.tiles.attendance.empty")}</p>
      ) : (
        <>
          <p className="dashboard-tile__value">
            {formatNumber(Math.round(totals.present_percent) / 100, { style: "percent" })}
          </p>
          <p className="dashboard-tile__caption">
            {t("adminSchool.tiles.attendance.summary", {
              count: totalRecords,
              present: formatNumber(totals.present_count),
              total: formatNumber(totalRecords),
            })}
          </p>
        </>
      )}
    </DashboardTile>
  );
}
