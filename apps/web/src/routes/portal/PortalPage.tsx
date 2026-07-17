import { ApiError } from "@studafy/api-client";
import { useQuery } from "@tanstack/react-query";

import { api } from "../../lib/api";

/**
 * Portal home page (`/portal`).
 *
 * Consumes the generated API client end-to-end (ST-061): the `/healthz` response is typed straight
 * from the OpenAPI contract, so `data.status` is known to be the literal `"ok"` with no casts. A
 * failure throws a typed {@link ApiError}, from which the UI surfaces the correlation `request_id`.
 */
export default function PortalPage() {
  const { data, isPending, error } = useQuery({
    queryKey: ["healthz"],
    queryFn: async () => {
      const { data } = await api.GET("/healthz");
      return data;
    },
  });

  return (
    <>
      <h1>Portal</h1>
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
