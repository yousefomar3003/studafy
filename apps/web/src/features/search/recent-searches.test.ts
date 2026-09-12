// eslint-disable-next-line import-x/no-unresolved -- "bun:test" is a virtual Bun built-in with no resolvable file path
import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import { addRecentSearch, clearRecentSearches, loadRecentSearches } from "./recent-searches";

beforeEach(() => {
  window.localStorage.clear();
});

afterEach(() => {
  window.localStorage.clear();
});

describe("recent-searches", () => {
  test("starts empty", () => {
    expect(loadRecentSearches()).toEqual([]);
  });

  test("adds a term to the front of the list", () => {
    addRecentSearch("ahmad");
    addRecentSearch("invoice 204");

    expect(loadRecentSearches()).toEqual(["invoice 204", "ahmad"]);
  });

  test("re-adding an existing term (case-insensitively) moves it to the front instead of duplicating", () => {
    addRecentSearch("ahmad");
    addRecentSearch("layla");
    addRecentSearch("AHMAD");

    expect(loadRecentSearches()).toEqual(["AHMAD", "layla"]);
  });

  test("ignores blank input", () => {
    addRecentSearch("   ");

    expect(loadRecentSearches()).toEqual([]);
  });

  test("caps the list at 5, dropping the oldest", () => {
    for (const term of ["one", "two", "three", "four", "five", "six"]) {
      addRecentSearch(term);
    }

    expect(loadRecentSearches()).toEqual(["six", "five", "four", "three", "two"]);
  });

  test("clearRecentSearches empties the list", () => {
    addRecentSearch("ahmad");

    clearRecentSearches();

    expect(loadRecentSearches()).toEqual([]);
  });

  test("ignores malformed storage instead of throwing", () => {
    window.localStorage.setItem("studafy.global-search.recent.v1", "not json");

    expect(loadRecentSearches()).toEqual([]);
  });
});
