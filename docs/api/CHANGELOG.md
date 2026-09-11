# API changelog

Human-readable log of changes to [`apps/api/openapi.json`](../../apps/api/openapi.json), the
generated HTTP contract. Every pull request that changes that file adds an entry here under
**Unreleased** — CI enforces this (see
[`api-versioning-policy.md`](./api-versioning-policy.md)).

Format loosely follows [Keep a Changelog](https://keepachangelog.com/): group entries as `Added`,
`Changed`, `Removed`, or `Fixed` under a heading. Mark a `Changed`/`Removed` entry **(breaking)**
when it required the `version-bump` label.

## Unreleased

### Added

- `POST /api/privacy/dsr` — file a GDPR export or erasure request for one user
  (`PRIVACY_DSR_MANAGE`). ST-268.
- `GET /api/privacy/dsr/{requestId}` — read a data subject request's status and, once a completed
  export, a short-lived download URL. ST-268.
