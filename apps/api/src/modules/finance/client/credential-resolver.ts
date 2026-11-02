/**
 * How a request finds the right ERPNext site (ST-119).
 *
 * The ticket asks for per-tenant API key/secret pairs from Vault or Secrets Manager, keyed by
 * school. That is not how the deployed plane works, and pretending otherwise would produce code
 * that cannot run:
 *
 *   - There is no Vault in this system, and Secrets Manager is provisioned per *service*
 *     (`infra/terraform/modules/secrets`), not per tenant.
 *   - `app.erpnext_site_configs` — the table provisioning already fills in — has no credential
 *     column, because ERPNext never issues a per-tenant key here.
 *   - Tenant separation is achieved at the edge instead: the ERPNext nginx frontend is configured
 *     with `FRAPPE_SITE_NAME_HEADER = "$host"`, so **the Host header selects the Frappe site**.
 *     One credential, many sites, routing by name.
 *
 * So this module resolves the *site*, not the secret. It exists as an interface anyway because the
 * shape of the question — "given a school, how do I authenticate to its ERPNext?" — is the part
 * that would change if per-tenant credentials ever arrive. When they do, a second implementation
 * satisfies this interface and no call site moves.
 */

import { ERROR_CODES } from "@studafy/constants";

import { CodedHttpException } from "../../../coded-http-exception";

import type { TransactionSql } from "postgres";

export interface ErpNextTenantCredentials {
  /** Base URL of the ERPNext plane. */
  baseUrl: string;
  /** API key presented as `Authorization: token <key>`. */
  apiKey: string;
  /** Value for the Host header, which is what selects the tenant's Frappe site. */
  siteHost: string;
}

export interface ErpNextCredentialResolver {
  resolve(tx: TransactionSql, schoolId: string): Promise<ErpNextTenantCredentials>;
}

export interface EnvCredentialResolverOptions {
  baseUrl: string | undefined;
  apiKey: string | undefined;
  /**
   * Asks a site that is not marked ready yet whether it is: returns its company name once the site
   * exists, the integration key works on it and its setup wizard has created the company, else
   * null. Defaults to a real `GET /api/resource/Company` against the site (Host header); injected
   * in tests.
   */
  probeSite?: (siteHost: string) => Promise<string | null>;
}

/** How long a site probe may take before it counts as "not ready" -- it runs inside a request. */
const SITE_PROBE_TIMEOUT_MS = 5_000;

function companyProbe(
  baseUrl: string,
  apiKey: string,
): (siteHost: string) => Promise<string | null> {
  return async (siteHost) => {
    try {
      const response = await fetch(
        `${baseUrl.replace(/\/$/, "")}/api/resource/Company?fields=${encodeURIComponent('["name"]')}&limit_page_length=1`,
        {
          headers: { Authorization: `token ${apiKey}`, Host: siteHost, Accept: "application/json" },
          signal: AbortSignal.timeout(SITE_PROBE_TIMEOUT_MS),
        },
      );
      if (!response.ok) return null;
      const body = (await response.json()) as { data?: { name?: string }[] };
      return body.data?.[0]?.name ?? null;
    } catch {
      return null;
    }
  };
}

/**
 * The implementation that matches the deployed infrastructure: global credential from env, site
 * name from the school's provisioning row.
 */
export class EnvCredentialResolver implements ErpNextCredentialResolver {
  private readonly baseUrl: string | undefined;
  private readonly apiKey: string | undefined;
  private readonly probeSite: ((siteHost: string) => Promise<string | null>) | undefined;

  constructor(options: EnvCredentialResolverOptions) {
    this.baseUrl = options.baseUrl;
    this.apiKey = options.apiKey;
    this.probeSite =
      options.probeSite ??
      (options.baseUrl && options.apiKey
        ? companyProbe(options.baseUrl, options.apiKey)
        : undefined);
  }

  async resolve(tx: TransactionSql, schoolId: string): Promise<ErpNextTenantCredentials> {
    // env.ts already enforces that ERPNEXT_API_URL and ERPNEXT_API_KEY are both present or both
    // absent, so one check covers the pair. 503 rather than 500: the integration being switched
    // off is a deployment state, not a bug, and the precedent is STORAGE_NOT_CONFIGURED.
    if (!this.baseUrl || !this.apiKey) {
      throw new CodedHttpException(
        503,
        ERROR_CODES.ERPNEXT_NOT_CONFIGURED,
        "ERPNext integration is not configured",
      );
    }

    const [row] = await tx<{ site_name: string; status: string }[]>`
      SELECT site_name, status::text AS status
      FROM app.erpnext_site_configs
      WHERE school_id = ${schoolId}::uuid
    `;

    // A school with no site row has never been provisioned: nothing to talk to, and that must stay
    // distinguishable from "ERPNext is down", which is why this is not a circuit-breaker concern.
    if (!row) {
      throw new CodedHttpException(
        503,
        ERROR_CODES.ERPNEXT_NOT_CONFIGURED,
        "This school's ERPNext site is not provisioned yet",
      );
    }

    // A row that is not 'completed' names a site that an operator creates out of band
    // (infra/deploy/scripts/erpnext-new-site.sh -- a Frappe site can only be made by bench, never
    // over the REST API). Ask the site itself: once it answers with its company, record that and
    // carry on, so a school's finance switches on by itself the moment its site is ready.
    if (row.status !== "completed") {
      const company = this.probeSite ? await this.probeSite(row.site_name) : null;
      if (!company) {
        throw new CodedHttpException(
          503,
          ERROR_CODES.ERPNEXT_NOT_CONFIGURED,
          "This school's ERPNext site is not provisioned yet",
        );
      }
      await tx`
        UPDATE app.erpnext_site_configs
        SET status = 'completed'::app.provisioning_status,
            erpnext_site_id = site_name,
            erpnext_company_id = ${company},
            last_error = NULL,
            updated_at = CURRENT_TIMESTAMP
        WHERE school_id = ${schoolId}::uuid
      `;
    }

    return { baseUrl: this.baseUrl, apiKey: this.apiKey, siteHost: row.site_name };
  }
}
