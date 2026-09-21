# Dependency update policy

How Studafy's dependencies get updated, who (or what) opens the PR, and what may merge itself. The
goal is a documented, automatic posture: security advisories become PRs within 24 hours, routine
updates arrive grouped to limit noise, and nothing breaking merges without a human.

## Tooling

Two bots with **disjoint scopes** — no double PRs:

| Tool       | Scope                                                    | Why                                                                                                                                                                                                                             |
| ---------- | -------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Renovate   | `bun` (JS/TS) deps, `pub` (Dart/Flutter) deps, lockfiles | Runs on a day-to-day cadence, groups, auto-merges security fixes                                                                                                                                                                |
| Dependabot | GitHub Actions only                                      | Its weekly + 7-day cooldown is the deliberate, documented supply-chain stance for action releases (see `.github/dependabot.yml`); a fresh action release can be malicious or unstable, and Renovate has no faithful equivalent. |

Configuration lives in `.github/renovate.json`; the two scopes are kept apart there by a
`matchManagers: ["github-actions"]` disable rule.

## Cadence

| Update kind                                       | When proposed                                 | Merges how             |
| ------------------------------------------------- | --------------------------------------------- | ---------------------- |
| Security advisory fixes (patch/minor)             | Immediately (advisory event + daily runs)     | Auto-merge on green CI |
| Security advisory fixes requiring a major bump    | Immediately                                   | Human, flagged `major` |
| Non-major (minor/patch) updates                   | Weekly, Monday 06:00 UTC, grouped into one PR | Human                  |
| Major version bumps                               | When released (no wait)                       | Human, flagged `major` |
| Lockfile maintenance (`bun.lock`, `pubspec.lock`) | Weekly, Monday 06:00 UTC, separate PR         | Human                  |

## Security advisory PRs (<24h)

The acceptance criterion — _"security advisories produce PRs <24h"_ — is met by running **two**
advisory sources, because the repo can't rely on GitHub's native alerts alone:

- **GitHub native alerts (GHSA)** fire off the security-advisory event, so a PR opens as soon as
  GitHub publishes; they also deliberately skip every limit (`schedule`, `prHourlyLimit`,
  `prConcurrentLimit`). They require the repo's Dependency Graph (Advanced Security on a private
  repo) to be enabled — currently **not** enabled (see the `dependency-review` step in
  `.github/workflows/ci.yml`).
- **`osvVulnerabilityAlerts` (OSV.dev)** queries a public API and works with **no** GitHub
  Dependency Graph/Advanced Security prerequisite. Its latency is bounded by the bot's run cadence
  (daily at minimum), still within 24h. This is the guaranteed-available path today.

The two sources disagree on a meaningful share of advisories, so running both is the union — a
redundancy, not a duplication. Advisory sources deliberately bypass the 7-day release-age yank
window (`minimumReleaseAge: "0 days"` in the `vulnerabilityAlerts` block): a known CVE in
production is a worse failure mode than an unvetted fix.

## Auto-merge policy

- **Auto-merges only non-major security fixes** (patch/minor/digest), and only via GitHub's native
  auto-merge (`platformAutomerge: true`): the PR is enqueued and merges when the base branch's
  **required status checks are green**. CI here means the actual gates — lint/typecheck/unit,
  integration suites, DB migrations, security scan, e2e — so "green" is load-bearing.
- **Nothing major ever auto-merges**, including major-bump security fixes. Renovate deliberately
  cannot be told to skip a vulnerability update, so the control point is merge policy, not PR
  creation: a major fix still arrives fast and flagged, but a human merges it. A green CI run
  cannot prove a breaking change doesn't break runtime behavior.
- The 7-day release-age window means non-security updates are not proposed until a week after
  upstream publishes, so a malicious package has time to be yanked before it can enter a human's
  queue.

## Flagging majors

Major bumps get a `major` label on the PR and never auto-merge; they also appear in the dependency
dashboard issue. Nothing else changes for them — they are proposed immediately on release rather
than batched.

## Operational prerequisites

These are repo settings, not code, and are listed here so onboarding a new repo (or re-installing
the bot) doesn't rediscover them:

1. **Mend Renovate GitHub App** installed with read/write on contents + pull-requests, and read on
   security events/alerts. `onboarding: false` in the committed config skips the onboarding PR.
2. Repo **Settings → Pull Requests → "Allow auto-merge"** enabled — without it GitHub cannot
   auto-merge on green.
3. **Dependency Graph** enabled (Settings → Code security and analysis). Unblocks GitHub-native
   vulnerability alerts and the previously `continue-on-error` `dependency-review-action` step in
   `ci.yml`.
4. **Branch protection** on `dev` with the CI checks required — `quality`, `hooks`,
   `security-scan`, and the other meaningful jobs — so "green" for auto-merge means CI actually
   passed. This is what "auto-merge on green" resolves to.

## Escalation

- Any bot PR failure (conflicting grouped update, flaky CI, reviewer objections) is unblocked by
  reverting the bot's base commit and merging the package bump manually — the automatic flow is a
  convenience, not a requirement.
- If a security fix needs expedited shipping beyond bot cadence, open the bump by hand; the bot
  will reconcile on its next run.
