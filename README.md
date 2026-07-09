# studafy

Monorepo for the Studafy platform, managed with Bun workspaces and Turborepo.

## Repo layout

```
.
├── apps/            deployable applications (each a Bun workspace)
│   └── web/
├── packages/         shared libraries consumed by apps (each a Bun workspace)
│   └── ui/
├── infra/            infrastructure as code (not a Bun workspace)
│   └── terraform/
├── docs/
│   └── adr/          architecture decision records
├── bunfig.toml        Bun install/runtime config
├── package.json        root workspace manifest (workspaces: apps/*, packages/*)
└── turbo.json          Turborepo task pipeline config
```

## Requirements

- Bun >= 1.3.0 (see `packageManager` in `package.json`)

## Getting started

```
bun install
bun run build
```

`bun run build` invokes `turbo run build`, which runs the `build` task in every
workspace and caches outputs (`dist/**`) locally under `.turbo`.

## Adding a workspace

Add a new directory under `apps/` or `packages/` with its own `package.json`
(name scoped as `@studafy/<name>`, matching glob `apps/*` / `packages/*` in the
root `package.json`). No further registration is required — Bun and Turbo pick
up new workspaces automatically.

See [ADR-000](docs/adr/0000-monorepo-tooling-choice.md) for why this repo uses
Bun workspaces and Turborepo.

## Infrastructure

Cloud infrastructure is managed with Terraform under [`infra/terraform`](infra/terraform),
which has its own [README](infra/terraform/README.md) covering remote state, environment
overlays and module conventions. See
[ADR-004](docs/adr/0004-infrastructure-as-code.md) for the reasoning behind that layout.
