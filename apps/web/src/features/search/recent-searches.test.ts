// eslint-disable-next-line import-x/no-unresolved -- "bun:test" is a virtual Bun built-in with no resolvable file path
import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import { addRecentSearch, clearRecentSearches, loadRecentSearches } from "./recent-searches";

beforeEach(() => {
  window.localStorage.clear();
  window.sessionStorage.clear();
});

afterEach(() => {
  window.localStorage.clear();
  window.sessionStorage.clear();
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

// QA-089: admins search for students by name and email; on a shared school computer those terms
// stayed in localStorage for the next person. They now live for the tab only and go on sign-out.
describe("recent-searches storage (QA-089)", () => {
  beforeEach(() => {
    window.sessionStorage.clear();
  });

  test("terms are kept for this tab only, never in localStorage", () => {
    addRecentSearch("layla haddad");
    expect(window.localStorage.length).toBe(0);
    expect(loadRecentSearches()).toEqual(["layla haddad"]);
  });

  test("terms left in localStorage by an older version are removed", () => {
    window.localStorage.setItem("studafy.global-search.recent.v1", JSON.stringify(["old term"]));
    loadRecentSearches();
    expect(window.localStorage.getItem("studafy.global-search.recent.v1")).toBeNull();
  });
});
