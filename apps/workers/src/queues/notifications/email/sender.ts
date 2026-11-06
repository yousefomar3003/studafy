/**
 * Send adapters for the email channel: Amazon SES and Resend.
 *
 * The dispatcher depends on a narrow `EmailSender` interface so tests inject a stub and the
 * process never touches a provider. `createEmailSender` picks the adapter from EMAIL_PROVIDER;
 * `createSesSender` and `createResendSender` build the real adapters, or a loud dry-run substitute
 * when the provider's credential is not configured (local development and CI).
 */

import { SendEmailCommand, SESv2Client } from "@aws-sdk/client-sesv2";

import type { RenderedEmail } from "./templates";

export interface OutboundEmail extends RenderedEmail {
  to: string;
  /** Where a reply goes instead of the From address, e.g. the prospect behind a sales inquiry. */
  replyTo?: string;
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

/**
 * A failed Resend API call. `status` is the HTTP status, or undefined when the request never got
 * an answer (a network failure, so Resend never saw it).
 */
export class ResendSendError extends Error {
  constructor(
    message: string,
    readonly status: number | undefined,
  ) {
    super(message);
    this.name = "ResendSendError";
  }
}

/** Errors that should be retried rather than recorded as terminal failures. */
export function isRetryableSendError(err: unknown): boolean {
  if (err instanceof ResendSendError) {
    // No answer, rate limiting and 5xx are transient; any other 4xx is our request and will fail
    // again unchanged.
    return err.status === undefined || err.status === 429 || err.status >= 500;
  }
  if (err instanceof Error) {
    // Connection-level failures — SES never saw the request, so retrying is safe.
    if (
      err.name === "ECONNRESET" ||
      err.name === "EPIPE" ||
      err.name === "ETIMEDOUT" ||
      err.name === "EAI_AGAIN" ||
      err.name === "ENOTFOUND" ||
      err.message.includes("socket closed")
    ) {
      return true;
    }
    if ("$metadata" in err) {
      const status = (err as { $metadata?: { httpStatusCode?: number } }).$metadata?.httpStatusCode;
      if (status !== undefined) {
        // 429 (throttling) and 5xx are transient by SES's own contract.
        return status === 429 || status >= 500;
      }
    }
  }
  return false;
}

/**
 * Build the email sender. Without a region the sender is a dry run: it resolves like a send but
 * nothing leaves the process, so the whole dispatcher pipeline (claim, dedup, delivery ledger)
 * works in development and CI without AWS credentials.
 */
export function createSesSender(
  env: {
    SES_REGION?: string;
    SES_FROM_ADDRESS: string;
    SES_FROM_NAME?: string;
    SES_CONFIGURATION_SET?: string;
  },
  logger: SenderLogger,
): EmailSender {
  const fromAddress = env.SES_FROM_ADDRESS;
  const from = formatFrom(fromAddress, env.SES_FROM_NAME);

  if (env.SES_REGION === undefined) {
    logger.warn({ fromAddress }, "SES_REGION unset — email dispatcher running in dry-run mode");
    return {
      async send(_email: OutboundEmail): Promise<SentEmail> {
        return { messageId: `dry-run-${crypto.randomUUID()}`, dryRun: true };
      },
    };
  }

  const client = new SESv2Client({ region: env.SES_REGION });

  return {
    async send(email: OutboundEmail): Promise<SentEmail> {
      const result = await client.send(
        new SendEmailCommand({
          FromEmailAddress: from,
          // Bounces and complaints are published through the configuration set's SNS destination
          // to the API, which suppresses the address (apps/api/src/email/webhook.ts).
          ConfigurationSetName: env.SES_CONFIGURATION_SET,
          Destination: { ToAddresses: [email.to] },
          ...(email.replyTo ? { ReplyToAddresses: [email.replyTo] } : {}),
          Content: {
            Simple: {
              Subject: { Data: email.subject, Charset: "UTF-8" },
              Body: {
                Text: { Data: email.text, Charset: "UTF-8" },
                Html: { Data: email.html, Charset: "UTF-8" },
              },
            },
          },
        }),
      );

      if (result.MessageId === undefined) {
        throw new Error("SES SendEmail returned no MessageId");
      }
      return { messageId: result.MessageId, dryRun: false };
    },
  };
}

/**
 * Display name and address, so inboxes show "Studafy" rather than a bare no-reply address. The
 * name is quoted: it must not be able to inject another address.
 */
function formatFrom(address: string, name: string | undefined): string {
  return name ? `"${name.replaceAll('"', "")}" <${address}>` : address;
}

export const RESEND_API_URL = "https://api.resend.com/emails";

/**
 * Build the Resend sender. The from address (SES_FROM_ADDRESS / SES_FROM_NAME, shared with SES)
 * must be on a domain verified in Resend. Without RESEND_API_KEY the sender is a dry run, like SES
 * without a region. Bounces and complaints come back through the API's /email/webhooks/resend.
 */
export function createResendSender(
  env: {
    RESEND_API_KEY?: string;
    SES_FROM_ADDRESS: string;
    SES_FROM_NAME?: string;
  },
  logger: SenderLogger,
  fetchImpl: typeof fetch = fetch,
): EmailSender {
  const fromAddress = env.SES_FROM_ADDRESS;
  const from = formatFrom(fromAddress, env.SES_FROM_NAME);
  const apiKey = env.RESEND_API_KEY;

  if (!apiKey) {
    logger.warn({ fromAddress }, "RESEND_API_KEY unset — email dispatcher running in dry-run mode");
    return {
      async send(_email: OutboundEmail): Promise<SentEmail> {
        return { messageId: `dry-run-${crypto.randomUUID()}`, dryRun: true };
      },
    };
  }

  return {
    async send(email: OutboundEmail): Promise<SentEmail> {
      let response: Response;
      try {
        response = await fetchImpl(RESEND_API_URL, {
          method: "POST",
          headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
          body: JSON.stringify({
            from,
            to: [email.to],
            subject: email.subject,
            text: email.text,
            html: email.html,
            ...(email.replyTo ? { reply_to: email.replyTo } : {}),
          }),
        });
      } catch (err) {
        throw new ResendSendError(
          `Resend request failed: ${err instanceof Error ? err.message : String(err)}`,
          undefined,
        );
      }

      const body = (await response.json().catch(() => null)) as {
        id?: unknown;
        message?: unknown;
      } | null;
      if (!response.ok) {
        const detail = typeof body?.message === "string" ? `: ${body.message}` : "";
        throw new ResendSendError(
          `Resend answered HTTP ${response.status}${detail}`,
          response.status,
        );
      }
      if (typeof body?.id !== "string") {
        throw new Error("Resend returned no email id");
      }
      return { messageId: body.id, dryRun: false };
    },
  };
}

/** The sender for EMAIL_PROVIDER: SES (the default) or Resend. */
export function createEmailSender(
  env: {
    EMAIL_PROVIDER: "ses" | "resend";
    RESEND_API_KEY?: string;
    SES_REGION?: string;
    SES_FROM_ADDRESS: string;
    SES_FROM_NAME?: string;
    SES_CONFIGURATION_SET?: string;
  },
  logger: SenderLogger,
): EmailSender {
  return env.EMAIL_PROVIDER === "resend"
    ? createResendSender(env, logger)
    : createSesSender(env, logger);
}
