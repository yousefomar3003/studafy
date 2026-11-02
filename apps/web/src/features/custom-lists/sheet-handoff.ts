/**
 * Hands a sheet an import did not recognise to "Create a custom list from a sheet", in memory only:
 * the CSV text never goes to storage, and a reload simply starts the list import empty.
 */

export interface PendingSheet {
  fileName: string;
  csv: string;
}

let pending: PendingSheet | null = null;

export function setPendingSheet(sheet: PendingSheet): void {
  pending = sheet;
}

/** The sheet waiting for the import page, removed as it is read. */
export function takePendingSheet(): PendingSheet | null {
  const sheet = pending;
  pending = null;
  return sheet;
}
