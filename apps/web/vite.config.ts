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
  // VITE_* keys live in the repo-root `.env` alongside every other service's (see lib/config.ts).
  envDir: "../..",
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
  // 5180, not Vite's default 5173: another local project owns 5173. strictPort fails fast instead
  // of silently moving to a port the API's local CORS allowlist does not know.
  server: {
    port: 5180,
    strictPort: true,
    fs: {
      allow: [repoRoot],
    },
  },
  build: {
    sourcemap: sentryReleaseUploadEnabled ? "hidden" : false,
    rolldownOptions: {
      output: {
        // Every page's first load (the marketing home and sign-in included, which carry the
        // Lighthouse budgets in lighthouserc.json) preloads the modules below. Left to automatic
        // splitting they arrive as a dozen tiny files -- each shared by the entry and some lazy
        // page -- and the extra requests alone pushed LCP over budget. These groups only name
        // modules that are already in that first load, so they merge requests without adding bytes.
        codeSplitting: {
          groups: [
            { name: "react-query", test: /[\\/]@tanstack[\\/](react-query|query-core)[\\/]/ },
            {
              name: "app-core",
              test: /([\\/]packages[\\/]ui[\\/]dist[\\/]internal[\\/](cx|merge-refs|ui-strings)\.js$)|([\\/]packages[\\/]constants[\\/]src[\\/](events|notifications|roles|permissions|features)\.ts$)|([\\/]src[\\/]lib[\\/](api|retry-rejected-token|config)\.ts$)|([\\/]src[\\/]lib[\\/]auth[\\/])/,
            },
          ],
        },
      },
    },
  },
});
