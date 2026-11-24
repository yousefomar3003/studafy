import { ApiError } from "@studafy/api-client";
import { ERROR_CODES } from "@studafy/constants";

import type { TFunction } from "i18next";

/**
 * The toast description for a failed request. A delete refused because other records still use the
 * row (`RESOURCE_IN_USE`) is explained in the user's language; anything else shows the API's own
 * reason, which is authored in English by the service that refused.
 */
export function apiErrorDescription(error: unknown, t: TFunction): string | undefined {
  if (!(error instanceof ApiError)) return undefined;
  if (error.code === ERROR_CODES.RESOURCE_IN_USE) return t("site.common.inUse");
  return error.detail ?? error.title;
}
