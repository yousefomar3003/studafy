/**
 * One CSV cell, safe to open in a spreadsheet (QA-063). Every CSV export writes its cells through
 * this, so the rule is in one place:
 *
 * - Text a spreadsheet would read as a formula -- starting with `=`, `+`, `-`, `@`, a tab or a
 *   carriage return -- is prefixed with `'`, so it shows as text instead of running (OWASP "CSV
 *   injection"). A plain number, negative ones included, can never be a formula and is left alone,
 *   so amounts stay numbers.
 * - Objects are written as JSON; null and undefined as an empty cell.
 * - The result is quoted (RFC 4180) when it contains `"`, `,`, CR or LF.
 */
export function csvCell(value: unknown): string {
  if (value === null || value === undefined) return "";
  if (typeof value === "number" || typeof value === "bigint") return String(value);
  const text = typeof value === "string" ? value : JSON.stringify(value);
  const isPlainNumber = /^-?\d+(\.\d+)?$/.test(text);
  const safe = !isPlainNumber && /^[=+\-@\t\r]/.test(text) ? `'${text}` : text;
  return /[",\r\n]/.test(safe) ? `"${safe.replaceAll('"', '""')}"` : safe;
}
