# Tenant Lifecycle State Machine (SAD §11)

**Ticket:** ST-092
**Status:** Implemented
**Middleware:** `apps/api/src/middleware/tenant-lifecycle.ts`

---

## Overview

Every tenant (school) has a subscription with a lifecycle status stored in `app.subscriptions.status`.
The `tenantLifecycleGuard` middleware reads this status from the JWT `subscription_status` claim
(zero DB calls per request) and enforces access rules on every authenticated `/api/*` request.

## State Machine

```
                    ┌─────────────────────────────────────────────┐
                    │                                             │
                    ▼                                             │
               ┌─────────┐     payment succeeds     ┌────────┐   │
               │ trialing │ ──────────────────────→  │ active  │   │
               └─────────┘                          └────────┘   │
                    │                                    │        │
                    │ trial expires                      │ payment fails
                    ▼                                    ▼        │
              ┌──────────────┐  payment recovered  ┌────────────┐│
              │ grace_period │ ←─────────────────── │ grace_     ││
              └──────────────┘                     │ period     ││
                    │                              └────────────┘│
                    │ grace exhausted                            │
                    ▼                                            │
              ┌─────────┐                                       │
              │ closed  │ ←── (terminal, no transitions out) ───┘
              └─────────┘
```

Additional soft terminal states (not enforced by middleware, treated as pass-through):

- **`past_due`** — payment missed but not yet in grace period
- **`canceled`** — voluntary cancellation
- **`expired`** — period lapsed without renewal

## State Behavior Table

| State          | Read (GET)              | Write (POST/PUT/PATCH/DELETE) | Response Header               | Error Code                                    |
| -------------- | ----------------------- | ----------------------------- | ----------------------------- | --------------------------------------------- |
| `trialing`     | Allowed                 | Allowed (student cap: 50)     | —                             | `LIMIT_EXCEEDED_STUDENT_CAP` (402) on cap hit |
| `active`       | Allowed                 | Allowed                       | —                             | —                                             |
| `grace_period` | Allowed                 | Allowed                       | `X-Tenant-Grace-Banner: true` | —                                             |
| `past_due`     | Allowed                 | Allowed                       | —                             | —                                             |
| `canceled`     | Allowed                 | Allowed                       | —                             | —                                             |
| `expired`      | Allowed                 | Allowed                       | —                             | —                                             |
| `suspended`    | ORG_ADMIN, FINANCE only | Blocked                       | —                             | `TENANT_SUSPENDED` (403)                      |
| `closed`       | Blocked                 | Blocked                       | —                             | `TENANT_CLOSED` (403)                         |

## Error Responses

All lifecycle errors use the RFC 9457 `application/problem+json` envelope:

### 402 Payment Required — Student Cap Exceeded

```json
{
  "type": "about:blank",
  "title": "Payment Required",
  "status": 402,
  "detail": "Student cap of 50 reached. You currently have 50 students. Upgrade your plan to add more.",
  "code": "LIMIT_EXCEEDED_STUDENT_CAP",
  "request_id": "0f5c6b64-2b3f-4c8e-9a1e-6f3e5f0a9b12"
}
```

### 403 Forbidden — Tenant Suspended

```json
{
  "type": "about:blank",
  "title": "Forbidden",
  "status": 403,
  "detail": "Tenant is suspended. Only read access is available for billing recovery.",
  "code": "TENANT_SUSPENDED",
  "request_id": "0f5c6b64-2b3f-4c8e-9a1e-6f3e5f0a9b12"
}
```

### 403 Forbidden — Tenant Closed

```json
{
  "type": "about:blank",
  "title": "Forbidden",
  "status": 403,
  "detail": "This tenant has been permanently closed. Contact support for assistance.",
  "code": "TENANT_CLOSED",
  "request_id": "0f5c6b64-2b3f-4c8e-9a1e-6f3e5f0a9b12"
}
```

## Architecture Decisions

### JWT-Embedded Status (Zero DB Calls Per Request)

The subscription status is embedded as a custom claim in the JWT access token. This means:

- **Zero additional database queries** on every request for lifecycle enforcement.
- Status changes propagate within one refresh cycle (max 30 days).
- On token refresh (`rotateRefreshToken`), the status is re-read from the DB inside the
  existing `withTenantTx` transaction — effectively free.

### Student Cap Enforcement (Service Layer)

The student cap is enforced at the service layer, not in middleware, because:

- Student creation endpoints vary across modules.
- The check needs the transaction context (`withTenantTx`).
- Bulk imports need to check `current + importCount` against the cap.
- The `assertStudentCap(tx, additionalStudents)` helper provides a clean fail-fast pattern.

### Middleware Registration Order

```
requestId → cors → security → csrf → locale → logger
→ jwtAuth → tenantLifecycleGuard → rateLimiter → idempotency
→ routes
```

The lifecycle guard runs after JWT auth (needs auth context) and before rate limiting
(lifecycle blocks should not consume rate limit quota).

## FINANCE Role

Added in migration `000039`. The FINANCE role has billing-scoped read permissions:

- `billing:read`, `billing:update`, `billing:viewInvoices`
- `report:read`, `report:viewFinancial`
- `auditLog:read`, `auditLog:export`
- `organization:read`, `user:read`, `notification:read`

During suspension, only ORG_ADMIN and FINANCE roles may perform GET requests
(billing recovery and data inspection). All other roles are completely blocked.
