# Graph Report - studafy  (2026-07-07)

## Corpus Check
- 52 files · ~8,734 words
- Verdict: corpus is large enough that graph structure adds value.

## Summary
- 296 nodes · 316 edges · 32 communities (25 shown, 7 thin omitted)
- Extraction: 100% EXTRACTED · 0% INFERRED · 0% AMBIGUOUS
- Token cost: 0 input · 0 output

## Graph Freshness
- Built from commit: `a13514a1`
- Run `git rev-parse HEAD` and compare to check if the graph is stale.
- Run `graphify update .` after code changes (no API cost).

## Community Hubs (Navigation)
- [[_COMMUNITY_package.json|package.json]]
- [[_COMMUNITY_turbo.json|turbo.json]]
- [[_COMMUNITY_studafy|studafy]]
- [[_COMMUNITY_package.json|package.json]]
- [[_COMMUNITY_ADR-000 Monorepo tooling — Bun workspaces + Turborepo|ADR-000: Monorepo tooling — Bun workspaces + Turborepo]]
- [[_COMMUNITY_package.json|package.json]]
- [[_COMMUNITY_compilerOptions|compilerOptions]]
- [[_COMMUNITY_compilerOptions|compilerOptions]]
- [[_COMMUNITY_package.json|package.json]]
- [[_COMMUNITY_@studafytsconfig|@studafy/tsconfig]]
- [[_COMMUNITY_packages.json|packages.json]]
- [[_COMMUNITY_tsconfig.json|tsconfig.json]]
- [[_COMMUNITY_tsconfig.json|tsconfig.json]]
- [[_COMMUNITY_package.json|package.json]]
- [[_COMMUNITY_dependencies|dependencies]]
- [[_COMMUNITY_@studafyconfig|@studafy/config]]
- [[_COMMUNITY_ADR-001 Shared lintformat config as a root-inherited package|ADR-001: Shared lint/format config as a root-inherited package]]
- [[_COMMUNITY_package.json|package.json]]
- [[_COMMUNITY_ADR-002 Fixed-role authorization model|ADR-002: Fixed-role authorization model]]
- [[_COMMUNITY_tsconfig.json|tsconfig.json]]
- [[_COMMUNITY_tsconfig.build.json|tsconfig.build.json]]
- [[_COMMUNITY_permission-matrix|permission-matrix.md]]
- [[_COMMUNITY_index.ts|index.ts]]
- [[_COMMUNITY_package.json|package.json]]
- [[_COMMUNITY_Schema conventions|Schema conventions]]
- [[_COMMUNITY_tsconfig.json|tsconfig.json]]
- [[_COMMUNITY_tsconfig.build.json|tsconfig.build.json]]

## God Nodes (most connected - your core abstractions)
1. `compilerOptions` - 13 edges
2. `scripts` - 7 edges
3. `scripts` - 6 edges
4. `ROLES` - 6 edges
5. `ADR-000: Monorepo tooling — Bun workspaces + Turborepo` - 6 edges
6. `ADR-001: Shared lint/format config as a root-inherited package` - 6 edges
7. `ADR-002: Fixed-role authorization model` - 6 edges
8. `Schema conventions` - 6 edges
9. `scripts` - 5 edges
10. `compilerOptions` - 5 edges

## Surprising Connections (you probably didn't know these)
- None detected - all connections are within the same source files.

## Import Cycles
- None detected.

## Communities (32 total, 7 thin omitted)

### Community 0 - "package.json"
Cohesion: 0.14
Nodes (13): name, packageManager, private, scripts, build, format, format:check, lint (+5 more)

### Community 1 - "turbo.json"
Cohesion: 0.10
Nodes (20): devDependencies, eslint, prettier, @studafy/config, turbo, typescript, dependsOn, outputs (+12 more)

### Community 2 - "studafy"
Cohesion: 0.15
Nodes (11): ADR-000: Monorepo tooling — Bun workspaces + Turborepo, Alternatives considered, Consequences, Context, Decision, Status, Adding a workspace, Getting started (+3 more)

### Community 3 - "package.json"
Cohesion: 0.17
Nodes (11): devDependencies, @studafy/config, @studafy/tsconfig, typescript, name, private, scripts, build (+3 more)

### Community 4 - "ADR-000: Monorepo tooling — Bun workspaces + Turborepo"
Cohesion: 0.12
Nodes (15): compilerOptions, baseUrl, esModuleInterop, forceConsistentCasingInFileNames, isolatedModules, module, moduleResolution, noEmit (+7 more)

