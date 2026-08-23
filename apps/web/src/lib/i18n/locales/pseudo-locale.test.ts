// eslint-disable-next-line import-x/no-unresolved -- "bun:test" is a virtual Bun built-in with no resolvable file path
import { describe, expect, test } from "bun:test";

import en from "./en.json";
import { pseudoizeCatalog } from "./pseudo-locale";
import qpsPloc from "./qps-ploc.json";

/**
 * `qps-ploc.json` is generated, not hand-written (`generate-pseudo-locale.ts`). This is the same
 * "kept in sync by a test" guarantee `@studafy/ui`'s `tokens.consistency.test.ts` gives `tokens.css`:
 * if `en.json` changes and nobody re-runs `bun run i18n:pseudo`, this fails instead of the pseudo
 * locale silently drifting out of date.
 */
describe("qps-ploc.json", () => {
  test("matches pseudoizeCatalog(en.json)", () => {
    expect(qpsPloc).toEqual(pseudoizeCatalog(en) as typeof qpsPloc);
  });
});
