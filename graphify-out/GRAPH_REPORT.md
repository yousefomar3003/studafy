# Graph Report - studafy  (2026-07-07)

## Corpus Check
- 18 files · ~2,320 words
- Verdict: corpus is large enough that graph structure adds value.

## Summary
- 111 nodes · 97 edges · 15 communities (13 shown, 2 thin omitted)
- Extraction: 100% EXTRACTED · 0% INFERRED · 0% AMBIGUOUS
- Token cost: 0 input · 0 output

## Graph Freshness
- Built from commit: `94e1ae1c`
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

## God Nodes (most connected - your core abstractions)
1. `compilerOptions` - 13 edges
2. `ADR-000: Monorepo tooling — Bun workspaces + Turborepo` - 6 edges
3. `compilerOptions` - 5 edges
4. `studafy` - 5 edges
5. `@studafy/tsconfig` - 5 edges
6. `compilerOptions` - 4 edges
7. `scripts` - 3 edges
8. `scripts` - 3 edges
9. `scripts` - 3 edges
10. `tasks` - 3 edges

## Surprising Connections (you probably didn't know these)
- None detected - all connections are within the same source files.

## Import Cycles
- None detected.

## Communities (15 total, 2 thin omitted)

### Community 0 - "package.json"
Cohesion: 0.17
Nodes (11): devDependencies, turbo, typescript, name, packageManager, private, scripts, build (+3 more)

### Community 1 - "turbo.json"
Cohesion: 0.22
Nodes (8): dependsOn, outputs, dependsOn, outputs, $schema, tasks, build, check-types

### Community 2 - "studafy"
Cohesion: 0.15
Nodes (11): ADR-000: Monorepo tooling — Bun workspaces + Turborepo, Alternatives considered, Consequences, Context, Decision, Status, Adding a workspace, Getting started (+3 more)

### Community 3 - "package.json"
Cohesion: 0.20
Nodes (9): devDependencies, @studafy/tsconfig, typescript, name, private, scripts, build, check-types (+1 more)

### Community 4 - "ADR-000: Monorepo tooling — Bun workspaces + Turborepo"
Cohesion: 0.12
Nodes (15): compilerOptions, baseUrl, esModuleInterop, forceConsistentCasingInFileNames, isolatedModules, module, moduleResolution, noEmit (+7 more)

### Community 5 - "package.json"
Cohesion: 0.20
Nodes (9): devDependencies, @studafy/tsconfig, typescript, name, private, scripts, build, check-types (+1 more)

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

## Knowledge Gaps
- **76 isolated node(s):** `name`, `version`, `private`, `build`, `check-types` (+71 more)
  These have ≤1 connection - possible missing edges or undocumented components.
- **2 thin communities (<3 nodes) omitted from report** — run `graphify query` to explore isolated nodes.

## Suggested Questions
_Questions this graph is uniquely positioned to answer:_

- **Why does `turbo` connect `package.json` to `turbo.json`?**
  _High betweenness centrality (0.017) - this node is a cross-community bridge._
- **What connects `name`, `version`, `private` to the rest of the system?**
  _76 weakly-connected nodes found - possible documentation gaps or missing edges._
- **Should `ADR-000: Monorepo tooling — Bun workspaces + Turborepo` be split into smaller, more focused modules?**
  _Cohesion score 0.125 - nodes in this community are weakly interconnected._