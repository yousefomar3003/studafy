// Maps (not plain objects) so a status/ingest-status string coming back from the API can never
// resolve a prototype member -- same convention as `billing/labels.ts` and
// `notifications/labels.ts`. Kept local to this feature rather than imported from
// `admin/students/schema.ts` / `admin/users/schema.ts`: those modules own their own list-page
// forms, not a shared vocabulary, and duplicating four short label pairs is cheaper than coupling
// the search feature to their internals.

const STUDENT_STATUS_LABEL = new Map<string, string>([
  ["applicant", "Applicant"],
  ["enrolled", "Enrolled"],
  ["suspended", "Suspended"],
  ["graduated", "Graduated"],
  ["withdrawn", "Withdrawn"],
  ["archived", "Archived"],
]);

export function studentStatusLabel(status: string): string {
  return STUDENT_STATUS_LABEL.get(status) ?? status;
}

const USER_STATUS_LABEL = new Map<string, string>([
  ["invited", "Invited"],
  ["active", "Active"],
  ["suspended", "Suspended"],
  ["archived", "Archived"],
]);

export function userStatusLabel(status: string): string {
  return USER_STATUS_LABEL.get(status) ?? status;
}

const MATERIAL_INGEST_STATUS_LABEL = new Map<string, string>([
  ["uploaded", "Uploaded"],
  ["queued", "Queued"],
  ["processing", "Processing"],
  ["scanning", "Scanning"],
  ["ready", "Ready"],
  ["failed", "Failed"],
  ["quarantined", "Quarantined"],
]);

export function materialIngestStatusLabel(status: string): string {
  return MATERIAL_INGEST_STATUS_LABEL.get(status) ?? status;
}
