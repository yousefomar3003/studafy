// Global search latency at school scale (migration 000170): one school with 5,000 students and a
// proportionate amount of everything else, GET /api/search through the real app (JWT verification,
// tenant transaction as studafy_app, RLS, audit write), p95 under 150 ms.
//
// Measured as two callers, because RLS makes them different workloads:
//   - ORG_ADMIN: the role_scope_visibility checks are hoisted InitPlans (000170 point 5), so RLS is
//     O(1) per statement and every section matches across the whole school;
//   - a class teacher: the per-row predicate still runs, but only for app.search_scoped_ids'
//     candidates (000170 point 6), not for all 5,000 students.
// There are no search indexes (000170 point 4: under FORCE RLS a GIN or trigram index is never
// used, since `@@` and `<%` are not leakproof), so every number here is a school_id-bounded scan
// with the match as a filter -- the budget has to hold without them.
// The query mix is what a search box sees: full and partial names in Latin and Arabic, admission and
// invoice numbers, typos that need the trigram fallback, and a word that matches nothing at all (the
// worst case: every name section runs its fallback too).
//
// Gated like the other benchmarks in this directory: seeding 5,000 students and timing a few hundred
// requests is too slow for every `bun test`.
//
//   GLOBAL_SEARCH_BENCHMARK=1 TEST_DATABASE_URL=postgres://... \
//     bun test tests/benchmark/global-search-benchmark.test.ts --timeout 300000

// eslint-disable-next-line import-x/no-unresolved -- "bun:test" is a virtual Bun built-in with no resolvable file path
import { afterAll, beforeAll, expect, test } from "bun:test";

import {
  createFullTenant,
  createTestApp,
  createTestDatabase,
  integrationEnabled,
  migrateDatabase,
  mintTestToken,
} from "../harness";

import type { TenantFixture, TestApp, TestDatabase } from "../harness";

const enabled = integrationEnabled && process.env.GLOBAL_SEARCH_BENCHMARK === "1";
const benchmarkTest = test.skipIf(!enabled);

const STUDENTS = 5_000;
const P95_BUDGET_MS = 150;
const ROUNDS = 6;

const QUERIES = [
  "omar",
  "haddad",
  "omar kh",
  "fatima",
  "أحمد",
  "سارة",
  "adm-12",
  "inv-00",
  "grade 7",
  "math",
  "mohamad",
  "jonh",
  "room 1",
  "family",
  "zzqqxx",
];

const FIRST = [
  "Omar",
  "Ahmed",
  "Sara",
  "Lina",
  "John",
  "Maya",
  "Fatima",
  "Yusuf",
  "Noor",
  "Hassan",
  "Layla",
  "Karim",
  "Mariam",
  "Ali",
  "Zainab",
  "Mohammed",
  "Huda",
  "Tariq",
  "Rana",
  "Samir",
  "Emma",
  "Liam",
  "Olivia",
  "Noah",
  "Ava",
  "Elijah",
  "Sophia",
  "James",
  "Amelia",
  "Lucas",
  "أحمد",
  "سارة",
  "محمد",
  "فاطمة",
  "علي",
  "مريم",
  "يوسف",
  "نور",
  "ليلى",
  "خالد",
];
const LAST = [
  "Haddad",
  "Khalil",
  "Nasser",
  "Saleh",
  "Hamdan",
  "Aziz",
  "Rahman",
  "Farouk",
  "Mansour",
  "Qasim",
  "Smith",
  "Johnson",
  "Brown",
  "Taylor",
  "Wilson",
  "Clark",
  "Lewis",
  "Walker",
  "Hall",
  "Young",
  "Khoury",
  "Darwish",
  "Habib",
  "Jaber",
  "Kassem",
  "Mahmoud",
  "Najjar",
  "Odeh",
  "Sabbagh",
  "Tannous",
  "الحسن",
  "العلي",
  "النجار",
  "الخطيب",
  "الشامي",
  "المصري",
  "الحلبي",
  "البغدادي",
  "السوري",
  "الكردي",
];

