// eslint-disable-next-line import-x/no-unresolved -- "bun:test" is a virtual Bun built-in with no resolvable file path
import { describe, expect, test } from "bun:test";

import { runFinanceReconciliation } from "./finance-reconciliation";

const RESULT = {
  schools_processed: 3,
  total_drift_detected: 1,
  total_auto_healed: 1,
  total_unresolved: 0,
  job_run_at: "2026-10-12T05:30:00.000Z",
};

function stubFetch(response: Response) {
  const calls: { url: string; init: RequestInit }[] = [];
  const fetch = (async (url: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(url), init: init ?? {} });
    return response;
  }) as unknown as typeof globalThis.fetch;
  return { fetch, calls };
}

describe("runFinanceReconciliation", () => {
  test("posts to the API's reconciliation route with the service key and returns its result", async () => {
    const { fetch, calls } = stubFetch(Response.json(RESULT));

    const result = await runFinanceReconciliation({
      apiBaseUrl: "https://api.studafy.com/",
      apiKey: "svc-key",
      fetch,
    });

    expect(result).toEqual(RESULT);
    expect(calls[0]!.url).toBe("https://api.studafy.com/api/finance/reconciliation/run");
    expect(calls[0]!.init.method).toBe("POST");
    expect((calls[0]!.init.headers as Record<string, string>)["X-Api-Key"]).toBe("svc-key");
  });

  test("throws on a refusal so BullMQ retries the day's run", async () => {
    const { fetch } = stubFetch(new Response("forbidden", { status: 403 }));

    await expect(
      runFinanceReconciliation({ apiBaseUrl: "https://api.studafy.com", apiKey: "wrong", fetch }),
    ).rejects.toThrow("403");
  });
});
