# Studafy QA audit — final report

**Date:** 2026-11-17 · **Scope:** the whole monorepo (API, workers, realtime, web, mobile, database,
CI/CD, Fly infrastructure). Plan: `docs/qa/QA_PLAN.md`. Per-task evidence: `docs/qa/QA_PROGRESS.md`.

## Summary

All 93 planned tasks have a recorded outcome. Every code change was test-first: a failing test,
then the fix, then the full gate. The gate is format, typecheck, lint, unit, the full API suite and
the security suite. Nothing was run against production or any live Fly app.

| Outcome                        | Tasks | Meaning                                                                                  |
| ------------------------------ | ----: | ---------------------------------------------------------------------------------------- |
| Done                           |    46 | Fixed and verified by automated tests                                                    |
| Done, with a follow-up for you |    10 | Fixed; a setting, secret or sign-off is still yours                                      |
| Partial                        |    28 | The repository side is done; the rest needs a decision, console access, or a deploy step |
| Needs you only                 |     9 | Policy, legal, or account access that cannot be decided in code                          |

By severity: the one CRITICAL (QA-007) is code-complete and waits on one product decision. Of
21 HIGH tasks, 7 are fully done, 10 are done in the repository with a human step left, and 4 need
you only (QA-045, QA-076, QA-077, QA-079).

**State at the end:** API suite 4871 pass / 0 fail; security suite 1283 pass / 0 fail; workers 595+
pass / 0 fail; db package 180 pass / 0 fail; mobile `flutter test` 1247 pass / 16 skipped / 0 fail.

Three agents shared the machine for part of the run. The mobile and infra helpers' branches were
cherry-picked onto the main stack and re-verified there.

## How to merge

All work is on one linear stack of `qa/*` branches based on `stage`: 187 commits, about 450 files
outside `graphify-out`. Each task is a `fix(QA-xxx)` commit followed by a `docs(qa): record QA-xxx
evidence` commit. The tip branch, `qa/needs-human-027-048-078-082-083`, contains everything.
Merging it into `dev` brings in the whole audit. Production deploys go out from `dev`, as usual.

Ten new migrations, **000226–000235**. All are forward-only and additive, with no drops of data.
000235 rewrites `app.material_chunks` (its statement timeout is 30 minutes).

## Before you deploy — blockers

These will break the deploy, or a feature, if skipped:

1. **QA-023: JWT signing key.** Generate `JWT_PRIVATE_KEY_PEM` (and optionally `JWT_NEXT_PRIVATE_KEY_PEM`)
   and set it on the API **before** deploying: the API refuses to boot without it on deployed
   tiers. Runbook: `docs/runbooks/rotation-jwt-jwks.md`.
2. **QA-066: transport security.** In production the API now requires `REDIS_URL` with `rediss://`
   (unless the host is `.internal` or `.flycast`), and the workers require `sslmode=verify-full`
   plus a CA for the database. Confirm the Fly secrets match before deploying.
3. **QA-022: ERPNext idempotency field.** Add `custom_studafy_idempotency_key` on every production
   ERPNext site first (`docs/runbooks/erpnext-invoice-idempotency.md`).
4. **QA-015: database role.** Migration 000232 creates `studafy_system` and grants it to every
   login that may switch to `studafy_admin`, so it works on first boot. Watch the migration log
   for errors.
5. **QA-084: mobile release.** Resolved: the mobile release reuses the existing repository
   `SENTRY_AUTH_TOKEN` (the organization token the web build uses), so no new secret is needed.
6. **QA-058: App Review.** Set `STORE_SANDBOX_ALLOWED_USER_IDS` to the reviewers' demo account before
   the next submission, or their sandbox purchases are refused in production.

## Needs your decision or action

**Product and policy**

- QA-007 (CRITICAL): retire self-registration, or route it into the reviewed school-applications
  queue. The code guards it either way.
- QA-027: MFA for privileged accounts. Recommended: an allowlisted Workspace/Entra domain with
  IdP-enforced MFA (`amr=mfa`) for platform staff, and TOTP later for school admins.
- QA-038: what a CLOSED school can still do.
- QA-029: confirm the AI age bands and the unknown-age default.
- QA-039: what SUPPORT_AGENT may see.
- QA-056: whether refunds and disputes should suspend access. Disputes now raise alert A11.
- QA-061: the policy decision recorded in its row.

**Legal / compliance (counsel)**

- QA-076, QA-077: the children's-data dossier, DPIA, international transfers, R2 jurisdiction and
  Sentry region. ERPNext and Stripe are flagged as undisclosed sub-processors.
- QA-078: the account-deletion timeline (now up to ~44 days), and whether a student may delete a
  school account without the school.
- QA-088: Crashlytics consent; Sentry "Prevent storing IP"; the Firebase data-processing terms.
- QA-020: log retention and the Axiom DPA.
- QA-069: Terms §2.3 and the school agreement still say five wrong passwords lock the account.
  It is now five per address, and 25 for the account. I didn't edit the versioned legal texts.

**Consoles and accounts**