let database: TestDatabase | undefined;
let harness: (TestApp & { ready: Promise<void> }) | undefined;
let tenant: TenantFixture;

beforeAll(async () => {
  if (!enabled) return;
  database = await createTestDatabase();
  await migrateDatabase(database.url);
  harness = createTestApp({ database: database.sql });
  await harness.ready;
  tenant = await createFullTenant(database.sql);
  const schoolId = tenant.schoolId;

  // Bulk seed as the superuser test role (RLS does not apply), one set-based statement per table.
  await database.sql.begin(async (tx) => {
    await tx`SELECT set_config('app.school_id', ${schoolId}, true)`;
    await tx`
      INSERT INTO app.users (school_id, email, normalized_email, display_name, status)
      SELECT ${schoolId}, 's' || g || '@bench.local', 's' || g || '@bench.local',
             (${FIRST}::text[])[1 + g % ${FIRST.length}] || ' ' || (${LAST}::text[])[1 + (g / 7) % ${LAST.length}],
             'active'
      FROM generate_series(1, ${STUDENTS}) g
    `;
    await tx`
      INSERT INTO app.students (school_id, user_id, admission_number, first_name, last_name, status)
      SELECT u.school_id, u.id, 'ADM-' || substr(u.email, 2, strpos(u.email, '@') - 2),
             split_part(u.display_name, ' ', 1), split_part(u.display_name, ' ', 2), 'enrolled'
      FROM app.users u WHERE u.school_id = ${schoolId} AND u.email LIKE 's%@bench.local'
    `;
    // Parents (one per three students), families, and their links.
    await tx`
      INSERT INTO app.users (school_id, email, normalized_email, display_name, status)
      SELECT ${schoolId}, 'p' || g || '@bench.local', 'p' || g || '@bench.local',
             (${FIRST}::text[])[1 + (g * 3) % ${FIRST.length}] || ' ' || (${LAST}::text[])[1 + g % ${LAST.length}],
             'active'
      FROM generate_series(1, ${Math.floor(STUDENTS / 3)}) g
    `;
    await tx`
      INSERT INTO app.families (school_id, display_name, primary_parent_user_id)
      SELECT ${schoolId}, split_part(u.display_name, ' ', 2) || ' Family ' || u.email, u.id
      FROM app.users u WHERE u.school_id = ${schoolId} AND u.email LIKE 'p%@bench.local'
    `;
    // Academic structure: 15 subjects, 30 courses, 60 teachers, 200 classes, 12 grades x 4 sections.
    await tx`
      INSERT INTO app.subjects (school_id, code, name, status)
      SELECT ${schoolId}, 'SB-' || g, (ARRAY['Mathematics','Science','English','Arabic','History',
        'Geography','Art','Music','Physics','Chemistry','Biology','Computing','French','Sport','Religion'])[g], 'active'
      FROM generate_series(1, 15) g
    `;
    await tx`
      INSERT INTO app.courses (school_id, subject_id, code, name, credit_hours, status)
      SELECT ${schoolId}, s.id, s.code || '-' || n, s.name || ' ' || n, 1, 'active'
      FROM app.subjects s, generate_series(1, 2) n WHERE s.school_id = ${schoolId}
    `;
    await tx`
      INSERT INTO app.users (school_id, email, normalized_email, display_name, status)
      SELECT ${schoolId}, 't' || g || '@bench.local', 't' || g || '@bench.local',
             'Teacher ' || (${LAST}::text[])[1 + g % ${LAST.length}], 'active'
      FROM generate_series(1, 60) g
    `;
    await tx`
      INSERT INTO app.teachers (school_id, user_id, employee_number, employment_status)
      SELECT ${schoolId}, u.id, 'EMP-' || u.email, 'active'
      FROM app.users u WHERE u.school_id = ${schoolId} AND u.email LIKE 't%@bench.local'
    `;
    await tx`
      INSERT INTO app.grade_levels (school_id, name, sort_order)
      SELECT ${schoolId}, 'Grade ' || g, g FROM generate_series(1, 12) g
    `;
    await tx`
      INSERT INTO app.sections (school_id, academic_year_id, grade_level_id, name)
      SELECT ${schoolId}, ${tenant.academicYear.id}, gl.id, chr(64 + n)
      FROM app.grade_levels gl, generate_series(1, 4) n WHERE gl.school_id = ${schoolId}
    `;
    await tx`
      INSERT INTO app.rooms (school_id, code, name, room_type, capacity, building)
      SELECT ${schoolId}, 'R-' || g, 'Room ' || g, 'physical', 30, 'Block ' || (g % 4)
      FROM generate_series(1, 60) g
    `;
    await tx`
      WITH c AS (SELECT id, row_number() OVER () AS n FROM app.courses WHERE school_id = ${schoolId}),
           t AS (SELECT id, row_number() OVER () AS n FROM app.teachers WHERE school_id = ${schoolId})
      INSERT INTO app.classes (school_id, course_id, academic_year_id, term_id, lead_teacher_id, code, capacity, status)
      SELECT ${schoolId}, c.id, ${tenant.academicYear.id}, ${tenant.term.id}, t.id, 'CL-' || g, 32, 'active'
      FROM generate_series(1, 200) g
      JOIN c ON c.n = 1 + g % 30
      JOIN t ON t.n = 1 + g % 60
    `;
    // Every bench student in one class; the fixture's own teacher's class gets 30 of them.
    await tx`
      WITH s AS (SELECT id, row_number() OVER (ORDER BY id) AS n FROM app.students
                 WHERE school_id = ${schoolId} AND admission_number LIKE 'ADM-%' AND first_name <> 'Primary'),
           c AS (SELECT id, row_number() OVER (ORDER BY code) AS n FROM app.classes
                 WHERE school_id = ${schoolId} AND code LIKE 'CL-%')
      INSERT INTO app.enrollments (school_id, class_id, student_id)
      SELECT ${schoolId}, CASE WHEN s.n <= 30 THEN ${tenant.cls.id}::uuid ELSE c.id END, s.id
      FROM s JOIN c ON c.n = 1 + s.n % 200
    `;
    const [currency] = await tx<{ id: string }[]>`
      SELECT default_currency_id AS id FROM app.schools WHERE id = ${schoolId}
    `;
    await tx`
      INSERT INTO app.invoice_cache (school_id, student_id, currency_id, erpnext_docname, erpnext_status,
        total_amount_minor, outstanding_amount_minor, issued_date, last_synced_at)
      SELECT ${schoolId}, s.id, ${currency!.id}, 'INV-' || lpad(row_number() OVER ()::text, 5, '0'),
             'submitted', 10000, 10000, '2026-01-01', now()
      FROM app.students s WHERE s.school_id = ${schoolId}
    `;
    await tx`
      INSERT INTO app.discipline_incidents (school_id, student_id, reporter_user_id, incident_type, severity, title, incident_at)
      SELECT ${schoolId}, s.id, ${tenant.users.ORG_ADMIN.id}, 'behavioral', 'minor',
             'Incident in room ' || (row_number() OVER ()), now()
      FROM (SELECT id FROM app.students WHERE school_id = ${schoolId} LIMIT 300) s
    `;
    await tx`
      INSERT INTO app.notifications (school_id, user_id, notification_type, title, body, metadata)
      SELECT ${schoolId}, ${tenant.users.ORG_ADMIN.id}, 'ADMIN_ANNOUNCEMENT', 'Weekly report ' || g, 'b', '{}'::jsonb
      FROM generate_series(1, 1000) g
    `;
    await tx`
      INSERT INTO app.announcements (school_id, created_by, title, body, mandatory, audience_type, status, scheduled_at, published_at)
      SELECT ${schoolId}, ${tenant.users.ORG_ADMIN.id}, 'Announcement ' || g, 'b', false, 'school', 'published', now(), now()
      FROM generate_series(1, 100) g
    `;
    await tx`
      INSERT INTO app.school_events (school_id, created_by, title, kind, starts_on, ends_on)
      SELECT ${schoolId}, ${tenant.users.ORG_ADMIN.id}, 'Event ' || g, 'event', '2026-05-01', '2026-05-01'
      FROM generate_series(1, 100) g
    `;
    await tx`
      INSERT INTO app.expense_cache (school_id, document_type, category, vendor, currency_id, amount_minor,
        erpnext_docname, erpnext_status, erpnext_payload, expense_date, last_synced_at)
      SELECT ${schoolId}, 'purchase_invoice', 'Supplies', 'Vendor ' || g, ${currency!.id}, 1000,
             'PINV-' || g, 'Paid', '{}'::jsonb, '2026-03-01', now()
      FROM generate_series(1, 300) g
    `;
  });
  await database.sql`ANALYZE`;
}, 600_000);

