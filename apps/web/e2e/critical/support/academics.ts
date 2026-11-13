import { bearer } from "./auth";
import { SCIENCE_CLASS_CODE } from "./personas";
import { API_BASE_URL } from "./ports";

import type { APIRequestContext } from "@playwright/test";

export interface ScienceClass {
  id: string;
  termId: string;
}

/**
 * Resolves the seeded Science class by its stable code (`db/seeds/data/academics.ts` gives it a
 * fresh uuid every seed run, so nothing can hardcode it). Used by both the attendance and grades
 * journeys, which both operate on this class.
 */
export async function resolveScienceClass(
  request: APIRequestContext,
  accessToken: string,
): Promise<ScienceClass> {
  const res = await request.get(`${API_BASE_URL}/api/academics/classes`, {
    headers: bearer(accessToken),
    params: { limit: "100" },
  });
  if (!res.ok()) {
    throw new Error(`GET /api/academics/classes failed: ${res.status()} ${await res.text()}`);
  }
  const body = (await res.json()) as { classes: { id: string; code: string; term_id: string }[] };
  const match = body.classes.find((c) => c.code === SCIENCE_CLASS_CODE);
  if (!match) {
    throw new Error(`no seeded class with code ${SCIENCE_CLASS_CODE} found`);
  }
  return { id: match.id, termId: match.term_id };
}
