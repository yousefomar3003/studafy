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
}

/**
 * The implementation that matches the deployed infrastructure: global credential from env, site
 * name from the school's provisioning row.
 */
export class EnvCredentialResolver implements ErpNextCredentialResolver {
  private readonly baseUrl: string | undefined;
  private readonly apiKey: string | undefined;

  constructor(options: EnvCredentialResolverOptions) {
    this.baseUrl = options.baseUrl;
    this.apiKey = options.apiKey;
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

    // A school with no site row has never been provisioned; one that is still 'pending' has a row
    // but no site behind it. Both are the same answer to the caller — there is nothing to talk to
    // yet — and both must be distinguishable from "ERPNext is down", which is why this is not a
    // circuit-breaker concern.
    if (!row || row.status !== "completed") {
      throw new CodedHttpException(
        503,
        ERROR_CODES.ERPNEXT_NOT_CONFIGURED,
        "This school's ERPNext site is not provisioned yet",
      );
    }

    return { baseUrl: this.baseUrl, apiKey: this.apiKey, siteHost: row.site_name };
  }
}