afterAll(async () => {
  harness?.keyStore.destroy();
  await database?.cleanup();
});

function percentile(samples: number[], p: number): number {
  const sorted = [...samples].sort((x, y) => x - y);
  return sorted[Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1)]!;
}

async function measure(userId: string, roles: ("ORG_ADMIN" | "INSTRUCTOR")[]): Promise<number[]> {
  const token = await mintTestToken(harness!.keyStore, {
    schoolId: tenant.schoolId,
    userId,
    roles,
    channel: "web",
  });
  const request = async (query: string) => {
    const startedAt = performance.now();
    const res = await harness!.app.request(`/api/search?q=${encodeURIComponent(query)}`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    expect(res.status).toBe(200);
    await res.arrayBuffer();
    return performance.now() - startedAt;
  };
  for (const query of QUERIES) await request(query); // warm-up
  const samples: number[] = [];
  const byQuery = new Map<string, number[]>();
  for (let round = 0; round < ROUNDS; round += 1) {
    for (const query of QUERIES) {
      const elapsed = await request(query);
      samples.push(elapsed);
      byQuery.set(query, [...(byQuery.get(query) ?? []), elapsed]);
    }
  }
  console.info(
    `  per-query p50 (${roles.join(",")}): ` +
      [...byQuery]
        .map(([query, times]) => `${query}=${percentile(times, 50).toFixed(0)}`)
        .join(" "),
  );
  return samples;
}

benchmarkTest(
  `ORG_ADMIN: p95 of GET /api/search over ${STUDENTS} students is under ${P95_BUDGET_MS} ms`,
  async () => {
    const samples = await measure(tenant.users.ORG_ADMIN.id, ["ORG_ADMIN"]);
    const p50 = percentile(samples, 50);
    const p95 = percentile(samples, 95);
    console.info(
      `global search ORG_ADMIN: n=${samples.length} p50=${p50.toFixed(1)}ms p95=${p95.toFixed(1)}ms`,
    );
    expect(p95).toBeLessThan(P95_BUDGET_MS);
  },
  300_000,
);

benchmarkTest(
  `INSTRUCTOR: p95 of GET /api/search over ${STUDENTS} students is under ${P95_BUDGET_MS} ms`,
  async () => {
    const samples = await measure(tenant.teachers[0]!.userId, ["INSTRUCTOR"]);
    const p50 = percentile(samples, 50);
    const p95 = percentile(samples, 95);
    console.info(
      `global search INSTRUCTOR: n=${samples.length} p50=${p50.toFixed(1)}ms p95=${p95.toFixed(1)}ms`,
    );
    expect(p95).toBeLessThan(P95_BUDGET_MS);
  },
  300_000,
);
