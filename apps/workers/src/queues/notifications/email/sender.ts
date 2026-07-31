/**
 * SES send adapter for the email channel.
 *
 * The dispatcher depends on a narrow `EmailSender` interface so tests inject a stub and the
 * process never touches AWS. `createSesSender` builds the real adapter, or a loud dry-run
 * substitute when no SES_REGION is configured (local development and CI).
 */

import { SendEmailCommand, SESv2Client } from "@aws-sdk/client-sesv2";

import type { RenderedEmail } from "./templates";

export interface OutboundEmail extends RenderedEmail {
  to: string;
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

/** Errors that should be retried rather than recorded as terminal failures. */
export function isRetryableSendError(err: unknown): boolean {
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
  env: { SES_REGION?: string; SES_FROM_ADDRESS: string },
  logger: SenderLogger,
): EmailSender {
  const fromAddress = env.SES_FROM_ADDRESS;

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
          FromEmailAddress: fromAddress,
          Destination: { ToAddresses: [email.to] },
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
