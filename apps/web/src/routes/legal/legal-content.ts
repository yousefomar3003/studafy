/**
 * Pure helpers over the legal documents' Markdown, kept apart from `legal-documents.ts` (which
 * imports the raw files through Vite) so they stay testable under `bun test`.
 */

export type LegalDocumentId = "privacy" | "terms" | "school-agreement";

export interface LegalDocumentSources {
  readonly en: string;
  readonly ar: string;
}

export interface ParsedLegalDocument {
  /** The `# Title` line, without the `#`. */
  readonly title: string;
  /** The `Last updated: YYYY-MM-DD` date (the document's version), or null if the line is missing. */
  readonly version: string | null;
  /** Everything after the title, rendered as the page body. */
  readonly body: string;
}

/** The public path of each document. */
export const LEGAL_DOCUMENT_PATHS: Readonly<Record<LegalDocumentId, string>> = {
  privacy: "/privacy",
  terms: "/terms",
  "school-agreement": "/school-agreement",
};

const TITLE = /^#\s+(.+)$/m;
// The version line is written the same way in both languages, so one pattern finds it in either.
const VERSION = /(\d{4}-\d{2}-\d{2})/;

export function parseLegalDocument(source: string): ParsedLegalDocument {
  const titleMatch = TITLE.exec(source);
  const title = titleMatch?.[1]?.trim() ?? "";
  const body = titleMatch
    ? source.slice((titleMatch.index ?? 0) + titleMatch[0].length).trim()
    : source.trim();
  const firstLines = body.split("\n").slice(0, 3).join("\n");
  return { title, version: VERSION.exec(firstLines)?.[1] ?? null, body };
}
