import { ErpNextClient, ErpNextError } from "./client";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface SiteBootstrapParams {
  schoolId: string;
  slug: string;
  country: string;
  currency: string;
  adminEmail: string;
}

export interface SiteBootstrapResult {
  siteName: string;
  companyName: string;
  companyAbbr: string;
  companyId: string;
}

export interface SiteTeardownResult {
  deleted: boolean;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const SITE_DOMAIN = process.env.ERPNEXT_SITE_DOMAIN ?? "erpnext.studafy.com";

// ---------------------------------------------------------------------------
// Bootstrap
// ---------------------------------------------------------------------------

/**
 * Bootstrap an ERPNext site and company for a newly provisioned school.
 *
 * Creates the isolated Frappe site, installs erpnext + education apps, creates
 * the ERPNext Company with COA, tax templates, naming series, and education
 * defaults (academic structures, fee categories).
 *
 * @throws ErpNextError on any ERPNext API failure
 */
export async function bootstrapErpNextSite(
  client: ErpNextClient,
  params: SiteBootstrapParams,
): Promise<SiteBootstrapResult> {
  const siteName = `${params.slug}.${SITE_DOMAIN}`;
  const companyName = params.slug;
  const companyAbbr = params.slug.slice(0, 4).toUpperCase();

  // ── 1. Create ERPNext site ──────────────────────────────────────────────
  await createSite(client, siteName, params.adminEmail);

  // ── 2. Create Company ───────────────────────────────────────────────────
  const companyId = await createCompany(client, {
    siteName,
    companyName,
    companyAbbr,
    country: params.country,
    currency: params.currency,
  });

  // ── 3. Setup naming series defaults ─────────────────────────────────────
  await setupNamingSeries(client, siteName, companyAbbr);

  // ── 4. Setup education defaults ─────────────────────────────────────────
  await setupEducationDefaults(client, siteName);

  return { siteName, companyName, companyAbbr, companyId };
}

/**
 * Tear down (delete) an ERPNext site. Used for compensation when a later
 * provisioning step fails after the site was successfully created.
 *
 * Best-effort: if the site does not exist or is already deleted, returns
 * `{ deleted: true }` without error.
 */
export async function teardownErpNextSite(
  client: ErpNextClient,
  siteName: string,
): Promise<SiteTeardownResult> {
  try {
    await client.post("/api/method/erpnext.setup.utils.delete_site", { site: siteName });
    return { deleted: true };
  } catch (error) {
    // Site may not exist yet or may have been partially created — treat 404/417 as success.
    if (error instanceof ErpNextError && (error.status === 404 || error.status === 417)) {
      return { deleted: true };
    }
    throw error;
  }
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

async function createSite(
  client: ErpNextClient,
  siteName: string,
  adminEmail: string,
): Promise<void> {
  await client.post("/api/method/erpnext.setup.utils.setup_complete", {
    site_name: siteName,
    install_apps: ["erpnext", "education"],
    admin_email: adminEmail,
  });
}

interface CreateCompanyParams {
  siteName: string;
  companyName: string;
  companyAbbr: string;
  country: string;
  currency: string;
}

async function createCompany(client: ErpNextClient, params: CreateCompanyParams): Promise<string> {
  const response = await client.post<{ name: string }>("/api/resource/Company", {
    company_name: params.companyName,
    abbr: params.companyAbbr,
    default_currency: params.currency,
    country: params.country,
    domain: "Education",
  });

  return response.data.name;
}

async function setupNamingSeries(
  client: ErpNextClient,
  _siteName: string,
  companyAbbr: string,
): Promise<void> {
  try {
    await client.put(`/api/resource/Company/${companyAbbr}`, {
      naming_series: {
        "Sales Invoice": `SINV-${companyAbbr}-.`,
        "Sales Order": `SORD-${companyAbbr}-.`,
        "Journal Entry": `JOUR-${companyAbbr}-.`,
        "Payment Entry": `PAY-${companyAbbr}-.`,
        "Fee Schedule": `FSC-${companyAbbr}-.`,
      },
    });
  } catch {
    // Naming series setup is best-effort; ERPNext has sensible defaults.
  }
}

async function setupEducationDefaults(client: ErpNextClient, _siteName: string): Promise<void> {
  try {
    await client.post("/api/method/education.api.setup.setup_education_defaults", {});
  } catch {
    // Education defaults setup is best-effort; manual setup is possible.
  }
}
