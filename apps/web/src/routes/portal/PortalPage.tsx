import { ApiError } from "@studafy/api-client";
import { useQuery } from "@tanstack/react-query";
import { useSearchParams } from "react-router-dom";

import { api } from "../../lib/api";
import { useTranslation } from "../../lib/i18n";

/**
 * Portal home page (`/portal`).
 *
 * Consumes the generated API client end-to-end (ST-061): the `/healthz` response is typed straight
 * from the OpenAPI contract, so `data.status` is known to be the literal `"ok"` with no casts. A
 * failure throws a typed {@link ApiError}, from which the UI surfaces the correlation `request_id`.
 *
 * `?notice=forbidden` is rendered here rather than via a new toast/dialog mechanism: it's the same
 * query-param-carries-the-reason convention `RequireAuth` already uses for `?reason=expired` on
 * `/auth/login` (see `RequirePermission`, which sends a denied session back here with that param).
 */
export default function PortalPage() {
  const { t } = useTranslation();
  const [searchParams] = useSearchParams();
  const { data, isPending, error } = useQuery({
    queryKey: ["healthz"],
    queryFn: async () => {
      const { data } = await api.GET("/healthz");
      return data;
    },
  });

  const forbidden = searchParams.get("notice") === "forbidden";

  return (
    <>
      <h1>{t("onboarding.portal.title")}</h1>
      {forbidden && <p role="alert">{t("onboarding.portal.forbidden")}</p>}
      <p>{t("onboarding.portal.intro")}</p>
      <p>
        {t("onboarding.portal.apiStatus", {
          status: isPending
            ? t("onboarding.portal.statusChecking")
            : error instanceof ApiError
              ? t("onboarding.portal.statusUnavailableRef", {
                  requestId: error.request_id ?? t("onboarding.portal.unknownRef"),
                })
              : data?.status === "ok"
                ? t("onboarding.portal.statusOk")
                : t("onboarding.portal.statusUnavailable"),
        })}
      </p>
    </>
  );
}
