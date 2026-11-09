# Member setup codes (rollout of QA-11 / F-02)

Students, parents, teachers and attendance officers sign in with their member ID (`STU-…`,
`PAR-…`, `TCH-…`, `ATT-…`) and a password. Before QA-11, every account started on one shared
password, `pass@1234`, and anyone could use it to claim an account that had never been used. Member
IDs are sequential, so this was finding F-02 (Critical) in the
[findings register](../security/findings-register.md).

From migration 000184 on, nobody has a starting password. A member claims their account with a
**setup code**:

- random per member (80 bits, printed `XXXX-XXXX-XXXX-XXXX`; case and dashes ignored);
- shown once, only to the administrator who issues it, and stored only as a SHA-256 digest;
- valid for **14 days**, and used up when the member chooses their password;
- typed into the normal password field. The app then asks for a new password, as it did before.

- Service: [`member-password-service.ts`](../../apps/api/src/modules/auth/services/member-password-service.ts)
- Schema: [`000184_add_member_setup_codes.sql`](../../db/migrations/000184_add_member_setup_codes.sql)
- Admin UI: `/portal/members` ([`SchoolMembersPage.tsx`](../../apps/web/src/features/admin/members/SchoolMembersPage.tsx))

## How administrators issue codes

| Situation                                 | Where                                                                                             | API                                             |
| ----------------------------------------- | ------------------------------------------------------------------------------------------------- | ----------------------------------------------- |
| Adding one member                         | **Add member**. The code appears with their ID.                                                   | `POST /api/users/{userId}/password/reset`       |
| Forgotten password, lost or expired code  | **Reset password** on their row. Their password stops working and they are signed out everywhere. | `POST /api/users/{userId}/password/reset`       |
| Everyone of a role who cannot sign in yet | **Issue codes to … not signed up**. Downloads a CSV of name, ID, code and expiry.                 | `POST /api/users/member-setup-codes` `{ role }` |

The bulk action only reaches active or invited members who have never set a password **and** have
no unexpired code. Running it twice does not invalidate a sheet that has already been handed out.
It never signs anyone out. Members created by imports and class records get their codes this way.

The CSV gives whoever holds it access to those accounts. Hand the codes out, then delete the file.

## Rollout

1. **Before deploy:** tell school administrators that sign-in for members who have never signed
   in will change, and point them to the bulk action above. Members who already chose a password
   are not affected.
2. **Deploy.** Migration 000184 adds two columns and needs no backfill. Once the API runs the new
   code, `pass@1234` no longer opens any account, including ones issued before the deploy.
   There is no transition window, on purpose: keeping the default for existing accounts would leave
   F-02 open for exactly the accounts an attacker targets.
3. **After deploy:** each school issues codes for every role with members who have not signed up.
   Support can count the affected members per school (run as `studafy_admin`):

   ```sql
   SELECT s.name, mc.kind, count(*) AS cannot_sign_in
   FROM app.member_codes mc
   JOIN app.users u ON u.id = mc.user_id AND u.school_id = mc.school_id
   JOIN app.schools s ON s.id = mc.school_id
   LEFT JOIN app.member_credentials cr ON cr.user_id = mc.user_id AND cr.school_id = mc.school_id
   WHERE u.status IN ('active', 'invited')
     AND cr.password_hash IS NULL
     AND coalesce(cr.setup_code_expires_at <= CURRENT_TIMESTAMP, true)
   GROUP BY s.name, mc.kind
   ORDER BY s.name, mc.kind;
   ```

4. **Rollback:** reverting the API code brings the shared default back. **Do not** do that to fix
   a sign-in problem. Issue a code instead. The migration can stay in place: its columns are
   nullable and the old code ignores them.

## Rate limits

`/api/auth/login/member` has three limits. They are Redis token buckets, defined in
[`config/rateLimits.ts`](../../apps/api/src/config/rateLimits.ts):

| Bucket     | Key                                   | Budget                   |
| ---------- | ------------------------------------- | ------------------------ |
| Per IP     | client IP (`auth-strict`)             | 5 burst, ~5/min          |
| Per member | normalized member ID, whatever the IP | 10 burst, ~10 per 15 min |
| Global     | every member sign-in on the platform  | 600 burst, 10/s          |

Five wrong passwords also lock an account for 15 minutes. A blocked request gets `429` with a
`Retry-After` header. It also logs `auth_rate_limit_block` with `route_class`
`member-login-username` or `member-login-global`. A global block means many member IDs are being
tried at once. Treat it as an incident: while that bucket is empty, every member sign-in is
refused. Without Redis all three limits are off; the account lockout still applies.

## Support answers

- **"My code doesn't work."** It has either expired, been used, or been replaced by a newer reset.
  Issue a new one with **Reset password**.
- **"The app says my ID or password is wrong."** This message is the same for a wrong password,
  an unknown ID and a used code. That is intentional. Check the ID, then reset.
- **"Too many attempts."** Wait 15 minutes, or reset the password. A reset also clears the lockout.
