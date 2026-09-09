/**
 * Content model for the hand-authored guides (ST-269).
 *
 * A guide is data, not markup: prose and code samples are plain strings, and every sample that
 * claims to call a real endpoint or produce a real error code names that endpoint/code as structured
 * metadata (`ApiExampleRef` / `errorCodes`) rather than only inside the sample text. validate.ts
 * checks that metadata against the live `apps/api/openapi.json` and `@studafy/constants`' ERROR_CODES
 * — the "examples validated against spec in CI" acceptance criterion is this file's `api`/`errorCodes`
 * fields being true today, not a claim in a comment.
 */

export type HttpMethod = "GET" | "POST" | "PUT" | "PATCH" | "DELETE";

export interface ApiExampleRef {
  method: HttpMethod;
  /** OpenAPI path template, e.g. "/api/auth/refresh" — exactly as it appears in openapi.json. */
  path: string;
  /**
   * Whether this path is expected to be part of the published contract. false for the handful of
   * dev/E2E-only routes (the mock IdP's browser-redirect endpoints) that are deliberately not
   * `.openapi()`-registered — see mock-route.ts. Sets validate.ts to skip the existence check for
   * those instead of failing the build on a route that was never meant to appear in openapi.json.
   */
  documented: boolean;
}

export interface CodeBlock {
  /** For a `<pre>`'s language hint only; no syntax highlighter is wired up (see render.ts). */
  language: "bash" | "http" | "json" | "text";
  code: string;
  /** Present when this block issues a real request — validated against openapi.json. */
  api?: ApiExampleRef;
  /** Error codes this block's prose or JSON references — validated against ERROR_CODES. */
  errorCodes?: string[];
}

export interface GuideSection {
  heading: string;
  /**
   * Paragraphs. Each supports the same minimal inline syntax render.ts's `renderInline` implements:
   * `` `code` ``, `**bold**`, and `[text](url)` — deliberately not full Markdown (see render.ts).
   */
  body: string[];
  blocks?: CodeBlock[];
}

export interface Guide {
  slug: string;
  navTitle: string;
  title: string;
  summary: string;
  sections: GuideSection[];
}
