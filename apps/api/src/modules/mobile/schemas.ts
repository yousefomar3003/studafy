import { z } from "@hono/zod-openapi";

/**
 * A `x.y.z` version string — the grammar of a Flutter `pubspec.yaml` version *name* (the part
 * before the `+build` suffix). Kept as a string rather than parsed into a tuple because this
 * endpoint only echoes the configured value; the ordering comparison lives in the client
 * (`apps/mobile/lib/src/core/update`), which is the side that has a version to compare.
 */
export const versionStringSchema = z
  .string()
  .regex(/^\d+\.\d+\.\d+$/)
  .openapi({ example: "1.4.0" });

const platformReleaseSchema = z
  .object({
    minimum_supported_version: versionStringSchema.openapi({
      description:
        "The oldest build the backend still supports. A client on a strictly lower version must " +
        "block itself behind a forced-update screen. `0.0.0` means no floor is set.",
    }),
    latest_version: versionStringSchema.openapi({
      description:
        "The newest build published to this platform's store. Advisory only — a client below it " +
        "but at or above `minimum_supported_version` may surface a dismissible 'update available' " +
        "nudge. `0.0.0` means none is advertised.",
    }),
  })
  .openapi("MobilePlatformRelease");

/**
 * Both platforms in one document, keyed by store platform. Returned unconditionally and identical
 * for every caller (no auth, no tenant scoping, no query parameters) so it caches as a single
 * object at the edge — the client already knows which key applies to it.
 */
export const mobileReleaseConfigSchema = z
  .object({
    ios: platformReleaseSchema,
    android: platformReleaseSchema,
  })
  .openapi("MobileReleaseConfig");

export type MobileReleaseConfig = z.infer<typeof mobileReleaseConfigSchema>;
