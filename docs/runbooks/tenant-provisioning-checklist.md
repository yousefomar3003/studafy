# Tenant Provisioning Checklist (ST-089)

## Overview

This document describes the tenant provisioning pipeline that runs after a school's email is verified. It provisions the Studafy local defaults (subscription, notification preferences) and registers the school's ERPNext site, which an operator then creates (a Frappe site can only be made by bench, never over the REST API) and which switches itself on at the school's first finance request.

## Provisioning Flow

```
1. POST /api/schools/register          (public, captcha-protected)
   → Creates school (status=registered), admin user (ORG_ADMIN, invited)
   → Returns verification_token + invitation_token (once only)

2. GET /api/schools/verify-email/{token}  (public)
   → Consumes token, sets email_verified_at, status='active'
   → Triggers async provisioning (fire-and-forget)

3. Provisioning Pipeline (async)
   a. Local Postgres Provisioning
      - Put the school on the free plan (active, never ends — migration 000126)
      - Seed notification preferences for admin user
      - Confirm ORG_ADMIN role

   b. ERPNext site registration (only when ERPNEXT_API_URL/KEY are configured)
      - Write app.erpnext_site_configs as 'pending': site <slug>.<ERPNEXT_SITE_DOMAIN>,
        company = school name, abbreviation from the slug. No ERPNext call.

   c. On success:
      - Mark provisioning_status = 'completed'
      - Emit school.created event to outbox

5. Operator: infra/deploy/scripts/erpnext-new-site.sh <env> <site> --school-id <id> --company "<name>" --abbr <ABBR>
   → bench new-site, ERPNext setup wizard (the school's company), integration key, webhooks

6. The school's first finance request
   → the API finds the site answering with its company and marks it 'completed'

4. POST /auth/activate  (public, OIDC-based)
   → Consumes invitation, activates user, issues JWT tokens
```

## School plan

Studafy is free for schools: every school is on the `free` plan (`app.plans.code = 'free'`),
`status = 'active'`, `current_period_end = 9999-12-31`, with no trial and no expiry (migration
000126). `student_cap` (50) is stored but not enforced. The only paid products are per-student
add-ons, such as the AI add-on.

## ERPNext site

### Prerequisites

- `ERPNEXT_API_URL` (the plane's internal ALB; rendered from terraform output) and
  `ERPNEXT_API_KEY` (`<api_key>:<api_secret>`, one credential for every school's site) in the
  api and workers app secrets -- see docs/runbooks/production-secrets.md.
- `ERPNEXT_SITE_DOMAIN` per tier (`infra/deploy/environments/<tier>.env`).

### Creating a school's site

1. Read the school's row: `SELECT school_id, site_name, company_name, company_abbr FROM
app.erpnext_site_configs WHERE status = 'pending'`.
2. Run `infra/deploy/scripts/erpnext-new-site.sh <staging|prod> <site_name> --school-id <school_id>
--company "<company_name>" --abbr <company_abbr> [--currency JOD] [--country Jordan]`. It creates
   the site with erpnext + education, finishes ERPNext's setup wizard (company, chart of accounts,
   fiscal year, currency), sets the shared integration key on the site's integration user, creates
   the Scholarship Award doctype, and installs the webhooks that report submitted invoices,
   payments and fees to the API (`infra/deploy/erpnext/seed/provision.py`).
3. Nothing else: on the school's next finance request the credential resolver sees the site answer,
   records its company in `erpnext_company_id` and marks the row `completed`. Until then every
   finance route answers 503 `ERPNEXT_NOT_CONFIGURED`.

Locally, `bun run erpnext:up` and `bun run erpnext:site` do the same for every school in the local
database (with sample invoices and payments).

### Site naming convention

```
{school-slug}.{ERPNEXT_SITE_DOMAIN}
```

Example: `springfield-academy.erpnext.studafy.com`. Only a Host header inside the VPC -- the ERPNext
frontend picks the site from it -- never a public DNS name.

### Local provisioning failure

- Mark `subscriptions.provisioning_status = 'failed'` and `schools.provisioning_status = 'failed'`
- The ERPNext site is not registered

## Idempotency

The provisioning process is strictly idempotent:

- **Retry of completed provisioning**: Returns existing state, no duplicate rows
- **Retry of in-progress provisioning**: Returns 409 PROVISIONING_IN_PROGRESS
- **Retry of failed provisioning**: Re-runs the full pipeline
- **ERPNext site already registered**: the row is left as it is (`ON CONFLICT DO NOTHING`)

## Database Tables

### New Tables (Migration 000038)

| Table                            | Purpose                             |
| -------------------------------- | ----------------------------------- |
| `app.erpnext_site_configs`       | Maps school to ERPNext site/company |
| `app.provisioning_status` (enum) | Tracks provisioning lifecycle       |

### Modified Tables

| Table               | Changes                                                         |
| ------------------- | --------------------------------------------------------------- |
| `app.subscriptions` | Added: `student_cap`, `trial_expires_at`, `provisioning_status` |
| `app.schools`       | Added: `provisioning_status`                                    |

## Monitoring Queries

### Provisioning Status Distribution

```sql
SELECT
  provisioning_status,
  COUNT(*) AS school_count
FROM app.schools
GROUP BY provisioning_status;
```

### Failed Provisionings

```sql
SELECT
  s.id AS school_id,
  s.slug,
  s.provisioning_status,
  ess.site_name,
  ess.status AS erpnext_status,
  ess.last_error,
  ess.created_at
FROM app.schools s
LEFT JOIN app.erpnext_site_configs ess ON ess.school_id = s.id
WHERE s.provisioning_status = 'failed'
ORDER BY s.created_at DESC;
```

## API Endpoints

### Provisioning Status

```
GET /api/schools/{schoolId}/provisioning-status
```

Returns the current provisioning status including ERPNext site configuration.

### Manual Provisioning Trigger

```
POST /api/schools/{schoolId}/provision
```

Manually triggers the full provisioning pipeline. Idempotent on retries.

## Troubleshooting

### Finance answers ERPNEXT_NOT_CONFIGURED for a school

1. `SELECT site_name, status, last_error FROM app.erpnext_site_configs WHERE school_id = ...`
2. No row: the school was provisioned while ERPNext was not configured -- re-run provisioning.
3. `pending`: the site has not been created, or it does not answer yet. Run (or re-check)
   erpnext-new-site.sh; from inside the VPC, `GET /api/resource/Company` with the site as the Host
   header and the integration key must answer 200 with the company.
