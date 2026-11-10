import { problemDetailsSchema } from "@studafy/shared-schemas";
import { z } from "zod";

/**
 * Client-side view of the problem envelope: the shared RFC 9457 shape reused from
 * {@link @studafy/shared-schemas} plus the API's `request_id` extension. Not redefined here — the
 * base shape is single-sourced. `request_id` is lenient (a non-empty string, parsed optional) so a
 * body that omits it still parses and we fall back to the response header, and a body that carries a
 * non-uuid id is not discarded wholesale.
 *
 * Its own module so that errors.ts can load it (and zod with it) only when a request actually
 * fails: the web app builds its API client before the first paint, and zod is the largest library
 * that client would otherwise put in front of it.
 */
export const clientProblemSchema = problemDetailsSchema.extend({
  request_id: z.string().min(1).optional(),
});

/** A fully parsed problem+json body. */
export type ClientProblem = z.infer<typeof clientProblemSchema>;
