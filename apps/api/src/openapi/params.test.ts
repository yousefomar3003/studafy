import { PAGINATION_DEFAULT_LIMIT, PAGINATION_MAX_LIMIT } from "@studafy/shared-schemas";
// eslint-disable-next-line import-x/no-unresolved -- "bun:test" is a virtual Bun built-in with no resolvable file path
import { describe, expect, test } from "bun:test";

import {
  paginationQueryParams,
  schoolIdPathParams,
  sortByQueryParams,
  tenantResourcePathParams,
} from "./params";

/**
 * ST-060. These test the parameter helpers' behaviour, not the emitted document — the helpers are
 * staged for the first authenticated list route and no path uses them yet. The constraints they
 * encode (the pagination cap, the sort allow-list) are the point, and they are testable now.
 */

describe("schoolIdPathParams", () => {
  test("accepts a uuid", () => {
    const result = schoolIdPathParams.safeParse({
      school_id: "8f14e45f-ceea-4a67-9a2d-1c3e7b0d5a91",
    });

    expect(result.success).toBe(true);
  });

  test("rejects a non-uuid", () => {
    const result = schoolIdPathParams.safeParse({ school_id: "springfield-high" });

    expect(result.success).toBe(false);
  });
});

describe("tenantResourcePathParams", () => {
  test("requires both halves of the (id, school_id) composite key", () => {
    const result = tenantResourcePathParams.safeParse({
      id: "3c6e0b8a-9c15-4e3f-8a7d-2b1f4c5d6e70",
    });

    expect(result.success).toBe(false);
  });
});

describe("paginationQueryParams", () => {
  test("defaults limit when absent", () => {
    const result = paginationQueryParams.parse({});

    expect(result.limit).toBe(PAGINATION_DEFAULT_LIMIT);
    expect(result.cursor).toBeUndefined();
  });

  test("coerces a query-string limit, which always arrives as a string", () => {
    expect(paginationQueryParams.parse({ limit: "50" }).limit).toBe(50);
  });

  test("accepts the cap exactly", () => {
    expect(paginationQueryParams.parse({ limit: String(PAGINATION_MAX_LIMIT) }).limit).toBe(
      PAGINATION_MAX_LIMIT,
    );
  });

  // The contract is reject-not-clamp: a client asking for 5000 rows has a bug, and silently handing
  // back 100 would hide it and cause the client to mis-paginate.
  test("rejects a limit over the cap rather than clamping it", () => {
    const result = paginationQueryParams.safeParse({ limit: String(PAGINATION_MAX_LIMIT + 1) });

    expect(result.success).toBe(false);
  });

  test("rejects a zero or negative limit", () => {
    expect(paginationQueryParams.safeParse({ limit: "0" }).success).toBe(false);
    expect(paginationQueryParams.safeParse({ limit: "-1" }).success).toBe(false);
  });

  test("rejects an empty cursor", () => {
    expect(paginationQueryParams.safeParse({ cursor: "" }).success).toBe(false);
  });
});

describe("sortByQueryParams", () => {
  const params = sortByQueryParams(["created_at", "email"]);

  test("defaults to the first column", () => {
    const result = params.parse({});

    expect(result.sort_by).toBe("created_at");
    expect(result.sort_dir).toBe("asc");
  });

  test("accepts an allow-listed column", () => {
    expect(params.parse({ sort_by: "email" }).sort_by).toBe("email");
  });

  // The allow-list is what keeps a sort on an index. A column outside it is either an injection
  // attempt or a full sort of a tenant's rows; neither is a response this API owes anyone.
  test("rejects a column outside the allow-list", () => {
    expect(params.safeParse({ sort_by: "normalized_email" }).success).toBe(false);
    expect(params.safeParse({ sort_by: "1; DROP TABLE app.users" }).success).toBe(false);
  });

  test("rejects an unknown sort direction", () => {
    expect(params.safeParse({ sort_dir: "sideways" }).success).toBe(false);
  });
});
