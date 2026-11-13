# API versioning policy (ST-253)

How changes to the HTTP contract are classified, gated, and communicated. Enforced by the
`quality` job in [`.github/workflows/ci.yml`](../../.github/workflows/ci.yml); this document
explains the policy behind those steps.

Source of truth for the contract itself is the generated document,
[`apps/api/openapi.json`](../../apps/api/openapi.json) (see
[`apps/api/scripts/generate-openapi.ts`](../../apps/api/scripts/generate-openapi.ts)); this policy
only covers how it is allowed to change over time.

## Classification

Every pull request's `apps/api/openapi.json` is diffed against the PR's base branch with
[oasdiff](https://github.com/oasdiff/oasdiff). oasdiff sorts every difference into one of two
buckets:

- **Breaking** — removing an endpoint or field, narrowing a type, making an optional field or
  parameter required, tightening validation an existing client already relies on passing, etc.
  Anything an already-deployed client could send or parse today that would fail against the new
  contract.
- **Additive** — a new endpoint, a new optional field, a new enum value, relaxing a constraint.
  Anything an already-deployed client can ignore and keep working exactly as before.

CI fails the PR on any **breaking** change (`fail-on: ERR`) unless the PR carries the
**`version-bump`** label.

## Shipping an intentional breaking change

1. Add the `version-bump` label to the PR. CI still reports the specific break (as a job-summary
   warning, since the label makes that one check's failure non-fatal), it just no longer blocks
   merge.
2. Bump the API's major version alongside the change.
3. Describe the break and its migration path in `docs/api/CHANGELOG.md` (required — see below,
   and enforced identically whether the change was breaking or additive).

The label is scoped to the PR that carries it, never to the branch as a whole — the next PR
without the label is gated on the full breaking-change check again, including against any break
this one just introduced.

## Changelog requirement

Any PR that changes `apps/api/openapi.json` — breaking or additive — must also update
[`docs/api/CHANGELOG.md`](./CHANGELOG.md) with an entry under **Unreleased**. CI fails the PR
otherwise. This is what makes "additive change passes with changelog note" true as a day-to-day
fact rather than a convention nobody follows: the gate does not care whether oasdiff called the
change breaking or additive, only whether the contract moved and the changelog explains why.

## Generated artifacts

The `quality` job regenerates the OpenAPI document and the TypeScript client
([`@studafy/api-client`](../../packages/api-client)) on every run, verifies the client's codegen
is deterministic (two back-to-back generations from the same spec must produce byte-identical
output), and publishes both as the `openapi-contract` build artifact. That lets a reviewer or a
downstream consumer inspect the exact contract and client a PR would ship without checking the
branch out.

The Dart client consumed by `apps/mobile` is regenerated and drift-checked in its own job
(`mobile-api-client`, ST-062) against the same `apps/api/openapi.json`; this policy's
classification and changelog rules apply to it identically, it is just verified where the rest of
its pipeline already lives rather than duplicated here.

## Why not semantic versioning of the whole API

The contract has no `/v2` prefix or version header today. Breaking changes are rare enough, and
caught early enough by this gate, that a full parallel-version scheme would be paying an ongoing
maintenance cost (routing, docs, and client generation for every live version) against a risk this
policy already prices in per PR. If breaking changes become frequent enough that clients need to
pin to a version, revisit this document rather than working around the gate.
