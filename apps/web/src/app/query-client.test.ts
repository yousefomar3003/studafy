import { ApiError } from "@studafy/api-client";
// eslint-disable-next-line import-x/no-unresolved -- "bun:test" is a virtual Bun built-in with no resolvable file path
import { describe, expect, test } from "bun:test";

import { createQueryClient } from "./query-client";

type Retry = (failureCount: number, error: unknown) => boolean;

describe("query retries", () => {
  const retry = createQueryClient().getDefaultOptions().queries!.retry as Retry;

  test("a 4xx is shown at once, never retried", () => {
    expect(retry(0, new ApiError({ status: 404, title: "Not Found" } as never))).toBe(false);
    expect(retry(0, new ApiError({ status: 403, title: "Forbidden" } as never))).toBe(false);
  });

  test("a 5xx or a network failure is retried once", () => {
    expect(retry(0, new ApiError({ status: 503, title: "Unavailable" } as never))).toBe(true);
    expect(retry(0, new TypeError("Failed to fetch"))).toBe(true);
    expect(retry(1, new TypeError("Failed to fetch"))).toBe(false);
  });
});
