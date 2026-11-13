import { i18next } from "../../lib/i18n/i18next";

// Sets (not plain objects) so a status/ingest-status string coming back from the API can never
// resolve a prototype member -- same convention as `billing/labels.ts` and
// `notifications/labels.ts`. Kept local to this feature rather than imported from
// `admin/students/schema.ts` / `admin/users/schema.ts`: those modules own their own list-page
// forms, not a shared vocabulary, and duplicating four short label pairs is cheaper than coupling
// the search feature to their internals. Labels live under `site.search.*` in the catalogs.

type Translate = (key: string) => string;

/** Reads the shared i18next instance at call time — for callers without a hook `t` in scope. */
const defaultTranslate: Translate = (key) => i18next.t(key);

const STUDENT_STATUSES = new Set<string>([
  "applicant",
  "enrolled",
  "suspended",
  "graduated",
  "withdrawn",
  "archived",
]);

export function studentStatusLabel(status: string, t: Translate = defaultTranslate): string {
  return STUDENT_STATUSES.has(status) ? t(`site.search.studentStatus.${status}`) : status;
}

const USER_STATUSES = new Set<string>(["invited", "active", "suspended", "archived"]);

export function userStatusLabel(status: string, t: Translate = defaultTranslate): string {
  return USER_STATUSES.has(status) ? t(`site.search.userStatus.${status}`) : status;
}

const MATERIAL_INGEST_STATUSES = new Set<string>([
  "uploaded",
  "queued",
  "processing",
  "scanning",
  "ready",
  "failed",
  "quarantined",
]);

export function materialIngestStatusLabel(status: string, t: Translate = defaultTranslate): string {
  return MATERIAL_INGEST_STATUSES.has(status) ? t(`site.search.materialStatus.${status}`) : status;
}
