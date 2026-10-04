import { useQuery } from "@tanstack/react-query";
import { Link } from "react-router-dom";

import { DashboardTile } from "../../../components/DashboardTile";
import { useFormatters, useTranslation } from "../../../lib/i18n";
import { WHOLE_PERCENT_OPTIONS } from "../format";
import { fetchClassAttendanceSummary, lastNDaysRange } from "../queries";

const HEAT_MAP_WINDOW_DAYS = 7;
/** Matches the tone thresholds `AttendanceTodayTile`/`StorageUsageTile` already use elsewhere in
 * the portal (percent thresholds mapped to success/warning/danger), applied here to a class's
 * present-rate over the window instead of a single day. */
const ATTENDANCE_WARNING_THRESHOLD = 90;
const ATTENDANCE_DANGER_THRESHOLD = 75;

function toneFor(presentPercent: number): "success" | "warning" | "danger" {
  if (presentPercent < ATTENDANCE_DANGER_THRESHOLD) return "danger";
  if (presentPercent < ATTENDANCE_WARNING_THRESHOLD) return "warning";
  return "success";
}

/**
 * Attendance heat map by class (ST-195): one colored cell per class, toned by its present-rate
 * over the trailing {@link HEAT_MAP_WINDOW_DAYS} days. The per-class summary endpoint
 * (`GET /api/attendance/reports/summary?group_by=class`) has no per-day breakdown, so this is a
 * one-dimensional heat map — class × rate, not class × day — the dimension the endpoint actually
 * supports; see `queryAttendanceSummary` in `packages/attendance-reporting/src/index.ts`. Each
 * cell shows its own number (present %), so tone is never the only signal — see the dataviz
 * skill's accessibility pass.
 */
export function AttendanceHeatMapTile() {
  const { t } = useTranslation();
  const { formatNumber } = useFormatters();
  const range = lastNDaysRange(HEAT_MAP_WINDOW_DAYS);

  const { data, isPending, isError } = useQuery({
    queryKey: ["attendance-summary", "heat-map", range.startDate, range.endDate],
    queryFn: () => fetchClassAttendanceSummary(range),
  });

  const classes = data ?? [];

  return (
    <DashboardTile
      title={t("principal.tiles.attendanceHeatMap.title")}
      status={isPending ? "pending" : isError ? "error" : "ready"}
      errorMessage={t("principal.tiles.attendanceHeatMap.error")}
    >
      <p className="dashboard-tile__caption">
        {t("principal.tiles.attendanceHeatMap.caption", {
          count: HEAT_MAP_WINDOW_DAYS,
          days: formatNumber(HEAT_MAP_WINDOW_DAYS),
        })}
      </p>

      {classes.length === 0 ? (
        <p className="dashboard-tile__caption">{t("principal.tiles.attendanceHeatMap.empty")}</p>
      ) : (
        <ul className="principal-heat-map" role="list">
          {classes.map((klass) => (
            <li key={klass.class_id}>
              <Link
                className="principal-heat-map__cell"
                data-tone={toneFor(klass.present_percent)}
                to={`/portal/principal/attendance?class_id=${klass.class_id}`}
              >
                <span className="principal-heat-map__code">{klass.class_code}</span>
                <span className="principal-heat-map__percent">
                  {formatNumber(klass.present_percent / 100, WHOLE_PERCENT_OPTIONS)}
                </span>
              </Link>
            </li>
          ))}
        </ul>
      )}

      <Link className="dashboard-tile__link" to="/portal/principal/attendance">
        {t("principal.tiles.attendanceHeatMap.link")}
      </Link>
    </DashboardTile>
  );
}
