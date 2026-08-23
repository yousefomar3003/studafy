import { sentryVitePlugin } from "@sentry/vite-plugin";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

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
  build: {
    sourcemap: sentryReleaseUploadEnabled ? "hidden" : false,
  },
});
