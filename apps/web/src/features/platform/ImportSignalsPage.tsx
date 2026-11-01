import { useQuery } from "@tanstack/react-query";

import { api } from "../../lib/api";
import { useFormatters, useTranslation } from "../../lib/i18n";

import { PlatformPageHeader } from "./PlatformNav";

import "./platform.css";

import type { components } from "@studafy/api-client";

type Signal = components["schemas"]["UnmappedHeaderSignal"];

async function fetchSignal(): Promise<Signal> {
  const { data } = await api.GET("/api/platform/import-signals/unmapped-headers");
  if (!data) throw new Error("Import signal returned no data.");
  return data as Signal;
}

/**
 * Columns schools bring that Studafy does not map (`/portal/platform/import-signals`), from
 * `GET /api/platform/import-signals/unmapped-headers`: normalized header text with how many schools
 * and imports had it. Header text and counts only -- never a value or a school -- and only headers
 * at least `min_schools` schools share, so no single school's own wording is shown.
 */
export default function ImportSignalsPage() {
  const { t } = useTranslation();
  const { formatNumber } = useFormatters();
  const signal = useQuery({ queryKey: ["platform", "import-signals"], queryFn: fetchSignal });

  return (
    <>
      <PlatformPageHeader
        title={t("platform.importSignals.title")}
        description={t("platform.importSignals.description", {
          count: signal.data?.min_schools ?? 3,
        })}
      />
      {signal.isPending ? (
        <p role="status">{t("platform.importSignals.loading")}</p>
      ) : signal.isError ? (
        <p role="alert">{t("platform.importSignals.error")}</p>
      ) : signal.data.headers.length === 0 ? (
        <p>{t("platform.importSignals.empty", { count: signal.data.min_schools })}</p>
      ) : (
        <table className="platform-table">
          <caption>{t("platform.importSignals.caption")}</caption>
          <thead>
            <tr>
              <th scope="col">{t("platform.importSignals.columns.header")}</th>
              <th scope="col">{t("platform.importSignals.columns.schools")}</th>
              <th scope="col">{t("platform.importSignals.columns.imports")}</th>
            </tr>
          </thead>
          <tbody>
            {signal.data.headers.map((row) => (
              <tr key={row.normalized_header}>
                <td>{row.header}</td>
                <td>{formatNumber(row.schools)}</td>
                <td>{formatNumber(row.imports)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </>
  );
}
