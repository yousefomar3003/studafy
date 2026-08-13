import { ERROR_CODES } from "@studafy/constants";

import { CodedHttpException } from "../../../coded-http-exception";
import { getLocalizedMessage } from "../../../middleware/locale";
import { AI_LLM_RETRY_AFTER_SECONDS } from "../config";

import { LlmProviderError } from "./provider";

import type { SupportedLocale } from "../../../middleware/locale";
import type { AppEnv } from "../../../middleware/requestId";
import type { Context } from "hono";

/**
 * Map a provider failure onto the LLM error surface shared by the generate, ask, and summarize
 * routes. Returns nothing: it throws the {@link CodedHttpException} (or rethrows non-provider
 * errors so a genuine bug still surfaces as 500, exactly as the retrieval route lets its database
 * errors bubble).
 *
 * A non-transient 4xx is a verdict from a healthy provider — content policy, unknown model,
 * malformed prompt. Retrying cannot fix it, so it is reported as a distinct code and is never
 * Retry-After'd. (429 is retried by the provider and falls through to unavailable.) Everything
 * else — timeout, network, 5xx, open circuit — is transient and carries Retry-After.
 */
export function throwLlmError(c: Context<AppEnv>, error: unknown): never {
  const locale = (c.get("locale") ?? "en") as SupportedLocale;

  if (error instanceof LlmProviderError) {
    if (error.kind === "http" && error.status < 500 && error.status !== 429) {
      throw new CodedHttpException(
        503,
        ERROR_CODES.AI_LLM_REQUEST_REJECTED,
        getLocalizedMessage(ERROR_CODES.AI_LLM_REQUEST_REJECTED, locale),
      );
    }

    c.header("Retry-After", String(AI_LLM_RETRY_AFTER_SECONDS));
    throw new CodedHttpException(
      503,
      ERROR_CODES.AI_LLM_UNAVAILABLE,
      getLocalizedMessage(ERROR_CODES.AI_LLM_UNAVAILABLE, locale),
    );
  }

  throw error;
}
