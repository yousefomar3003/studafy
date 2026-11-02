/**
 * RFC 4180 CSV parsing, hand-rolled and dependency-free.
 *
 * Handles quoted fields, escaped quotes (""), delimiters and line breaks inside quotes, CRLF/LF/CR
 * line endings and a leading UTF-8 byte-order mark (which Excel writes, and which would otherwise
 * become part of the first header). The delimiter is detected from the first non-empty line, because
 * spreadsheet exports in Arabic and most European locales use ';' rather than ','.
 */

export interface CsvRecord {
  /** 1-based physical line the record starts on, so errors point at the admin's own file. */
  line: number;
  cells: string[];
}

const CANDIDATE_DELIMITERS = [",", ";", "\t"] as const;

export type CsvDelimiter = (typeof CANDIDATE_DELIMITERS)[number];

/** Parse a CSV document. Lines whose every cell is blank (including `,,,`) are skipped. */
export function parseCsv(raw: string): CsvRecord[] {
  const text = raw.startsWith("﻿") ? raw.slice(1) : raw;
  const delimiter = detectDelimiter(text);
  const records: CsvRecord[] = [];

  let cells: string[] = [];
  let cell = "";
  let inQuotes = false;
  let line = 1;
  let recordLine = 1;

  const endRecord = (): void => {
    cells.push(cell);
    if (cells.some((value) => value.trim() !== "")) {
      records.push({ line: recordLine, cells });
    }
    cells = [];
    cell = "";
  };

  for (let i = 0; i < text.length; i++) {
    const ch = text[i]!;

    if (inQuotes) {
      if (ch === '"') {
        if (text[i + 1] === '"') {
          cell += '"';
          i++;
        } else {
          inQuotes = false;
        }
      } else {
        if (ch === "\n" || (ch === "\r" && text[i + 1] !== "\n")) line++;
        cell += ch;
      }
      continue;
    }

    if (ch === '"') {
      inQuotes = true;
    } else if (ch === delimiter) {
      cells.push(cell);
      cell = "";
    } else if (ch === "\n" || ch === "\r") {
      if (ch === "\r" && text[i + 1] === "\n") i++;
      endRecord();
      line++;
      recordLine = line;
    } else {
      cell += ch;
    }
  }

  if (cell !== "" || cells.length > 0) endRecord();

  return records;
}

/** The candidate delimiter occurring most often, outside quotes, on the first non-empty line. */
export function detectDelimiter(text: string): CsvDelimiter {
  const counts = new Map<CsvDelimiter, number>(CANDIDATE_DELIMITERS.map((d) => [d, 0]));
  let inQuotes = false;
  let sawContent = false;

  for (const ch of text) {
    if (ch === '"') {
      inQuotes = !inQuotes;
    } else if (!inQuotes && (ch === "\n" || ch === "\r")) {
      if (sawContent) break;
    } else if (!inQuotes && counts.has(ch as CsvDelimiter)) {
      counts.set(ch as CsvDelimiter, counts.get(ch as CsvDelimiter)! + 1);
      sawContent = true;
    } else if (ch.trim() !== "") {
      sawContent = true;
    }
  }

  let best: CsvDelimiter = ",";
  for (const delimiter of CANDIDATE_DELIMITERS) {
    if (counts.get(delimiter)! > counts.get(best)!) best = delimiter;
  }
  return best;
}
