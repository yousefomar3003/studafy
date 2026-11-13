import { ERROR_CODES } from "@studafy/constants";

import type { TransactionSql } from "postgres";

export interface ErpNextTenantCredentials {
  baseUrl: string;
  apiKey: string;
  siteHost: string;
}

export class ErpNextNotConfiguredError extends Error {
  public readonly code: string;

  constructor(message: string) {
    super(message);
    this.name = "ErpNextNotConfiguredError";
    this.code = ERROR_CODES.ERPNEXT_NOT_CONFIGURED;
  }
}

export async function resolveSchoolCredentials(
  tx: TransactionSql,
  schoolId: string,
  envBaseUrl: string | undefined,
  envApiKey: string | undefined,
): Promise<ErpNextTenantCredentials> {
  if (!envBaseUrl || !envApiKey) {
    throw new ErpNextNotConfiguredError("ERPNext integration is not configured");
  }

  const [row] = await tx<{ site_name: string; status: string }[]>`
    SELECT site_name, status::text AS status
    FROM app.erpnext_site_configs
    WHERE school_id = ${schoolId}::uuid
  `;

  if (!row || row.status !== "completed") {
    throw new ErpNextNotConfiguredError("This school's ERPNext site is not provisioned yet");
  }

  return { baseUrl: envBaseUrl, apiKey: envApiKey, siteHost: row.site_name };
}
