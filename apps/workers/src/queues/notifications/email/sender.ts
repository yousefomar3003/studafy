/**
 * Resend send adapter for the email channel.
 *
 * The dispatcher depends on a narrow `EmailSender` interface so tests inject a stub and the
 * process never touches the network. `createEmailSender` builds the real adapter, or a loud dry-run
 * substitute when no RESEND_API_KEY is configured (local development and CI).
 *
 * Resend is called over its REST API with plain fetch rather than its SDK: one endpoint, one
 * request shape, and no dependency to keep patched.
 */

import type { RenderedEmail } from "./templates";

const RESEND_SEND_URL = "https://api.resend.com/emails";
const SEND_TIMEOUT_MS = 15_000;

export interface OutboundEmail extends RenderedEmail {
  to: string;
  /** Where a reply goes instead of the From address, e.g. the prospect behind a sales inquiry. */
  replyTo?: string;
  /**
   * Stable per logical email. Resend answers a repeated key (within 24 hours) with the original
   * send instead of sending again, so a retry after a timeout — where Resend may already have
   * accepted the message — cannot mail the recipient twice.
   */
  idempotencyKey?: string;
}

export interface SentEmail {
  messageId: string;
  dryRun: boolean;
}

export interface EmailSender {
  send(email: OutboundEmail): Promise<SentEmail>;
}

export interface SenderLogger {
  warn(fields: Record<string, unknown>, msg: string): void;
}

/** A non-2xx answer from Resend, carrying its status and error name for the retry decision. */
export class ResendSendError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(`Resend send failed (HTTP ${status} ${code}): ${message}`);
    this.name = "ResendSendError";
  }
}

/** Network-level failures: the request never got a definitive answer, so retrying is safe. */
const RETRYABLE_NETWORK_CODES = new Set([
  "ECONNRESET",
  "ECONNREFUSED",
  "EPIPE",
  "ETIMEDOUT",
  "EAI_AGAIN",
  "ENOTFOUND",
  "ConnectionRefused",
  "ConnectionClosed",
  "FailedToOpenSocket",
]);

/** Errors that should be retried rather than recorded as terminal failures. */
export function isRetryableSendError(err: unknown): boolean {
  if (err instanceof ResendSendError) {
    // 429 (rate limit) and 5xx are transient. 409 concurrent_idempotent_requests means the same
    // key is still in flight; retrying later returns that send's result.
    return (
      err.status === 429 ||
      err.status >= 500 ||
      (err.status === 409 && err.code === "concurrent_idempotent_requests")
    );
  }
  if (err instanceof Error) {
    if (err.name === "TimeoutError" || err.message.includes("socket closed")) return true;
    const code = (err as { code?: unknown }).code;
    if (typeof code === "string" && RETRYABLE_NETWORK_CODES.has(code)) return true;
    if (RETRYABLE_NETWORK_CODES.has(err.name)) return true;
  }
  return false;
}

/**
 * Build the email sender. Without an API key the sender is a dry run: it resolves like a send but
 * nothing leaves the process, so the whole dispatcher pipeline (claim, dedup, delivery ledger)
 * works in development and CI without credentials.
 */
export function createEmailSender(
  env: {
    RESEND_API_KEY?: string;
    EMAIL_FROM_ADDRESS: string;
    EMAIL_FROM_NAME?: string;
  },
  logger: SenderLogger,
  fetchImpl: typeof fetch = fetch,
): EmailSender {
  const fromAddress = env.EMAIL_FROM_ADDRESS;
  // Display name and address, so inboxes show "Studafy" rather than a bare no-reply address. The
  // name is quoted: it must not be able to inject another address.
  const from = env.EMAIL_FROM_NAME
    ? `"${env.EMAIL_FROM_NAME.replaceAll('"', "")}" <${fromAddress}>`
    : fromAddress;

  const apiKey = env.RESEND_API_KEY;
  if (apiKey === undefined) {
    logger.warn({ fromAddress }, "RESEND_API_KEY unset — email dispatcher running in dry-run mode");
    return {
      async send(_email: OutboundEmail): Promise<SentEmail> {
        return { messageId: `dry-run-${crypto.randomUUID()}`, dryRun: true };
      },
    };
  }

  return {
    async send(email: OutboundEmail): Promise<SentEmail> {
      const response = await fetchImpl(RESEND_SEND_URL, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${apiKey}`,
          "Content-Type": "application/json",
          "User-Agent": "studafy-workers",
          ...(email.idempotencyKey ? { "Idempotency-Key": email.idempotencyKey } : {}),
        },
        body: JSON.stringify({
          from,
          to: [email.to],
          subject: email.subject,
          text: email.text,
          html: email.html,
          ...(email.replyTo ? { reply_to: [email.replyTo] } : {}),
        }),
        signal: AbortSignal.timeout(SEND_TIMEOUT_MS),
      });

      const body = (await response.json().catch(() => null)) as {
        id?: unknown;
        name?: unknown;
        message?: unknown;
      } | null;

      if (!response.ok) {
        throw new ResendSendError(
          response.status,
          typeof body?.name === "string" ? body.name : "unknown_error",
          typeof body?.message === "string" ? body.message : response.statusText,
        );
      }
      // Bounces and complaints come back through the Resend webhook to the API, which suppresses
      // the address (apps/api/src/email/webhook.ts), keyed by this id.
      if (typeof body?.id !== "string" || body.id.length === 0) {
        throw new Error("Resend send returned no message id");
      }
      return { messageId: body.id, dryRun: false };
    },
  };
}
