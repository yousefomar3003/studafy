import { MaterialParseError } from "./errors";
import { isOcrCandidate, parseDocument } from "./parsers";

import type { OcrEngine } from "./ocr";
import type { ParsedBlock } from "./types";
import type { TransactionSql } from "postgres";

/**
 * The text of an assignment AI source (000232): what a student picked when they chose "My
 * assignments" as the source for an AI study tool.
 *
 * An assignment source has no file of its own. It is the assignment's title, description and
 * instructions, followed by each file the teacher attached, read in place from the bucket (the
 * attachment was malware-scanned when the teacher uploaded it, and is never copied). Each part
 * starts with a heading block, so every chunk's section title says where it came from ("Worksheet
 * 3.pdf"), and the citations in the AI tools point there.
 *
 * Only attachments the scan cleared (or that predate scanning, 000192) are read, which is also what
 * the API fingerprints, so a file still scanning joins the source once it is clean and the student
 * opens it again. An attachment in a format the pipeline does not read, or one that fails to parse,
 * is skipped rather than failing the whole source: the assignment's own text is still worth having.
 */

export interface AssignmentSourceContent {
  title: string;
  description: string | null;
  instructions: string | null;
  attachments: { storageKey: string; mimeType: string; fileName: string }[];
}

export async function loadAssignmentSourceContent(
  tx: TransactionSql,
  schoolId: string,
  assignmentId: string,
): Promise<AssignmentSourceContent | null> {
  const [assignment] = await tx<
    { title: string; description: string | null; instructions: string | null }[]
  >`
    SELECT title, description, instructions
    FROM app.assignments
    WHERE id = ${assignmentId}::uuid AND school_id = ${schoolId}::uuid
  `;
  if (!assignment) return null;
  const attachments = await tx<
    { storage_key: string; mime_type: string; original_file_name: string }[]
  >`
    SELECT storage_key, mime_type, original_file_name
    FROM app.assignment_attachments
    WHERE assignment_id = ${assignmentId}::uuid AND school_id = ${schoolId}::uuid
      AND scan_status IN ('clean', 'unscanned')
    ORDER BY created_at, id
  `;
  return {
    ...assignment,
    attachments: attachments.map((row) => ({
      storageKey: row.storage_key,
      mimeType: row.mime_type,
      fileName: row.original_file_name,
    })),
  };
}

function heading(text: string): ParsedBlock {
  return { text: text.trim(), kind: "heading", pageNumber: null, slideNumber: null };
}

/** Free text as body blocks, one per paragraph. */
export function textBlocks(text: string | null): ParsedBlock[] {
  if (!text) return [];
  return text
    .split(/\n\s*\n/)
    .map((paragraph) => paragraph.trim())
    .filter((paragraph) => paragraph !== "")
    .map((paragraph) => ({ text: paragraph, kind: "body", pageNumber: null, slideNumber: null }));
}

export interface AssignmentBlocksDeps {
  fetchBytes: (storageKey: string) => Promise<Uint8Array>;
  /** Builds an OCR engine on first need (a scanned PDF or a photo); the caller closes it. */
  ocr: () => OcrEngine;
  /** Told about each attachment that was skipped, for the worker's log. */
  onSkipped?: (fileName: string, reason: string) => void;
}

export async function buildAssignmentBlocks(
  content: AssignmentSourceContent,
  deps: AssignmentBlocksDeps,
): Promise<ParsedBlock[]> {
  const blocks: ParsedBlock[] = [heading(content.title)];
  blocks.push(...textBlocks(content.description), ...textBlocks(content.instructions));

  for (const file of content.attachments) {
    let parsed: ParsedBlock[];
    try {
      const bytes = await deps.fetchBytes(file.storageKey);
      const document = await parseDocument(bytes, file.mimeType, {
        ...(isOcrCandidate(file.mimeType) ? { ocr: deps.ocr() } : {}),
      });
      parsed = document.blocks;
    } catch (error) {
      // A file the pipeline cannot read is the file's verdict, not the source's. Anything else (the
      // bucket, a timeout) may be transient: the job retries.
      if (error instanceof MaterialParseError) {
        deps.onSkipped?.(file.fileName, error.reason);
        continue;
      }
      throw error;
    }
    if (parsed.length === 0) continue;
    blocks.push(heading(file.fileName), ...parsed);
  }

  // Nothing but the title heading: no text to work with.
  return blocks.some((block) => block.kind === "body") ? blocks : [];
}
