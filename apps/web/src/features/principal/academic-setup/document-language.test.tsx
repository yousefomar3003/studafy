import { cleanup, render, screen, within } from "@testing-library/react";
// eslint-disable-next-line import-x/no-unresolved -- "bun:test" is a virtual Bun built-in with no resolvable file path
import { afterEach, describe, expect, test } from "bun:test";

import { i18next } from "../../../lib/i18n/i18next";

import { CertificateDocument } from "./CertificateView";
import { bilingualLabel, documentLanguageOf, documentName } from "./document-language";
import { sampleContent } from "./DocumentLanguageCard";

import type { CertificateContent } from "./queries";

/**
 * Arabic + English documents (000264): a document renders in the language it was issued in —
 * English, Arabic (right to left) or both — and one issued without a language follows the reader,
 * as every document issued before did.
 */

const t = i18next.getFixedT("en");

function content(language: "en" | "ar" | "bilingual" | "viewer"): CertificateContent {
  return sampleContent(t, "certificate", language, "مدرسة النور");
}

afterEach(cleanup);

describe("documentName", () => {
  test("picks the spelling for the document's language, falling back to English", () => {
    expect(documentName("en", "ar", "Mathematics", "الرياضيات")).toBe("Mathematics");
    expect(documentName("ar", "en", "Mathematics", "الرياضيات")).toBe("الرياضيات");
    expect(documentName("ar", "en", "Science", undefined)).toBe("Science");
    expect(documentName("bilingual", "en", "Mathematics", "الرياضيات")).toBe(
      "Mathematics / الرياضيات",
    );
    expect(documentName("bilingual", "en", "Science", " ")).toBe("Science");
    // No language: the reader's, as before.
    expect(documentName(null, "ar", "Mathematics", "الرياضيات")).toBe("الرياضيات");
    expect(documentName(null, "en", "Mathematics", "الرياضيات")).toBe("Mathematics");
  });

  test("a bilingual label shows one text when both are the same", () => {
    expect(bilingualLabel("Grade", "الدرجة")).toBe("Grade / الدرجة");
    expect(bilingualLabel("A", "A")).toBe("A");
  });

  test("an unknown language from a newer server follows the reader", () => {
    expect(documentLanguageOf("fr")).toBeNull();
    expect(documentLanguageOf(undefined)).toBeNull();
    expect(documentLanguageOf("bilingual")).toBe("bilingual");
  });
});

describe("CertificateDocument", () => {
  test("an Arabic document reads right to left with Arabic labels and names", () => {
    render(<CertificateDocument content={content("ar")} voided={false} />);
    const article = screen.getByRole("article");
    expect(article.getAttribute("dir")).toBe("rtl");
    expect(article.getAttribute("lang")).toBe("ar");
    expect(within(article).getByText("مدرسة النور")).toBeTruthy();
    expect(within(article).getByText("سارة خالد أحمد")).toBeTruthy();
    expect(within(article).getByRole("rowheader", { name: "الرياضيات" })).toBeTruthy();
    expect(within(article).queryByText("Mathematics")).toBeNull();
  });

  test("a bilingual document shows both names and both labels", () => {
    render(<CertificateDocument content={content("bilingual")} voided={false} />);
    const article = screen.getByRole("article");
    expect(article.getAttribute("dir")).toBeNull();
    expect(within(article).getByText("Sara Ahmad / سارة خالد أحمد")).toBeTruthy();
    expect(
      within(article).getByRole("rowheader", { name: "Mathematics / الرياضيات" }),
    ).toBeTruthy();
    const subjectHeader = within(article).getAllByRole("columnheader")[0]!;
    expect(subjectHeader.textContent).toContain(" / ");
  });

  test("an English document stays English, and a document without a language follows the reader", () => {
    render(<CertificateDocument content={content("en")} voided={false} />);
    expect(screen.getByRole("article").getAttribute("dir")).toBe("ltr");
    expect(screen.getByRole("rowheader", { name: "Mathematics" })).toBeTruthy();
    cleanup();

    // Issued before 000264 (no language, no Arabic names): exactly as before.
    const legacy = content("viewer");
    expect("language" in legacy).toBe(false);
    render(<CertificateDocument content={legacy} voided={false} />);
    const article = screen.getByRole("article");
    expect(article.getAttribute("dir")).toBeNull();
    expect(article.getAttribute("data-document-language")).toBe("viewer");
    expect(screen.getByRole("rowheader", { name: "Mathematics" })).toBeTruthy();
  });
});
