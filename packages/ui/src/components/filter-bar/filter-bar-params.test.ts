// eslint-disable-next-line import-x/no-unresolved -- "bun:test" is a virtual Bun built-in with no resolvable file path
import { describe, expect, test } from "bun:test";

import { parseFilterBarState, serializeFilterBarState } from "./filter-bar-params";

describe("serializeFilterBarState", () => {
  test("omits params for an empty state", () => {
    expect(serializeFilterBarState({}).toString()).toBe("");
  });

  test("serializes a search term", () => {
    expect(serializeFilterBarState({ search: "algebra" }).get("q")).toBe("algebra");
  });

  test("serializes a partial date range", () => {
    const params = serializeFilterBarState({ dateRange: { from: "2026-01-01" } });

    expect(params.get("from")).toBe("2026-01-01");
    expect(params.has("to")).toBe(false);
  });

  test("joins chip ids with a comma", () => {
    expect(serializeFilterBarState({ chipIds: ["active", "overdue"] }).get("filters")).toBe(
      "active,overdue",
    );
  });

  test("omits an empty chip list", () => {
    expect(serializeFilterBarState({ chipIds: [] }).has("filters")).toBe(false);
  });
});

describe("parseFilterBarState", () => {
  test("defaults to an empty state", () => {
    expect(parseFilterBarState(new URLSearchParams())).toEqual({
      search: "",
      dateRange: { from: undefined, to: undefined },
      chipIds: [],
    });
  });

  test("reads every field back", () => {
    const params = new URLSearchParams(
      "q=algebra&from=2026-01-01&to=2026-01-31&filters=active,overdue",
    );

    expect(parseFilterBarState(params)).toEqual({
      search: "algebra",
      dateRange: { from: "2026-01-01", to: "2026-01-31" },
      chipIds: ["active", "overdue"],
    });
  });

  test("ignores a stray empty filters param", () => {
    expect(parseFilterBarState(new URLSearchParams("filters=")).chipIds).toEqual([]);
  });
});

describe("round trip", () => {
  test("parse(serialize(state)) reproduces a fully populated state", () => {
    const state = {
      search: "algebra",
      dateRange: { from: "2026-01-01", to: "2026-01-31" },
      chipIds: ["active", "overdue"],
    };

    expect(parseFilterBarState(serializeFilterBarState(state))).toEqual(state);
  });

  test("parse(serialize(state)) reproduces the empty state", () => {
    const state = { search: "", dateRange: {}, chipIds: [] };

    expect(parseFilterBarState(serializeFilterBarState(state))).toEqual({
      search: "",
      dateRange: { from: undefined, to: undefined },
      chipIds: [],
    });
  });
});
