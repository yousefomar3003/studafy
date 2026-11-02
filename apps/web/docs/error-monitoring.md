# Web error monitoring

Sentry error monitoring for the web app. The moving parts:

| Layer                 | File(s)                                                                          | Responsibility                                                                                         |
| --------------------- | -------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------ |
| Config                | `src/lib/monitoring/config.ts`                                                   | Env-derived DSN, environment, and release version                                                      |
| Vendor seam           | `src/lib/monitoring/sentry.ts`                                                   | `initMonitoring`, `captureException`, `setMonitoringUser` — the only file that imports `@sentry/react` |
| PII scrubbing         | `src/lib/monitoring/scrub-pii.ts`                                                | `beforeSend`/`beforeBreadcrumb` redaction, verified by `scrub-pii.test.ts`                             |
| User context          | `src/lib/monitoring/use-sync-monitoring-user.ts`                                 | Keeps the Sentry user (id only) aligned with the session                                               |
| Catch points          | `src/components/ErrorBoundary.tsx`, `src/components/RouteError.tsx`              | Where a thrown error actually reaches `captureException`                                               |
| Release + source maps | `vite.config.ts`, `infra/docker/web.Dockerfile`, `.github/workflows/release.yml` | Tags the build with the release version and uploads source maps                                        |

## No vendor lock-in beyond the seam

Nothing outside `lib/monitoring` imports `@sentry/react` directly — the same instrumentation-seam
idiom `lib/analytics` uses for its own vendor. Every export in `sentry.ts` degrades to a no-op when
`VITE_SENTRY_DSN` is unset, which is the case in local dev and in the `containers.yml` PR/dev
validation build. The app behaves identically with or without a Sentry project configured.

## Env vars

| Var                             | Set where                                                                       | Notes                                                                                            |
| ------------------------------- | ------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------ |
| `VITE_SENTRY_DSN`               | `--build-arg` in `release.yml`, from the `VITE_SENTRY_DSN` environment variable | Public DSN, baked in at build time. Unset disables monitoring.                                   |
| `VITE_SENTRY_ENVIRONMENT`       | Same                                                                            | Falls back to the Vite build mode.                                                               |
| `VITE_RELEASE_VERSION`          | Same, value is the release's immutable image tag (the git commit SHA)           | Falls back to `"unknown"`. Mirrors the API's own `RELEASE_VERSION` (`apps/api/src/env.ts`).      |
| `SENTRY_ORG` / `SENTRY_PROJECT` | `--build-arg` in `release.yml`                                                  | Which Sentry project source maps upload to.                                                      |
| `SENTRY_AUTH_TOKEN`             | BuildKit `--secret` in `release.yml`, scoped to the `vite build` step only      | Never becomes an image layer or `ARG`; absent entirely in the `containers.yml` validation build. |

## Release tagging and source maps

A release build (`release.yml`) bakes the deploy's own immutable image tag into
`VITE_RELEASE_VERSION`, and `vite.config.ts`'s `sentryVitePlugin` uploads that same value to Sentry
as the release name — so a captured error's release always correlates to the deploy that shipped it.
Source maps are only ever generated for that authenticated upload (`build.sourcemap: "hidden"`, only
when `SENTRY_AUTH_TOKEN` is present); the unauthenticated `containers.yml` validation build produces
no `.map` files at all, and the ones the release build does generate are deleted from `dist` after
upload (`sourcemaps.filesToDeleteAfterUpload`) — nothing raw ever ships to a browser.

## PII scrubbers

`scrubEvent`/`scrubBreadcrumb` (`scrub-pii.ts`) run as `Sentry.init`'s `beforeSend`/
`beforeBreadcrumb`, alongside `sendDefaultPii: false`:

- The user context is reduced to `{ id }` — never an email, username, or IP, which the access
  token's claims never carry anyway (see `access-token-claims.ts`).
- Any object key (in `extra`, `contexts`, `request`, or a breadcrumb's `data`) whose name matches a
  PII-shaped root — email, phone, address, name, token, cookie, ... — is replaced with
  `"[Redacted]"`, at any nesting depth. The root list deliberately mirrors
  `packages/config/rules/no-analytics-pii.js`'s own list, kept as a separate runtime copy rather
  than a shared import across the lint/runtime boundary.

`scrub-pii.test.ts` is the acceptance criterion's "PII scrubbers verified": it asserts the user
reduction, the redaction at depth, breadcrumb scrubbing, and that non-PII fields (ids, enums,
counts) pass through untouched.

## Verifying a thrown test error reaches Sentry

Once `VITE_SENTRY_DSN` is configured for an environment, load any page there with `?sentry-test`
appended to the URL (e.g. `https://app.example.com/portal?sentry-test`). `main.tsx` calls
`triggerTestErrorFromQueryParam`, which throws an uncaught `Error` on the next tick — outside React
entirely, so it is Sentry's own global `window.onerror` handler (installed by `Sentry.init`, not
this app's `ErrorBoundary`/`RouteError`) that reports it. The event should appear in Sentry within
moments, tagged with the deploy's release, and its stack should resolve to real source locations
(not minified output) once the release's source maps have finished uploading.

`ErrorBoundary` and `RouteError` are the two in-app catch points that report a real thrown error the
same way (`captureException`); triggering either one (e.g. a render-time bug, or navigating to a
route that throws) is an equally valid way to exercise the same pipeline end to end.
