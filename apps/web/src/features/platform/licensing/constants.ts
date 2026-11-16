import { isLicensableAudience } from "@studafy/constants";

import type { LicenseAudience, LicenseStatus } from "./queries";

/** Audiences in the order every console screen lists them. */
export const AUDIENCES: readonly LicenseAudience[] = ["student", "teacher", "parent"];

/** What a license holds per audience, as every console license shape reports it. */
export interface HeldSeats {
  includeFamilyPlus: boolean;
  audiences: readonly { audience: LicenseAudience; purchased: number }[];
}

/**
 * The audiences a console screen offers: those a license sells today (`LICENSABLE_AUDIENCES`, only
 * students until teacher and parent features are built), plus any `held` license already has seats
 * in, so a license from before the rule still shows what it has.
 */
export function shownAudiences(held?: HeldSeats | null): LicenseAudience[] {
  return AUDIENCES.filter((audience) => {
    if (isLicensableAudience(audience)) return true;
    const seats = held?.audiences.find((row) => row.audience === audience)?.purchased ?? 0;
    return seats > 0 && (audience !== "parent" || held?.includeFamilyPlus === true);
  });
}

/** Whether Family+ is offered: only once a parent feature is built, or to a license that has it. */
export function offersFamilyPlus(held?: HeldSeats | null): boolean {
  return isLicensableAudience("parent") || held?.includeFamilyPlus === true;
}

export const LICENSE_STATUSES: readonly LicenseStatus[] = [
  "draft",
  "awaiting_payment",
  "active",
  "suspended",
  "expired",
  "cancelled",
];
