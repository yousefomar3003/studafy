import { copyFile, mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { expect, test } from "bun:test";

import { runMigrationCommand } from "../src/runner";

import { integrationEnabled, runnerEnv, testDatabase } from "./helpers";

import type { TransactionSql } from "postgres";

const integrationTest = test.skipIf(!integrationEnabled);
const repositoryMigrations = resolve(import.meta.dir, "../../../db/migrations");
/** 000140 and every migration after it, which build on its tables. */
const MEMBER_CODES_MIGRATION = "000140_add_member_codes.sql";

type Database = Awaited<ReturnType<typeof testDatabase>>;
type Role = "studafy_admin" | "studafy_app";

async function asRole<T>(
  database: Database,
  role: Role,
  run: (tx: TransactionSql) => Promise<T>,
): Promise<T> {
  let result: T | undefined;
  await database.sql.begin(async (tx) => {
    await tx.unsafe(`SET LOCAL ROLE ${role}`);
    result = await run(tx);
  });
  return result as T;
}

/** Copies the repository migrations, optionally stopping before 000140, into a fresh directory. */
async function migrationsDirectory(includeMemberCodes: boolean, directory?: string) {
  const target = directory ?? (await mkdtemp(join(tmpdir(), "studafy-member-codes-")));
  // Reads the repository's own migrations directory and copies its files into a fresh temp dir.
  // eslint-disable-next-line security/detect-non-literal-fs-filename
  const files = (await readdir(repositoryMigrations)).filter(
    (name) => name.endsWith(".sql") && (includeMemberCodes || name < MEMBER_CODES_MIGRATION),
  );
  await Promise.all(
    files.map((name) => copyFile(join(repositoryMigrations, name), join(target, name))),
  );
  return target;
}

async function migrate(database: Database, directory: string) {
  await runMigrationCommand("migrate", {
    env: runnerEnv(database.url, directory),
    log: () => undefined,
  });
}

async function createSchool(database: Database, slug: string): Promise<string> {
  const [refs] = await database.sql<{ country: string; currency: string }[]>`
    SELECT
      (SELECT id FROM app.countries WHERE alpha2_code = 'US') AS country,
      (SELECT id FROM app.currencies WHERE code = 'USD') AS currency
  `;
  return asRole(database, "studafy_admin", async (tx) => {
    const email = `${slug}@admin.local`;
    const [row] = await tx<{ id: string }[]>`
      INSERT INTO app.schools (slug, name, email, normalized_email, country_id, default_currency_id)
      VALUES (${slug}, ${slug}, ${email}, ${email}, ${refs!.country}, ${refs!.currency})
      RETURNING id
    `;
    return row!.id;
  });
}

async function createMember(
  database: Database,
  school: string,
  localPart: string,
  roles: string[],
): Promise<string> {
  return asRole(database, "studafy_app", async (tx) => {
    await tx`SELECT set_config('app.school_id', ${school}, true)`;
    const email = `${localPart}@example.test`;
    const [row] = await tx<{ id: string }[]>`
      INSERT INTO app.users (school_id, email, normalized_email)
      VALUES (${school}, ${email}, ${email}) RETURNING id
    `;
    for (const role of roles) {
      await tx`
        INSERT INTO app.user_roles (school_id, user_id, role)
        VALUES (${school}, ${row!.id}, ${role}::app.user_role)
      `;
    }
    return row!.id;
  });
}

async function codesOf(database: Database, school: string, userId: string): Promise<string[]> {
  return asRole(database, "studafy_app", async (tx) => {
    await tx`SELECT set_config('app.school_id', ${school}, true)`;
    const rows = await tx<{ code: string }[]>`
      SELECT code FROM app.member_codes WHERE user_id = ${userId} ORDER BY code
    `;
    return rows.map((row) => row.code);
  });
}

integrationTest(
  "numbers schools and issues STU/TCH/PAR codes prefixed by the school number",
  async () => {
    const database = await testDatabase();
    const directory = await migrationsDirectory(true);
    try {
      await migrate(database, directory);
      const first = await createSchool(database, "codes-first");
      const second = await createSchool(database, "codes-second");

      const numbers = await database.sql<{ id: string; school_number: number }[]>`
      SELECT id, school_number FROM app.schools WHERE id IN (${first}, ${second})
    `;
      const numberOf = new Map(numbers.map((row) => [row.id, row.school_number]));
      expect(numberOf.get(second)).toBe(numberOf.get(first)! + 1);
      const a = numberOf.get(first)!;
      const b = numberOf.get(second)!;

      const student1 = await createMember(database, first, "s1", ["STUDENT"]);
      const student2 = await createMember(database, first, "s2", ["STUDENT"]);
      const teacherParent = await createMember(database, first, "tp", ["INSTRUCTOR", "PARENT"]);
      const admin = await createMember(database, first, "admin", ["ORG_ADMIN"]);
      const otherStudent = await createMember(database, second, "s3", ["STUDENT"]);

      expect(await codesOf(database, first, student1)).toEqual([`STU-${a}00001`]);
      expect(await codesOf(database, first, student2)).toEqual([`STU-${a}00002`]);
      expect(await codesOf(database, first, teacherParent)).toEqual([
        `PAR-${a}00001`,
        `TCH-${a}00001`,
      ]);
      expect(await codesOf(database, first, admin)).toEqual([]);
      // Each school counts from one under its own number.
      expect(await codesOf(database, second, otherStudent)).toEqual([`STU-${b}00001`]);

      // Removing and re-granting a role keeps the code it was first issued.
      await asRole(database, "studafy_app", async (tx) => {
        await tx`SELECT set_config('app.school_id', ${first}, true)`;
        await tx`DELETE FROM app.user_roles WHERE user_id = ${student1} AND role = 'STUDENT'`;
        await tx`INSERT INTO app.user_roles (school_id, user_id, role) VALUES (${first}, ${student1}, 'STUDENT')`;
      });
      expect(await codesOf(database, first, student1)).toEqual([`STU-${a}00001`]);

      // Codes are read-only to the runtime role and invisible across tenants.
      await expect(
        asRole(database, "studafy_app", async (tx) => {
          await tx`SELECT set_config('app.school_id', ${first}, true)`;
          await tx`
          INSERT INTO app.member_codes (school_id, user_id, kind, sequence, code)
          VALUES (${first}, ${admin}, 'STU', 99, ${`STU-${a}00099`})
        `;
        }),
      ).rejects.toThrow();
      expect(await codesOf(database, second, student1)).toEqual([]);
    } finally {
      await rm(directory, { recursive: true, force: true });
      await database.cleanup();
    }
  },
);

integrationTest("backfills school numbers and codes for existing schools and members", async () => {
  const database = await testDatabase();
  const directory = await migrationsDirectory(false);
  try {
    await migrate(database, directory);
    const older = await createSchool(database, "backfill-older");
    const newer = await createSchool(database, "backfill-newer");
    const student = await createMember(database, older, "bs1", ["STUDENT"]);
    const parent = await createMember(database, newer, "bp1", ["PARENT"]);

    await migrationsDirectory(true, directory);
    await migrate(database, directory);

    const numbers = await database.sql<{ id: string; school_number: number }[]>`
      SELECT id, school_number FROM app.schools ORDER BY school_number
    `;
    expect(numbers.map((row) => row.school_number)).toEqual(numbers.map((_, index) => index + 1));
    const numberOf = new Map(numbers.map((row) => [row.id, row.school_number]));

    expect(await codesOf(database, older, student)).toEqual([`STU-${numberOf.get(older)}00001`]);
    expect(await codesOf(database, newer, parent)).toEqual([`PAR-${numberOf.get(newer)}00001`]);

    // New schools continue the sequence after the backfilled ones.
    const later = await createSchool(database, "backfill-later");
    const [row] = await database.sql<{ school_number: number }[]>`
      SELECT school_number FROM app.schools WHERE id = ${later}
    `;
    expect(row!.school_number).toBe(numbers.length + 1);
  } finally {
    await rm(directory, { recursive: true, force: true });
    await database.cleanup();
  }
});

async function resolveCode(database: Database, code: string) {
  return asRole(database, "studafy_app", async (tx) => {
    const [row] = await tx<{ found: boolean; user_id: string; school_id: string }[]>`
      SELECT found, user_id, school_id FROM app.resolve_member_code_for_login(${code})
    `;
    const [scope] = await tx<{ school: string }[]>`
      SELECT current_setting('app.school_id') AS school
    `;
    return { ...row!, armed: scope!.school };
  });
}

integrationTest(
  "issues ATT codes and resolves any member code to its account for sign-in",
  async () => {
    const database = await testDatabase();
    const directory = await migrationsDirectory(true);
    try {
      await migrate(database, directory);
      const school = await createSchool(database, "login-codes");
      const [row] = await database.sql<{ school_number: number }[]>`
        SELECT school_number FROM app.schools WHERE id = ${school}
      `;
      const number = row!.school_number;
      const officer = await createMember(database, school, "att1", ["ATTENDANCE_OFFICER"]);
      expect(await codesOf(database, school, officer)).toEqual([`ATT-${number}00001`]);

      const hit = await resolveCode(database, ` att-${number}00001 `);
      expect(hit).toEqual({
        found: true,
        user_id: officer,
        school_id: school,
        armed: "00000000-0000-0000-0000-000000000000",
      });
      for (const miss of [`ATT-${number}00002`, "STU-999999999", "nonsense", ""]) {
        expect((await resolveCode(database, miss)).found).toBe(false);
      }
    } finally {
      await rm(directory, { recursive: true, force: true });
      await database.cleanup();
    }
  },
);

integrationTest(
  "users may have no email, and credentials are tenant-isolated argon2id hashes",
  async () => {
    const database = await testDatabase();
    const directory = await migrationsDirectory(true);
    try {
      await migrate(database, directory);
      const school = await createSchool(database, "no-email");
      const other = await createSchool(database, "no-email-other");
      const userId = await asRole(database, "studafy_app", async (tx) => {
        await tx`SELECT set_config('app.school_id', ${school}, true)`;
        const [row] = await tx<{ id: string }[]>`
        INSERT INTO app.users (school_id, display_name) VALUES (${school}, 'No Email') RETURNING id
      `;
        await tx`
        INSERT INTO app.member_credentials (school_id, user_id, password_hash, password_changed_at)
        VALUES (${school}, ${row!.id}, '$argon2id$v=19$m=65536,t=2,p=1$abc$def', CURRENT_TIMESTAMP)
      `;
        return row!.id;
      });

      // Email and its normalized form travel together.
      await expect(
        asRole(database, "studafy_app", async (tx) => {
          await tx`SELECT set_config('app.school_id', ${school}, true)`;
          await tx`INSERT INTO app.users (school_id, email) VALUES (${school}, 'a@b.test')`;
        }),
      ).rejects.toThrow();
      // Only argon2id hashes are accepted.
      await expect(
        asRole(database, "studafy_app", async (tx) => {
          await tx`SELECT set_config('app.school_id', ${school}, true)`;
          await tx`UPDATE app.member_credentials SET password_hash = 'plain' WHERE user_id = ${userId}`;
        }),
      ).rejects.toThrow();

      const visibleFromOther = await asRole(database, "studafy_app", async (tx) => {
        await tx`SELECT set_config('app.school_id', ${other}, true)`;
        return tx`SELECT 1 FROM app.member_credentials WHERE user_id = ${userId}`;
      });
      expect(visibleFromOther.length).toBe(0);
    } finally {
      await rm(directory, { recursive: true, force: true });
      await database.cleanup();
    }
  },
);
