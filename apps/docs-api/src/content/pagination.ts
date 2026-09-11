import type { Guide } from "./types";

/**
 * Pagination guide (ST-269).
 *
 * Sourced from apps/api/src/lib/keyset-cursor.ts (the shared encode/decode implementation and its
 * own rationale comment) and the seven list endpoints that use it today — grep `encodeKeysetCursor`
 * under apps/api/src/modules for the current set if this drifts.
 */
export const paginationGuide: Guide = {
  slug: "pagination",
  navTitle: "Pagination",
  title: "Pagination",
  summary:
    "Every paginated list in this API uses the same keyset (cursor) scheme — one implementation, " +
    "shared, not one convention re-derived per endpoint.",
  sections: [
    {
      heading: "Why keyset, not offset",
      body: [
        "Pages are ordered `(created_at, id) DESC` and a cursor names the boundary row, not a " +
          "numeric position. That makes a page stable under concurrent writes: a row inserted " +
          "between two fetches shifts everything after it by exactly one row instead of the " +
          "classic `LIMIT/OFFSET` failure mode, where the same insert either duplicates a row " +
          "across two pages or drops one silently. The ordering key is stable because `id` never " +
          "changes and `created_at` is set once, at insert.",
      ],
    },
    {
      heading: "Request",
      body: [
        "Two query parameters, the same names and defaults on every list endpoint that paginates:",
      ],
      blocks: [
        {
          language: "text",
          code:
            "limit   integer, 1–100, default 20\n" +
            "cursor  opaque string, omit for the first page",
        },
        {
          language: "http",
          api: { method: "GET", path: "/api/notifications", documented: true },
          code: "GET /api/notifications?limit=20\nAuthorization: Bearer <access_token>",
        },
      ],
    },
    {
      heading: "Response",
      body: [
        "A `next_cursor` alongside the page's rows — `null` when there is no next page, otherwise " +
          "an opaque token to pass back as `cursor` on the following request. Nothing about its " +
          "contents is part of the contract: it is base64url-encoded JSON today " +
          "(`{ created_at, id }` of the last row on the page), but a client must treat it as opaque " +
          "and pass it back unmodified rather than parse or construct one — a route validates it by " +
          "shape and answers 400 `VALIDATION_FAILED` for anything that doesn't decode to that shape, " +
          "including a hand-built one that happens to be wrong.",
      ],
      blocks: [
        {
          language: "json",
          code:
            '{\n  "notifications": [ … ],\n' +
            '  "next_cursor": "eyJjcmVhdGVkX2F0IjoiMjAyNi0wOS0wOVQxMjowMDowMFoiLCJpZCI6Ii4uLiJ9"\n}',
        },
      ],
    },
    {
      heading: "Paging through a list",
      body: ["Follow `next_cursor` until it comes back `null`:"],
      blocks: [
        {
          language: "bash",
          code:
            'cursor=""\n' +
            "while :; do\n" +
            '  page=$(curl -s -H "Authorization: Bearer $TOKEN" \\\n' +
            '    "http://localhost:3000/api/notifications?limit=50${cursor:+&cursor=$cursor}")\n' +
            '  echo "$page" | jq -c ".notifications[]"\n' +
            '  cursor=$(echo "$page" | jq -r ".next_cursor")\n' +
            '  [ "$cursor" = "null" ] && break\n' +
            "done",
        },
      ],
    },
    {
      heading: "Where it's used",
      body: [
        "Every route backed by `apps/api/src/lib/keyset-cursor.ts` shares this exact request and " +
          "response shape: notifications, in-app announcements, invitations, invoices, and the " +
          "student/teacher/user directory listings. A list endpoint that is not paginated at all " +
          "(a bounded set, like session or device lists) says so in its own description rather than " +
          "silently returning everything under a different shape.",
      ],
    },
  ],
};