### Community 5 - "package.json"
Cohesion: 0.17
Nodes (11): devDependencies, @studafy/config, @studafy/tsconfig, typescript, name, private, scripts, build (+3 more)

### Community 8 - "compilerOptions"
Cohesion: 0.25
Nodes (7): compilerOptions, incremental, jsx, lib, noEmit, extends, $schema

### Community 9 - "compilerOptions"
Cohesion: 0.29
Nodes (6): compilerOptions, lib, module, moduleResolution, extends, $schema

### Community 10 - "package.json"
Cohesion: 0.29
Nodes (6): files, name, peerDependencies, typescript, private, version

### Community 11 - "@studafy/tsconfig"
Cohesion: 0.33
Nodes (5): Path aliases, Presets, Repo-wide type check, @studafy/tsconfig, Usage

### Community 12 - "packages.json"
Cohesion: 0.40
Nodes (4): compilerOptions, lib, extends, $schema

### Community 15 - "package.json"
Cohesion: 0.10
Nodes (20): dependencies, eslint-config-prettier, eslint-import-resolver-typescript, @eslint/js, eslint-plugin-import-x, eslint-plugin-security, globals, typescript-eslint (+12 more)

### Community 16 - "dependencies"
Cohesion: 0.12
Nodes (20): buildMarkdown(), main(), ERROR_CODES, ErrorCode, DOMAIN_EVENTS, DomainEvent, NOTIFICATION_TYPES, NotificationType (+12 more)

### Community 17 - "@studafy/config"
Cohesion: 0.25
Nodes (7): Consuming this package, ESLint, How it's wired up, Overriding for a specific package (documented exception), Prettier, Rule catalog, @studafy/config

### Community 18 - "ADR-001: Shared lint/format config as a root-inherited package"
Cohesion: 0.29
Nodes (6): ADR-001: Shared lint/format config as a root-inherited package, Alternatives considered, Consequences, Context, Decision, Status

### Community 22 - "package.json"
Cohesion: 0.11
Nodes (19): default, devDependencies, @studafy/config, @studafy/tsconfig, @types/bun, typescript, exports, main (+11 more)

### Community 23 - "ADR-002: Fixed-role authorization model"
Cohesion: 0.29
Nodes (6): ADR-002: Fixed-role authorization model, Alternatives considered, Consequences, Context, Decision, Status

### Community 27 - "index.ts"
Cohesion: 0.16
Nodes (18): RFC-4122, RFC-9457, dateSchema, DateString, dateTimeSchema, DateTimeString, Money, moneySchema (+10 more)

### Community 28 - "package.json"
Cohesion: 0.10
Nodes (21): default, dependencies, @studafy/constants, zod, devDependencies, @studafy/config, @studafy/tsconfig, @types/bun (+13 more)

### Community 29 - "Schema conventions"
Cohesion: 0.29
Nodes (6): Errors (`error.ts`), Naming, Pagination (`pagination.ts`), Primitives (`base.ts`), Schema conventions, Testing

## Knowledge Gaps
- **179 isolated node(s):** `name`, `version`, `private`, `build`, `check-types` (+174 more)
  These have ≤1 connection - possible missing edges or undocumented components.
- **7 thin communities (<3 nodes) omitted from report** — run `graphify query` to explore isolated nodes.

## Suggested Questions
_Questions this graph is uniquely positioned to answer:_

- **Why does `devDependencies` connect `turbo.json` to `package.json`?**
  _High betweenness centrality (0.008) - this node is a cross-community bridge._
- **What connects `name`, `version`, `private` to the rest of the system?**
  _179 weakly-connected nodes found - possible documentation gaps or missing edges._
- **Should `package.json` be split into smaller, more focused modules?**
  _Cohesion score 0.14285714285714285 - nodes in this community are weakly interconnected._
- **Should `turbo.json` be split into smaller, more focused modules?**
  _Cohesion score 0.09523809523809523 - nodes in this community are weakly interconnected._
- **Should `ADR-000: Monorepo tooling — Bun workspaces + Turborepo` be split into smaller, more focused modules?**
  _Cohesion score 0.125 - nodes in this community are weakly interconnected._
- **Should `package.json` be split into smaller, more focused modules?**
  _Cohesion score 0.09523809523809523 - nodes in this community are weakly interconnected._
- **Should `dependencies` be split into smaller, more focused modules?**
  _Cohesion score 0.12043010752688173 - nodes in this community are weakly interconnected._