- QA-005: the `prod` environment's branch policy and reviewers, and `dev` branch protection.
- QA-006: create the `mobile-release` environment and move the signing secrets into it.
- QA-045: paid PITR, R2 replication, RPO/RTO.
- QA-046: create the alert rules listed in `docs/runbooks/alerts.md` and run the fire drills.
- QA-052: switch the CSP from Report-Only to enforcing after a week of clean reports.
- QA-071: the remaining AWS account clean-up. Inventory: `docs/qa/evidence/QA-071-aws-inventory.md`.
- QA-072: move the Studafy apps to a dedicated Fly organisation.
- QA-079: the final app identifiers. QA-082 and QA-083 depend on them.
- QA-082: re-answer the IARC/Apple age rating (in-app purchases: yes), and update Data safety and
  the privacy labels. The repo copies are corrected and guarded by a test.
- QA-083: Sign in with Apple, or the exemption argument in the review notes.
- QA-085: set `REVIEW_LOGIN_ALLOWED_EMAILS`, and add an Axiom alert on `review_login_used`.
- QA-054: redeploy the scanner app so the new clamd limits take effect.
- QA-074: after deploy, check 000234's warnings; run `db:test:rls-coverage` read-only against prod.

**Operations and capacity**

- QA-048: run the local k6 scenarios, set Fly concurrency limits, and scale the API to 2 machines
  (after QA-023).
- QA-015 / QA-049: give the API its own database login without the `studafy_admin` grant, and stop
  running migrations as `postgres`.
- QA-019, QA-021, QA-034: deploy-and-rotate steps for the secrets named in those rows. No secret
  value appears in any report or log. Where a secret may have leaked, rotation is listed for you
  to do.

## What changed, by area

- **Tenant isolation and authorization:**
  - FORCE RLS on `app.schools` (QA-016);
  - insert-only ledgers (QA-017);
  - definer functions restore their settings (QA-018);
  - system transactions run as a role that owns nothing, and the audit log can't be truncated (QA-015);
  - platform staff are out of a school admin's reach (QA-060);
  - scoped link candidates (QA-059), discipline (QA-039), audit-log values (QA-040) and AI metrics (QA-062);
  - attendance session writes require teaching the class (QA-087);
  - explicit read gates, and 403 before 400 on writes (QA-086).
- **Authentication and sessions:**
  - persistent JWT keys (QA-023);
  - sessions revoked on password and role change (QA-024, QA-026);
  - ID-token login off by default (QA-025);
  - cross-tab refresh (QA-033);
  - rate limits that neither throttle a campus nor lock out every school (QA-028);
  - lockout per address that doesn't reveal whether an ID exists (QA-069);
  - `__Host-` cookie and Microsoft claim checks (QA-070);
  - server-decided session channel, a 90-day session cap, and a fenced review login (QA-085).
- **Payments and stores:**
  - idempotent ERPNext invoices (QA-022);
  - per-site webhook secrets (QA-034);
  - billing event locking (QA-035);
  - settled-payment activation and dispute alerts (QA-056);
  - sandbox purchases restricted in production (QA-058);
  - timing-safe keys (QA-092).
- **Files and scanning:**
  - ETag- and size-bound uploads (QA-036);
  - atomic storage quota (QA-037);
  - stuck-scan sweeper, fail-closed scan status and receipt scanning (QA-055);
  - ClamAV limits aligned with uploads, failing closed on encrypted and over-limit files (QA-054).
- **Privacy:**
  - log redaction (QA-019, QA-020);
  - token scrub in the outbox (QA-032);
  - self-erasure safeguards (QA-042);
  - CSV formula injection fixed (QA-063);
  - recent searches cleared on sign-out (QA-089);
  - offline cache isolation and crash scrubbing on mobile (QA-080, QA-081, QA-088);
  - store declarations corrected (QA-082).
- **AI:**
  - server-decided moderation level (QA-029);
  - the unused LLM gateway is unmounted (QA-030);
  - grade events go to their recipients only (QA-031);
  - parser limits (QA-043);
  - retrieval scoped inside each search leg, with Arabic search (QA-051).
- **Reliability and operations:**
  - graceful shutdown (QA-047);
  - health checks and the alert catalog (QA-046);
  - deploy gate with rollback (QA-005);
  - migration timeouts (QA-049);
  - announcement fan-out ~15× faster (QA-065);
  - semaphore back-off (QA-064);
  - school-local dates (QA-044);
  - records key rotation is audited and has a runbook (QA-090).
- **Supply chain and CI:**
  - actions pinned to commit SHAs (QA-006);
  - image digests (QA-053);
  - gitleaks allowlist (QA-075);
  - dated Trivy waivers and a HIGH image gate (QA-073);
  - web security headers (QA-052);
  - TLS-only transport in production (QA-066);
  - metrics on the private network (QA-072);
  - AWS references removed (QA-071).

## Known limits of this run

- **actionlint:** not run (its Docker run was denied). The workflows parse as YAML, and the pin
  check passes.
- **Workers under the least-privilege login:** not yet run in CI (QA-003, QA-014). The API suite
  passes as that login.
- **Mobile native builds:** not built (no JDK on the QA machine); covered by source-reading tests
  (QA-084).
- **Load testing:** not done (QA-048).
- **QA-044:** per-school local-hour cron jobs need a scheduler redesign; the date logic itself is
  fixed.
- **QA-073:** 16 dev-tool advisories are blocked by upstream version ranges and listed in its row.
- **QA-039:** its row says the full gate was pending when Docker stopped. Every later gate ran the
  full API suite on top of it and passed.
