/**
 * Env-derived Sentry configuration, single-sourced like `lib/config.ts`. `SENTRY_DSN` is absent in
 * local dev and in the `containers.yml` validation build (see `infra/docker/web.Dockerfile`) — every
 * consumer in this directory treats that as "monitoring disabled" rather than throwing, so the app
 * runs identically with or without a project wired up.
 *
 * Read as functions rather than the module-level constants `lib/config.ts` uses for its own values:
 * Vite still inlines every `import.meta.env.VITE_*` reference at build time regardless of where it
 * appears, but a function lets `sentry.test.ts` set `process.env` per test and get a fresh read —
 * a plain top-level `const` would freeze at whatever value was present the first time this module
 * was imported in the shared `bun test` process.
 */
export function getSentryDsn(): string | undefined {
  return import.meta.env.VITE_SENTRY_DSN;
}

/** Deploy environment Sentry groups events by. Falls back to Vite's own build mode. */
export function getSentryEnvironment(): string | undefined {
  return import.meta.env.VITE_SENTRY_ENVIRONMENT ?? import.meta.env.MODE;
}

/**
 * Correlates every captured event to the deploy that produced it. Baked in at Docker build time
 * from the same immutable image tag `release.yml` pushes to ECR (`VITE_RELEASE_VERSION` build arg
 * in `infra/docker/web.Dockerfile`) and uploaded to Sentry as the release name by the
 * `sentryVitePlugin` in `vite.config.ts`. Falls back to "unknown" outside that pipeline — mirroring
 * the API's own `RELEASE_VERSION` default (`apps/api/src/env.ts`).
 */
export function getReleaseVersion(): string {
  return import.meta.env.VITE_RELEASE_VERSION ?? "unknown";
}
