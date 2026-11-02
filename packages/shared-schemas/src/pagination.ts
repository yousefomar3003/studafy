import { z } from "zod";

/**
 * Cursor-based pagination primitives. The cursor is an opaque forward token (its encoding is
 * the caller's concern); `limit` is capped at 100. See docs/schema-conventions.md.
 */

/** Opaque forward pagination cursor. */
export const cursorSchema = z.string().min(1);
export type Cursor = z.infer<typeof cursorSchema>;

export const PAGINATION_DEFAULT_LIMIT = 20;
export const PAGINATION_MAX_LIMIT = 100;

/**
 * Pagination query parameters. `limit` is coerced (query-string / form values arrive as
 * strings), defaults to {@link PAGINATION_DEFAULT_LIMIT}, and is hard-capped at
 * {@link PAGINATION_MAX_LIMIT}. `cursor` is optional (absent = first page).
 */
export const paginationQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(PAGINATION_MAX_LIMIT).default(PAGINATION_DEFAULT_LIMIT),
  cursor: cursorSchema.optional(),
});
export type PaginationQuery = z.infer<typeof paginationQuerySchema>;
