import { Card } from "@studafy/ui";
import { useMemo } from "react";

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
  const points = data?.points ?? [];
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
          <h2>Attendance trend</h2>
          <p>Present rate over the selected period</p>
        </div>
      </div>
      {loading ? <p role="status">Loading attendance trend…</p> : null}
      {!loading && points.length === 0 ? <p>No trend data is available.</p> : null}
      {points.length > 0 ? (
        <>
          <svg
            className="attendance-trend"
            viewBox={`0 0 ${WIDTH} ${HEIGHT}`}
            role="img"
            aria-labelledby="attendance-trend-title attendance-trend-description"
          >
            <title id="attendance-trend-title">Attendance present-rate trend</title>
            <desc id="attendance-trend-description">
              {points
                .map(
                  (point) => `${point.bucket_start}: ${point.present_percent.toFixed(1)} percent`,
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
          <ul className="attendance-trend-legend" aria-label="Trend values">
            {points.map((point) => (
              <li key={point.bucket_start}>
                {point.bucket_start}: {point.present_percent.toFixed(1)}%
              </li>
            ))}
          </ul>
        </>
      ) : null}
    </Card>
  );
}
