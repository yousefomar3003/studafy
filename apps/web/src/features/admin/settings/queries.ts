import { api } from "../../../lib/api";

import type { components } from "@studafy/api-client";

export type SchoolSettings = components["schemas"]["SchoolSettings"];
export type MyProfile = components["schemas"]["UserWithRoles"];

// ---------------------------------------------------------------------------
// Query keys
// ---------------------------------------------------------------------------

export const SCHOOL_SETTINGS_KEY = ["settings", "school"] as const;

export function myProfileQueryKey(userId: string) {
  return ["settings", "profile", userId] as const;
}

// ---------------------------------------------------------------------------
// School-wide settings (locale, timezone, grading scheme, invitation expiry, attendance alerts)
// ---------------------------------------------------------------------------

export async function fetchSchoolSettings(): Promise<SchoolSettings> {
  const { data } = await api.GET("/api/schools/current/settings");
  if (!data) throw new Error("School settings fetch returned no data.");
  return data;
}

// ---------------------------------------------------------------------------
// The signed-in admin's own profile
// ---------------------------------------------------------------------------

export async function fetchMyProfile(userId: string): Promise<MyProfile> {
  const { data } = await api.GET("/api/users/{userId}", { params: { path: { userId } } });
  if (!data) throw new Error("Profile fetch returned no data.");
  // `readonly UserWithRoles["roles"]` loses its array prototype through the generated response type
  // here — a pre-existing `@studafy/api-client` typing gap (see admin/users/queries.ts and
  // admin/timetable/queries.ts for the same cast). The shape is identical; this just restores it.
  return data as MyProfile;
}
