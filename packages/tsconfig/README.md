# @studafy/tsconfig

Shared TypeScript configuration for the studafy monorepo. Every workspace extends one of
these presets instead of hand-rolling `compilerOptions`.

## Presets

| File            | Use for                                  |
| --------------- | ----------------------------------------- |
| `base.json`     | Shared defaults (not used directly)        |
| `api.json`      | Node/Bun backend services (`apps/api`)     |
| `web.json`      | Browser/frontend apps (`apps/web`)         |
| `packages.json` | Internal shared libraries (`packages/*`)   |

All presets enforce `strict: true` and target `ES2022` with `moduleResolution: bundler`.

## Usage

1. Add the package as a dependency of your workspace:

   ```json
   {
     "devDependencies": {
       "@studafy/tsconfig": "workspace:*"
     }
   }
   ```

2. Create a `tsconfig.json` in the workspace root that extends the relevant preset:

   ```json
   {
     "extends": "@studafy/tsconfig/web.json",
     "include": ["src"]
   }
   ```

   For a backend service:

   ```json
   { "extends": "@studafy/tsconfig/api.json", "include": ["src"] }
   ```

   For a shared library under `packages/*`:

   ```json
   { "extends": "@studafy/tsconfig/packages.json", "include": ["src"] }
   ```

3. Add a `check-types` script so the workspace participates in the repo-wide type check:

   ```json
   { "scripts": { "check-types": "tsc --noEmit" } }
   ```

## Path aliases

`base.json` sets `baseUrl: "."` with `@/*` mapped to `./src/*`, so every workspace can import
its own source with `import { thing } from "@/thing"` regardless of file nesting depth.

## Repo-wide type check

Run `bun run typecheck` from the repo root. This runs `turbo run check-types`, which executes
`tsc --noEmit` in every workspace that defines the script, using turbo's task graph and cache.
