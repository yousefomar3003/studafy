/**
 * Where a data subject request's export is stored. The worker writes the archive here, the API
 * signs a download link for it, and the retention sweep deletes everything under the prefix, so
 * all three read the same definition.
 */

/** Every object of one request's export is under this prefix. The trailing slash keeps one
 * request's prefix from matching another request id that starts with the same characters. */
export function dsrExportPrefix(schoolId: string, requestId: string): string {
  return `dsr-exports/${schoolId}/${requestId}/`;
}

/** The single ZIP archive a completed export's `storage_key` points at. */
export function dsrExportArchiveKey(schoolId: string, requestId: string): string {
  return `${dsrExportPrefix(schoolId, requestId)}export.zip`;
}
