# Graph Report - studafy  (2026-07-07)

## Corpus Check
- 25 files · ~4,036 words
- Verdict: corpus is large enough that graph structure adds value.

## Summary
- 165 nodes · 146 edges · 21 communities (19 shown, 2 thin omitted)
- Extraction: 100% EXTRACTED · 0% INFERRED · 0% AMBIGUOUS
- Token cost: 0 input · 0 output

## Graph Freshness
- Built from commit: `bb81ba72`
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

## God Nodes (most connected - your core abstractions)
1. `compilerOptions` - 13 edges
2. `scripts` - 6 edges
3. `ADR-000: Monorepo tooling — Bun workspaces + Turborepo` - 6 edges
4. `ADR-001: Shared lint/format config as a root-inherited package` - 6 edges
5. `compilerOptions` - 5 edges
6. `studafy` - 5 edges
7. `@studafy/config` - 5 edges
8. `@studafy/tsconfig` - 5 edges
9. `scripts` - 4 edges
10. `compilerOptions` - 4 edges

## Surprising Connections (you probably didn't know these)
- None detected - all connections are within the same source files.

## Import Cycles
- None detected.

## Communities (21 total, 2 thin omitted)

### Community 0 - "package.json"
Cohesion: 0.11
Nodes (17): devDependencies, eslint, prettier, @studafy/config, typescript, name, packageManager, private (+9 more)

### Community 1 - "turbo.json"
Cohesion: 0.15
Nodes (12): turbo, dependsOn, outputs, dependsOn, outputs, dependsOn, outputs, $schema (+4 more)

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
Cohesion: 0.15
Nodes (12): exports, ./eslint, ./prettier, files, name, peerDependencies, eslint, prettier (+4 more)

### Community 16 - "dependencies"
Cohesion: 0.25
Nodes (8): dependencies, eslint-config-prettier, eslint-import-resolver-typescript, @eslint/js, eslint-plugin-import-x, eslint-plugin-security, globals, typescript-eslint

### Community 17 - "@studafy/config"
Cohesion: 0.25
Nodes (7): Consuming this package, ESLint, How it's wired up, Overriding for a specific package (documented exception), Prettier, Rule catalog, @studafy/config

### Community 18 - "ADR-001: Shared lint/format config as a root-inherited package"
Cohesion: 0.29
Nodes (6): ADR-001: Shared lint/format config as a root-inherited package, Alternatives considered, Consequences, Context, Decision, Status

## Knowledge Gaps
- **116 isolated node(s):** `name`, `version`, `private`, `build`, `check-types` (+111 more)
  These have ≤1 connection - possible missing edges or undocumented components.
- **2 thin communities (<3 nodes) omitted from report** — run `graphify query` to explore isolated nodes.

## Suggested Questions
_Questions this graph is uniquely positioned to answer:_

- **Why does `devDependencies` connect `package.json` to `turbo.json`?**
  _High betweenness centrality (0.021) - this node is a cross-community bridge._
- **Why does `turbo` connect `turbo.json` to `package.json`?**
  _High betweenness centrality (0.016) - this node is a cross-community bridge._
- **What connects `name`, `version`, `private` to the rest of the system?**
  _116 weakly-connected nodes found - possible documentation gaps or missing edges._
- **Should `package.json` be split into smaller, more focused modules?**
  _Cohesion score 0.1111111111111111 - nodes in this community are weakly interconnected._
- **Should `ADR-000: Monorepo tooling — Bun workspaces + Turborepo` be split into smaller, more focused modules?**
  _Cohesion score 0.125 - nodes in this community are weakly interconnected._