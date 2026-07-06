# Graph Report - studafy  (2026-07-06)

## Corpus Check
- 9 files · ~579 words
- Verdict: corpus is large enough that graph structure adds value.

## Summary
- 43 nodes · 37 edges · 8 communities
- Extraction: 100% EXTRACTED · 0% INFERRED · 0% AMBIGUOUS
- Token cost: 0 input · 0 output

## Graph Freshness
- Built from commit: `a382665b`
- Run `git rev-parse HEAD` and compare to check if the graph is stale.
- Run `graphify update .` after code changes (no API cost).

## Community Hubs (Navigation)
- [[_COMMUNITY_package.json|package.json]]
- [[_COMMUNITY_turbo.json|turbo.json]]
- [[_COMMUNITY_studafy|studafy]]
- [[_COMMUNITY_package.json|package.json]]
- [[_COMMUNITY_ADR-000 Monorepo tooling — Bun workspaces + Turborepo|ADR-000: Monorepo tooling — Bun workspaces + Turborepo]]
- [[_COMMUNITY_package.json|package.json]]

## God Nodes (most connected - your core abstractions)
1. `ADR-000: Monorepo tooling — Bun workspaces + Turborepo` - 6 edges
2. `studafy` - 5 edges
3. `build` - 3 edges
4. `scripts` - 2 edges
5. `scripts` - 2 edges
6. `turbo` - 2 edges
7. `scripts` - 2 edges
8. `tasks` - 2 edges
9. `private` - 1 edges
10. `build` - 1 edges

## Surprising Connections (you probably didn't know these)
- None detected - all connections are within the same source files.

## Import Cycles
- None detected.

## Communities (8 total, 0 thin omitted)

### Community 0 - "package.json"
Cohesion: 0.25
Nodes (7): name, packageManager, private, scripts, build, version, workspaces

### Community 1 - "turbo.json"
Cohesion: 0.25
Nodes (7): devDependencies, turbo, dependsOn, outputs, $schema, tasks, build

### Community 2 - "studafy"
Cohesion: 0.29
Nodes (5): Adding a workspace, Getting started, Repo layout, Requirements, studafy

### Community 3 - "package.json"
Cohesion: 0.33
Nodes (5): name, private, scripts, build, version

### Community 4 - "ADR-000: Monorepo tooling — Bun workspaces + Turborepo"
Cohesion: 0.33
Nodes (6): ADR-000: Monorepo tooling — Bun workspaces + Turborepo, Alternatives considered, Consequences, Context, Decision, Status

### Community 5 - "package.json"
Cohesion: 0.33
Nodes (5): name, private, scripts, build, version

## Knowledge Gaps
- **26 isolated node(s):** `name`, `version`, `private`, `build`, `name` (+21 more)
  These have ≤1 connection - possible missing edges or undocumented components.

## Suggested Questions
_Questions this graph is uniquely positioned to answer:_

- **Why does `devDependencies` connect `turbo.json` to `package.json`?**
  _High betweenness centrality (0.065) - this node is a cross-community bridge._
- **Why does `ADR-000: Monorepo tooling — Bun workspaces + Turborepo` connect `ADR-000: Monorepo tooling — Bun workspaces + Turborepo` to `studafy`?**
  _High betweenness centrality (0.052) - this node is a cross-community bridge._
- **What connects `name`, `version`, `private` to the rest of the system?**
  _26 weakly-connected nodes found - possible documentation gaps or missing edges._