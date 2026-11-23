// Shared by the demo seed (seed.ts, the local "Studafy" platform school) and the QA seed
// (qa-tenant.ts, the staging platform school).
import { displayName } from "../mock-credentials";
import { seedDate, uuid } from "../support";

import type { SchoolCtx, Sql, TenantProfile } from "../support";

// A platform school: its personas (the SUPER_ADMIN) as users with roles and logins, and nothing
// else. The school data modules assume a full roster (an ORG_ADMIN, teachers, students), which a
// school that exists only to hold platform staff does not have.
export async function populatePlatformStaff(
  sql: Sql,
  school: SchoolCtx,
  tenant: TenantProfile,
): Promise<void> {
  for (const persona of tenant.personas) {
    const userId = uuid();
    await sql`
      INSERT INTO app.users ${sql({
        id: userId,
        school_id: school.schoolId,
        email: persona.email,
        normalized_email: persona.email.toLowerCase(),
        display_name: displayName(persona),
        status: "active",
        email_verified_at: seedDate(-40, 10),
        created_at: seedDate(-40, 8),
      })}
    `;
    await sql`
      INSERT INTO app.user_roles ${sql({ school_id: school.schoolId, user_id: userId, role: persona.role })}
    `;
    const identity = tenant.loginIdentity(persona);
    if (identity) {
      await sql`
        INSERT INTO app.oauth_identities ${sql({
          id: uuid(),
          school_id: school.schoolId,
          user_id: userId,
          ...identity,
        })}
      `;
    }
  }
}
