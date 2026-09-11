import { fileURLToPath } from "node:url";

import { sentryVitePlugin } from "@sentry/vite-plugin";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

// The help center's articles live in `/docs/help` at the repository root — outside Vite's project
// root (`apps/web`). `@docs` aliases the root `docs/` directory so `src/features/help/articles.ts`
// can import them with `?raw`, and `server.fs.allow` explicitly permits serving those files in dev
// (Vite's default `fs` root is the project root, which would otherwise 403 them). The monorepo root
// is the closest thing to a canonical workspace root here.
const repoRoot = fileURLToPath(new URL("../..", import.meta.url));

// Source maps are only ever generated for an authenticated upload — `SENTRY_AUTH_TOKEN` is set by
// `infra/docker/web.Dockerfile`'s release build (via a BuildKit secret) and absent everywhere else
// (local dev, the `containers.yml` PR/dev validation build), so unauthenticated builds never ship
// a `.map` file. "hidden" generates the maps without a `//# sourceMappingURL` comment in the
// shipped JS — the plugin below uploads them straight to Sentry and deletes them from `dist`.
const sentryReleaseUploadEnabled = Boolean(process.env.SENTRY_AUTH_TOKEN);

export default defineConfig({
  plugins: [
    react(),
    ...(sentryReleaseUploadEnabled
      ? [
          sentryVitePlugin({
            authToken: process.env.SENTRY_AUTH_TOKEN,
            org: process.env.SENTRY_ORG,
            project: process.env.SENTRY_PROJECT,
            release: { name: process.env.VITE_RELEASE_VERSION },
            sourcemaps: { filesToDeleteAfterUpload: ["dist/**/*.map"] },
          }),
        ]
      : []),
  ],
  resolve: {
    alias: {
      "@docs": fileURLToPath(new URL("../../docs/", import.meta.url)),
    },
  },
  server: {
    fs: {
      allow: [repoRoot],
    },
  },
  build: {
    sourcemap: sentryReleaseUploadEnabled ? "hidden" : false,
  },
});
