import { $ } from "bun";

/**
 * Gives every school in the local database a working ERPNext site (`bun run erpnext:site`), the
 * same way production does it -- infra/deploy/scripts/erpnext-new-site.sh's steps, run against
 * the local ERPNext from db/compose.yml (`bun run erpnext:up`) instead of ECS:
 *
 *   1. `bench new-site <slug>.<ERPNEXT_SITE_DOMAIN>` with erpnext + education, unless it exists.
 *   2. `python -m erpnext_seed.provision <site> setup`: ERPNext's setup wizard (the school's
 *      company) and the integration user with ERPNEXT_API_KEY.
 *   3. `... demo`: local-only sample tuition invoices and payments for the Finance dashboard.
 *   4. The school's app.erpnext_site_configs row, written as 'pending' -- the API activates it on
 *      the first finance request, exactly as it does in production.
 *
 * Idempotent: re-running skips what is already there. Local-only credentials throughout; refuses
 * any ERPNEXT_API_URL that is not on this machine.
 */
const apiUrl = process.env.ERPNEXT_API_URL ?? "http://127.0.0.1:8080";
const credential = process.env.ERPNEXT_API_KEY ?? "studafylocalkey01:studafy-local-erpnext-secret";
const domain = process.env.ERPNEXT_SITE_DOMAIN ?? "erpnext.localhost";

const { hostname } = new URL(apiUrl);
if (!["127.0.0.1", "localhost"].includes(hostname)) {
  throw new Error(`refusing to set up ERPNext sites against non-local ${apiUrl}`);
}

const compose = ["docker", "compose", "-f", "db/compose.yml", "--profile", "erpnext"];
const psql = [
  "docker",
  "exec",
  "studafy-test-postgres-1",
  "psql",
  "-U",
  "studafy_test",
  "-d",
  "postgres",
  "-tAc",
];

/** Run bench-side python from the sites directory, as erpnext-new-site.sh does on ECS. */
async function provision(site: string, ...args: string[]): Promise<void> {
  await $`${compose} exec -T -e STUDAFY_ERPNEXT_API_KEY=${credential} erpnext-backend bash -c ${'cd sites && exec ../env/bin/python -m erpnext_seed.provision "$@"'} provision ${site} ${args}`;
}

const schools = (
  await $`${psql} ${"SELECT slug || '|' || name FROM app.schools ORDER BY slug"}`.text()
)
  .trim()
  .split("\n")
  .filter(Boolean)
  .map((line) => {
    const [slug, name] = line.split("|") as [string, string];
    return { slug, name };
  });

const existing = new Set(
  (await $`${compose} exec -T erpnext-backend bash -c ${"ls sites"}`.text()).split(/\s+/),
);

for (const school of schools) {
  if (!/^[a-z0-9-]+$/.test(school.slug)) {
    console.log(`skipping school with unexpected slug "${school.slug}"`);
    continue;
  }
  const site = `${school.slug}.${domain}`;
  const abbr = school.slug
    .replace(/[^a-z0-9]/gi, "")
    .slice(0, 4)
    .toUpperCase();
  console.log(`\n== ${school.name} -> ${site}`);

  if (!existing.has(site)) {
    console.log("creating the site (a few minutes)…");
    await $`${compose} exec -T erpnext-backend bench new-site ${site} --mariadb-user-host-login-scope=% --db-root-password studafy-local-erp --admin-password studafy-local-admin --install-app erpnext --install-app education`.quiet();
  }
  await provision(site, "setup", "--company", school.name, "--abbr", abbr);
  await provision(site, "demo");

  await $`${psql} ${`INSERT INTO app.erpnext_site_configs (school_id, site_name, company_name, company_abbr, status)
    SELECT id, '${site}', name, '${abbr}', 'pending' FROM app.schools WHERE slug = '${school.slug}'
    ON CONFLICT (school_id) DO UPDATE SET site_name = EXCLUDED.site_name
    WHERE app.erpnext_site_configs.status <> 'completed'`}`.quiet();
}

console.log(
  `\nERPNext ready for ${schools.length} school(s). Admin login: http://127.0.0.1:8080 (Host header`,
);
console.log("picks the site; use the API, or add the site name to your hosts file to browse it).");
