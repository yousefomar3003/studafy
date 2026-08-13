import { ApiError } from "@studafy/api-client";
import { useQuery } from "@tanstack/react-query";
import { useSearchParams } from "react-router-dom";

import { api } from "../../lib/api";

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
      <h1>Portal</h1>
      {forbidden && <p role="alert">You don&rsquo;t have access to that page.</p>}
      <p>Your Studafy portal.</p>
      <p>
        API status:{" "}
        {isPending
          ? "checking…"
          : error instanceof ApiError
            ? `unavailable (ref ${error.request_id ?? "unknown"})`
            : (data?.status ?? "unavailable")}
      </p>
    </>
  );
}
