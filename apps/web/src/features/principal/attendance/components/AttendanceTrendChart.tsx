import { Card } from "@studafy/ui";
import { useMemo } from "react";

import { useFormatters, useTranslation } from "../../../../lib/i18n";
import { ONE_DECIMAL_PERCENT_OPTIONS } from "../../format";

import type { AttendanceTrends } from "../types";

const WIDTH = 640;
const HEIGHT = 180;
const PADDING = 24;

export function AttendanceTrendChart({
  data,
  loading,
}: {
  data?: AttendanceTrends;
  loading?: boolean;
}) {
  const { t } = useTranslation();
  const { formatNumber } = useFormatters();
  const points = data?.points ?? [];
  const formatPercent = (value: number) => formatNumber(value / 100, ONE_DECIMAL_PERCENT_OPTIONS);
  const polyline = useMemo(() => {
    if (points.length === 0) return "";
    return points
      .map((point, index) => {
        const x = PADDING + (index * (WIDTH - PADDING * 2)) / Math.max(points.length - 1, 1);
        const y = HEIGHT - PADDING - (point.present_percent / 100) * (HEIGHT - PADDING * 2);
        return `${x},${y}`;
      })
      .join(" ");
  }, [points]);

  return (
    <Card>
      <div className="attendance-card-heading">
        <div>
          <h2>{t("principal.attendance.trend.title")}</h2>
          <p>{t("principal.attendance.trend.description")}</p>
        </div>
      </div>
      {loading ? <p role="status">{t("principal.attendance.trend.loading")}</p> : null}
      {!loading && points.length === 0 ? <p>{t("principal.attendance.trend.empty")}</p> : null}
      {points.length > 0 ? (
        <>
          <svg
            className="attendance-trend"
            viewBox={`0 0 ${WIDTH} ${HEIGHT}`}
            role="img"
            aria-labelledby="attendance-trend-title attendance-trend-description"
          >
            <title id="attendance-trend-title">{t("principal.attendance.trend.chartTitle")}</title>
            <desc id="attendance-trend-description">
              {points
                .map((point) =>
                  t("principal.attendance.trend.pointDescription", {
                    date: point.bucket_start,
                    percent: formatNumber(point.present_percent, {
                      minimumFractionDigits: 1,
                      maximumFractionDigits: 1,
                    }),
                  }),
                )
                .join(", ")}
            </desc>
            <line x1={PADDING} x2={WIDTH - PADDING} y1={HEIGHT - PADDING} y2={HEIGHT - PADDING} />
            <line x1={PADDING} x2={PADDING} y1={PADDING} y2={HEIGHT - PADDING} />
            <polyline points={polyline} fill="none" stroke="currentColor" strokeWidth="3" />
            {points.map((point, index) => {
              // eslint-disable-next-line security/detect-object-injection -- index comes from mapping the same points used to create the coordinate string
              const coordinate = polyline.split(" ")[index]!.split(",");
              return (
                <circle key={point.bucket_start} cx={coordinate[0]} cy={coordinate[1]} r="4" />
              );
            })}
          </svg>
          <ul
            className="attendance-trend-legend"
            aria-label={t("principal.attendance.trend.legendLabel")}
          >
            {points.map((point) => (
              <li key={point.bucket_start}>
                {t("principal.attendance.trend.legendItem", {
                  date: point.bucket_start,
                  percent: formatPercent(point.present_percent),
                })}
              </li>
            ))}
          </ul>
        </>
      ) : null}
    </Card>
  );
}
