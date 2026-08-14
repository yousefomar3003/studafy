import type { components } from "@studafy/api-client";

type ImportRowError = components["schemas"]["ImportRowError"];

/**
 * There is no server-side "download the error report" endpoint (the dry-run response only carries
 * `errors` as JSON — see apps/api/src/modules/imports/schemas.ts's `ImportRecord`), so the
 * downloadable report is built client-side from that same array.
 */

/** A field value needs quoting only when it could otherwise be misread as a delimiter or newline. */
function csvField(value: string): string {
  if (/[",\n]/.test(value)) {
    return `"${value.replace(/"/g, '""')}"`;
  }
  return value;
}

export function buildImportErrorReportCsv(errors: readonly ImportRowError[]): string {
  const header = ["line", "field", "message"].join(",");
  const rows = errors.map((error) =>
    [String(error.line), csvField(error.field), csvField(error.message)].join(","),
  );
  return [header, ...rows].join("\r\n");
}

/** Triggers a browser download of `content` as a file named `filename`. */
export function downloadTextFile(filename: string, content: string, mimeType: string): void {
  const blob = new Blob([content], { type: mimeType });
  const url = URL.createObjectURL(blob);
  try {
    const link = document.createElement("a");
    link.href = url;
    link.download = filename;
    link.click();
  } finally {
    URL.revokeObjectURL(url);
  }
}
