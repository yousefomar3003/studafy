# Tenant Provisioning Checklist (ST-089)

## Overview

This document describes the tenant provisioning pipeline that runs after a school's email is verified. It provisions both the Studify local defaults (subscription, notification preferences) and automatically bootstraps the corresponding ERPNext site/company with full accounting and education defaults.

## Provisioning Flow

```
1. POST /api/schools/register          (public, captcha-protected)
   → Creates school (status=registered), admin user (ORG_ADMIN, invited)
   → Returns verification_token + invitation_token (once only)

2. GET /api/schools/verify-email/{token}  (public)
   → Consumes token, sets email_verified_at, status='active' (trial begins)
   → Triggers async provisioning (fire-and-forget)

3. Provisioning Pipeline (async)
   a. Local Postgres Provisioning
      - Create trial subscription (50 students, 14-day expiry)
      - Seed notification preferences for admin user
      - Confirm ORG_ADMIN role

   b. ERPNext Bootstrap
      - Create isolated ERPNext site
      - Create Company with COA, currency, tax templates
      - Setup naming series
      - Bootstrap education defaults (academic structures, fee categories)

   c. On success:
      - Mark provisioning_status = 'completed'
      - Emit school.created event to outbox

   d. On ERPNext failure:
      - Compensate: teardown ERPNext site
      - Mark provisioning_status = 'failed'

4. POST /auth/activate  (public, OIDC-based)
   → Consumes invitation, activates user, issues JWT tokens
```

## Trial Limits

| Limit          | Value   | Enforcement                                                      |
| -------------- | ------- | ---------------------------------------------------------------- |
| Student cap    | 50      | `app.subscriptions.student_cap` column, application-level check  |
| Trial duration | 14 days | `app.subscriptions.trial_expires_at` column, set at provisioning |

## ERPNext Bootstrap

### Prerequisites

- `ERPNEXT_API_URL` environment variable (ERPNext API base URL)
- `ERPNEXT_API_KEY` environment variable (API key + secret)
- ERPNext site must be reachable from the API service

### Bootstrap Steps

1. **Site Creation**: Creates isolated Frappe site with erpnext + education apps
2. **Company Creation**: Creates ERPNext Company with country/currency defaults
3. **Naming Series**: Sets up document naming series for the company
4. **Education Defaults**: Creates academic structures, fee categories

### Site Naming Convention

```
{school-slug}.{ERPNEXT_SITE_DOMAIN}
```

Example: `springfield-academy.erpnext.studafy.com`

## Compensation & Rollback

### ERPNext Site Creation Failure

- Attempt to delete the partially-created site
- Mark `erpnext_site_configs.status = 'failed'`
- Log the error for manual investigation

### ERPNext Company Creation Failure

- Attempt to delete the site (which removes the company)
- Mark `erpnext_site_configs.status = 'failed'`
- Log the error for manual investigation

### Local Provisioning Failure

- Mark `subscriptions.provisioning_status = 'failed'`
- Mark `schools.provisioning_status = 'failed'`
- ERPNext bootstrap is skipped

## Idempotency

The provisioning process is strictly idempotent:

- **Retry of completed provisioning**: Returns existing state, no duplicate rows
- **Retry of in-progress provisioning**: Returns 409 PROVISIONING_IN_PROGRESS
- **Retry of failed provisioning**: Re-runs the full pipeline
- **ERPNext site already exists**: Site creation handles DuplicateEntryError

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

### Trial Expiry Monitoring

```sql
SELECT
  s.slug,
  s.name,
  sub.trial_expires_at,
  sub.student_cap,
  sub.status AS subscription_status,
  CASE
    WHEN sub.trial_expires_at < NOW() THEN 'expired'
    WHEN sub.trial_expires_at < NOW() + INTERVAL '3 days' THEN 'expiring_soon'
    ELSE 'active'
  END AS trial_status
FROM app.subscriptions sub
JOIN app.schools s ON s.id = sub.school_id
WHERE sub.status = 'trialing'
ORDER BY sub.trial_expires_at ASC;
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

### Provisioning stuck in 'in_progress'

1. Check the ERPNext API logs for errors
2. Query `app.erpnext_site_configs` for the school
3. Manually trigger provisioning via the API endpoint
4. If ERPNext site exists but Studify thinks it doesn't, clean up the site config

### ERPNext site exists but company is missing

1. Query ERPNext directly: `GET /api/resource/Company/{company_name}`
2. If missing, re-run provisioning with manual trigger
3. If exists, update `erpnext_site_configs.erpnext_company_id` manually

### Trial expired but subscription not updated

1. Check `app.subscriptions.trial_expires_at` value
2. The subscription status transition from 'trialing' to 'expired' is handled by
   a background worker (not part of ST-089)
3. Manually update if needed: `UPDATE app.subscriptions SET status = 'expired' WHERE ...`
