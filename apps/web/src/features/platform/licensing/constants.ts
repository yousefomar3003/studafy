import type { LicenseAudience, LicenseStatus } from "./queries";

/** Audiences in the order every console screen lists them. */
export const AUDIENCES: readonly LicenseAudience[] = ["student", "teacher", "parent"];

export const LICENSE_STATUSES: readonly LicenseStatus[] = [
  "draft",
  "awaiting_payment",
  "active",
  "suspended",
  "expired",
  "cancelled",
];
