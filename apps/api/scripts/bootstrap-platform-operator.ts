/**
 * Creates the very first Studafy operator (SUPER_ADMIN) in an empty database: the platform school
 * that holds Studafy's own staff, and a one-time invitation for one email address. The person opens
 * the printed link and signs in with Google or Microsoft; activation checks the provider's verified
 * email against the invitation, links the sign-in and grants the role (activation-service.ts).
 *
 * Every later operator, school and staff member is created from the product itself. This exists only
 * because the first one has nobody to invite them. It refuses to run once any SUPER_ADMIN exists.
 *
 * Self-contained on purpose (Bun's built-in SQL client and node:crypto, no packages) so it runs
 * unchanged inside the production API container, which bundles its dependencies into `dist/`:
 *
 *   fly ssh sftp shell -a studafy-core-api        # put this file at /tmp/bootstrap.ts
 *   fly ssh console -a studafy-core-api -C \
 *     "bun /tmp/bootstrap.ts --email person@example.com --confirm-production"
 *
 * It connects with the container's own DATABASE_* settings (and DATABASE_CA_CERT when set).
 * Locally: DATABASE_URL=postgres://... bun apps/api/scripts/bootstrap-platform-operator.ts --email ...
 */

import { createHash, randomBytes } from "node:crypto";

import { SQL } from "bun";

export const PLATFORM_SCHOOL_SLUG = "studafy";
const INVITATION_DAYS = 3;

export interface BootstrapResult {
  schoolId: string;
  invitationId: string;
  /** The raw invitation token: shown once, never stored (only its SHA-256 is). */
  token: string;
  link: string;
  createdSchool: boolean;
}

/** Same derivation as apps/api/src/modules/auth/invitation/service.ts (`hashToken`). */
export function hashToken(token: string): Buffer {
  return createHash("sha256").update(token, "utf8").digest();
}

export async function bootstrapPlatformOperator(
  sql: SQL,
  options: { email: string; frontendUrl: string },
): Promise<BootstrapResult> {
  const email = options.email.trim();
  const normalizedEmail = email.toLowerCase();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw new Error(`Not an email address: ${email}`);

  return sql.begin(async (tx): Promise<BootstrapResult> => {
    // studafy_admin: only it may flag a school as a platform school (000185), and it reads across
    // schools to check that no operator exists yet.
    // The tenant policies read app.school_id even for studafy_admin, so it needs a value before the
    // first query; the nil UUID matches no school, the same placeholder 000185 uses.
    await tx`SELECT set_config('app.school_id', '00000000-0000-0000-0000-000000000000', true)`;
    await tx`SELECT set_config('role', 'studafy_admin', true)`;

    // app.user_roles is tenant-isolated even for studafy_admin, so look inside each platform school:
    // the only schools a SUPER_ADMIN can exist in (000185's trigger).
    const platformSchools: { id: string }[] = await tx`
      SELECT id FROM app.schools WHERE is_platform_tenant ORDER BY created_at
    `;
    for (const candidate of platformSchools) {
      await tx`SELECT set_config('app.school_id', ${candidate.id}, true)`;
      const [existing]: { count: string }[] = await tx`
        SELECT count(*)::text AS count FROM app.user_roles
        WHERE school_id = ${candidate.id} AND role = 'SUPER_ADMIN'
      `;
      if (Number(existing!.count) > 0) {
        throw new Error(
          "A SUPER_ADMIN already exists; invite further operators from the platform console.",
        );
      }
    }

    let createdSchool = false;
    let school = platformSchools[0];
    if (!school) {
      const [country]: { id: string }[] = await tx`
        SELECT id FROM app.countries WHERE alpha2_code = 'JO'
      `;
      const [currency]: { id: string }[] = await tx`
        SELECT id FROM app.currencies WHERE code = 'JOD'
      `;
      if (!country || !currency)
        throw new Error("Countries/currencies are not seeded (run migrations first).");
      [school] = await tx`
        INSERT INTO app.schools (
          slug, name, email, normalized_email, status, is_platform_tenant, country_id,
          default_currency_id
        ) VALUES (
          ${PLATFORM_SCHOOL_SLUG}, 'Studafy', 'hello@studafy.com', 'hello@studafy.com', 'active',
          true, ${country.id}, ${currency.id}
        )
        RETURNING id
      `;
      createdSchool = true;
    }

    const token = randomBytes(32).toString("hex");
    await tx`SELECT set_config('app.school_id', ${school!.id}, true)`;
    const [invitation]: { id: string }[] = await tx`
      INSERT INTO app.invitations (
        school_id, email, normalized_email, role, token_hash, invited_by_user_id, expires_at
      ) VALUES (
        ${school!.id}, ${email}, ${normalizedEmail}, 'SUPER_ADMIN'::app.user_role,
        ${hashToken(token)}::bytea, NULL,
        CURRENT_TIMESTAMP + make_interval(days => ${INVITATION_DAYS})
      )
      RETURNING id
    `;

    return {
      schoolId: school!.id,
      invitationId: invitation!.id,
      token,
      link: `${options.frontendUrl.replace(/\/$/, "")}/invite/${token}`,
      createdSchool,
    };
  });
}

/** A connection from the same DATABASE_* settings the API itself uses in production. */
function connect(): SQL {
  const env = process.env;
  const tls = env.DATABASE_CA_CERT
    ? { ca: env.DATABASE_CA_CERT }
    : Boolean(env.DATABASE_SSL_MODE && env.DATABASE_SSL_MODE !== "disable");
  if (env.DATABASE_HOST) {
    return new SQL({
      hostname: env.DATABASE_HOST,
      port: Number(env.DATABASE_PORT ?? 5432),
      database: env.DATABASE_NAME ?? "postgres",
      username: env.DATABASE_USER,
      password: env.DATABASE_PASSWORD,
      tls,
      max: 1,
      prepare: false,
    });
  }
  if (!env.DATABASE_URL) throw new Error("Set DATABASE_HOST/USER/PASSWORD or DATABASE_URL.");
  return new SQL({ url: env.DATABASE_URL, tls, max: 1, prepare: false });
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const emailIndex = args.indexOf("--email");
  const email = emailIndex >= 0 ? args[emailIndex + 1] : undefined;
  if (!email)
    throw new Error(
      "Usage: bootstrap-platform-operator.ts --email <address> [--confirm-production]",
    );
  if (process.env.APP_ENV === "production" && !args.includes("--confirm-production")) {
    throw new Error("APP_ENV=production: pass --confirm-production to write to this database.");
  }
  const frontendUrl = process.env.FRONTEND_URL ?? "http://localhost:5180";
  const sql = connect();
  try {
    const result = await bootstrapPlatformOperator(sql, { email, frontendUrl });
    console.log(
      [
        result.createdSchool
          ? `Created the platform school (${PLATFORM_SCHOOL_SLUG}).`
          : "Using the existing platform school.",
        `Invitation for ${email}, valid ${INVITATION_DAYS} days. Open it and sign in with that account:`,
        result.link,
      ].join("\n"),
    );
  } finally {
    await sql.close();
  }
}

if (import.meta.main) {
  main().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : error);
    process.exit(1);
  });
}
