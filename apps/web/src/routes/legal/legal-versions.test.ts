/**
 * Keeps the legal documents and the versions the API records in step. A school's acceptance is
 * stored as `LEGAL_DOCUMENT_VERSIONS` (packages/constants/src/legal.ts); that is only proof of what
 * the school agreed to if it matches the `Last updated` date of the text the site shows. The Arabic
 * translation must carry the same date as the English, so the two never describe different versions.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";

import { LEGAL_DOCUMENT_VERSIONS } from "@studafy/constants";
// eslint-disable-next-line import-x/no-unresolved -- "bun:test" is a virtual Bun built-in with no resolvable file path
import { describe, expect, test } from "bun:test";

import { parseLegalDocument } from "./legal-content";

import type { LegalDocumentId } from "./legal-content";

const DOCS = join(import.meta.dir, "../../../../../docs/legal");
const DOCUMENTS: LegalDocumentId[] = ["privacy", "terms", "school-agreement"];

function read(language: "en" | "ar", document: LegalDocumentId) {
  // eslint-disable-next-line security/detect-non-literal-fs-filename -- fixed paths under /docs/legal
  return parseLegalDocument(readFileSync(join(DOCS, language, `${document}.md`), "utf8"));
}

describe("legal documents", () => {
  test.each(DOCUMENTS)(
    "%s has a title and a version in both languages, the same date in each",
    (id) => {
      const en = read("en", id);
      const ar = read("ar", id);
      expect(en.title).not.toBe("");
      expect(ar.title).not.toBe("");
      expect(en.version).not.toBeNull();
      expect(ar.version).toBe(en.version);
    },
  );

  test("the recorded acceptance versions are the documents' dates", () => {
    expect(read("en", "terms").version).toBe(LEGAL_DOCUMENT_VERSIONS.terms);
    expect(read("en", "school-agreement").version).toBe(LEGAL_DOCUMENT_VERSIONS.schoolAgreement);
  });
});
