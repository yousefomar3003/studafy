import mammoth from "mammoth";

import { CorruptDocumentError, EmptyDocumentError } from "../errors";

import type { ParsedBlock, ParsedDocument } from "../types";

/**
 * The paragraph structure mammoth builds from a DOCX. Paragraphs carry the resolved style identity
 * (styleId, e.g. "Heading1", and styleName, e.g. "heading 1"), which is the reliable way to tell a
 * heading from body text — DOCX is the format that has real style semantics, unlike a text-only PDF.
 */
interface MammothElement {
  type: string;
  value?: string;
  styleId?: string | null;
  styleName?: string | null;
  children?: MammothElement[];
}

interface Paragraph {
  text: string;
  heading: boolean;
}

const HEADING_STYLE_ID = /^(Heading[1-9]|Title)$/;
const HEADING_STYLE_NAME = /^(heading\s+[1-9]|title)$/i;

export async function parseDocx(bytes: Uint8Array): Promise<ParsedDocument> {
  let paragraphs: Paragraph[] = [];
  try {
    await mammoth.convertToHtml(
      { buffer: Buffer.from(bytes) },
      {
        transformDocument: (document) => {
          paragraphs = collectParagraphs(document as MammothElement);
          return document;
        },
      },
    );
  } catch {
    throw new CorruptDocumentError("file is not a valid DOCX");
  }

  const blocks: ParsedBlock[] = [];
  for (const paragraph of paragraphs) {
    if (paragraph.text === "") continue;
    blocks.push({
      text: paragraph.text,
      kind: paragraph.heading ? "heading" : "body",
      pageNumber: null,
      slideNumber: null,
    });
  }

  if (blocks.length === 0) {
    throw new EmptyDocumentError("no extractable text");
  }
  return { format: "docx", pages: null, blocks };
}

function collectParagraphs(document: MammothElement): Paragraph[] {
  const paragraphs: Paragraph[] = [];
  const walk = (element: MammothElement): void => {
    if (element.type === "paragraph") {
      paragraphs.push({
        text: elementText(element).trim(),
        heading: isHeadingStyle(element),
      });
    }
    for (const child of element.children ?? []) walk(child);
  };
  walk(document);
  return paragraphs;
}

/** Reassemble a paragraph's runs: text, tabs and line breaks, in order. */
function elementText(element: MammothElement): string {
  if (element.type === "text") return element.value ?? "";
  if (element.type === "tab") return "\t";
  if (element.type === "break") return "\n";
  return (element.children ?? []).map((child) => elementText(child)).join("");
}

function isHeadingStyle(element: MammothElement): boolean {
  return (
    (element.styleId !== undefined &&
      element.styleId !== null &&
      HEADING_STYLE_ID.test(element.styleId)) ||
    (element.styleName !== undefined &&
      element.styleName !== null &&
      HEADING_STYLE_NAME.test(element.styleName))
  );
}
