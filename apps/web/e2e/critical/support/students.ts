import { bearer } from "./auth";
import { personaEmailFor } from "./personas";
import { API_BASE_URL } from "./ports";

import type { APIRequestContext } from "@playwright/test";

/**
 * Resolves a seeded student's `app.students.id` from their mock-login email, via the admin-facing
 * student directory (which has no email field of its own — see personaEmailFor's own comment for
 * why this reconstructs it from first/last name instead of reading it directly).
 */
export async function resolveStudentId(
  request: APIRequestContext,
  adminToken: string,
  email: string,
): Promise<string> {
  const res = await request.get(`${API_BASE_URL}/api/students`, {
    headers: bearer(adminToken),
    params: { limit: "100" },
  });
  if (!res.ok()) {
    throw new Error(`GET /api/students failed: ${res.status()} ${await res.text()}`);
  }
  const body = (await res.json()) as {
    students: { id: string; first_name: string; last_name: string }[];
  };
  const match = body.students.find((s) => personaEmailFor(s.first_name, s.last_name) === email);
  if (!match) throw new Error(`no seeded student resolves to ${email}`);
  return match.id;
}
