import { z } from "@hono/zod-openapi";

/**
 * Where a payer may be sent back after a hosted checkout, billing portal or card setup (QA-057):
 * a page on one of this deployment's browser origins (CORS_ALLOWED_ORIGINS, FRONTEND_URL). Read
 * from the environment when a request is validated, so the deployed tier's own list applies. With
 * neither set (local development and tests that do not configure origins) any http(s) URL passes.
 */
export function isAllowedReturnUrl(
  value: string,
  env: Readonly<Record<string, string | undefined>> = process.env,
): boolean {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return false;
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") return false;
  // Userinfo ("https://app.studafy.com@evil.example") never belongs in a return URL.
  if (url.username !== "" || url.password !== "") return false;

  const allowed = new Set<string>();
  for (const origin of (env.CORS_ALLOWED_ORIGINS ?? "").split(",")) {
    if (origin.trim() !== "") allowed.add(origin.trim().replace(/\/+$/, ""));
  }
  if (env.FRONTEND_URL) {
    try {
      allowed.add(new URL(env.FRONTEND_URL).origin);
    } catch {
      // A malformed FRONTEND_URL is env.ts's to refuse; it adds nothing here.
    }
  }
  if (allowed.size === 0) return true;
  return allowed.has(url.origin);
}

/** A return URL field: a URL on this deployment's own origins. */
export const returnUrlSchema = z
  .string()
  .url()
  .refine((value) => isAllowedReturnUrl(value), {
    message: "Return URLs must point to a Studafy page",
  });
