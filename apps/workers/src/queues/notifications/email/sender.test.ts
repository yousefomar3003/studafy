// eslint-disable-next-line import-x/no-unresolved -- "bun:test" is a virtual Bun built-in with no resolvable file path
import { describe, expect, mock, test } from "bun:test";

const sent: Record<string, unknown>[] = [];

mock.module("@aws-sdk/client-sesv2", () => ({
  SESv2Client: class {
    async send(command: { input: Record<string, unknown> }) {
      sent.push(command.input);
      return { MessageId: "ses-message-1" };
    }
  },
  SendEmailCommand: class {
    constructor(readonly input: Record<string, unknown>) {}
  },
}));

const {
  createEmailSender,
  createResendSender,
  createSesSender,
  isRetryableSendError,
  RESEND_API_URL,
} = await import("./sender");

const logger = { warn: () => undefined, info: () => undefined, error: () => undefined };
const email = { to: "parent@example.com", subject: "Welcome", text: "Hi", html: "<p>Hi</p>" };

describe("createSesSender", () => {
  test("sends as Studafy from the verified address, through the configuration set", async () => {
    sent.length = 0;
    const sender = createSesSender(
      {
        SES_REGION: "eu-central-1",
        SES_FROM_ADDRESS: "no-reply@send.studafy.com",
        SES_FROM_NAME: "Studafy",
        SES_CONFIGURATION_SET: "studafy-prod",
      },
      logger as never,
    );

    const result = await sender.send(email as never);

    expect(result).toEqual({ messageId: "ses-message-1", dryRun: false });
    expect(sent[0]).toMatchObject({
      FromEmailAddress: '"Studafy" <no-reply@send.studafy.com>',
      ConfigurationSetName: "studafy-prod",
      Destination: { ToAddresses: ["parent@example.com"] },
    });
  });

  test("a quote in the display name cannot break out of it", async () => {
    sent.length = 0;
    const sender = createSesSender(
      {
        SES_REGION: "eu-central-1",
        SES_FROM_ADDRESS: "no-reply@send.studafy.com",
        SES_FROM_NAME: 'Evil" <attacker@example.com>',
      },
      logger as never,
    );

    await sender.send(email as never);

    expect(sent[0]!.FromEmailAddress).toBe(
      '"Evil <attacker@example.com>" <no-reply@send.studafy.com>',
    );
  });

  test("without a region nothing is sent: a dry run", async () => {
    sent.length = 0;
    const sender = createSesSender(
      { SES_FROM_ADDRESS: "no-reply@send.studafy.com" },
      logger as never,
    );

    const result = await sender.send(email as never);

    expect(result.dryRun).toBe(true);
    expect(sent).toEqual([]);
  });
});

describe("createResendSender", () => {
  const env = {
    RESEND_API_KEY: "re_test_key",
    SES_FROM_ADDRESS: "no-reply@send.studafy.com",
    SES_FROM_NAME: "Studafy",
  };

  function fakeFetch(status: number, body: unknown) {
    const calls: { url: string; init: RequestInit }[] = [];
    const impl = (async (url: string, init: RequestInit) => {
      calls.push({ url, init });
      return new Response(JSON.stringify(body), { status });
    }) as unknown as typeof fetch;
    return { impl, calls };
  }

  test("posts the email to Resend with the key and returns Resend's id", async () => {
    const { impl, calls } = fakeFetch(200, { id: "re-email-1" });
    const sender = createResendSender(env, logger as never, impl);

    const result = await sender.send({ ...email, replyTo: "prospect@example.com" } as never);

    expect(result).toEqual({ messageId: "re-email-1", dryRun: false });
    expect(calls[0]!.url).toBe(RESEND_API_URL);
    expect((calls[0]!.init.headers as Record<string, string>).Authorization).toBe(
      "Bearer re_test_key",
    );
    expect(JSON.parse(calls[0]!.init.body as string)).toEqual({
      from: '"Studafy" <no-reply@send.studafy.com>',
      to: ["parent@example.com"],
      subject: "Welcome",
      text: "Hi",
      html: "<p>Hi</p>",
      reply_to: "prospect@example.com",
    });
  });

  test("rate limiting and server errors are retried; a rejected request is not", async () => {
    for (const [status, retryable] of [
      [429, true],
      [503, true],
      [422, false],
      [401, false],
    ] as const) {
      const sender = createResendSender(env, logger as never, fakeFetch(status, {}).impl);
      const error = await sender.send(email as never).catch((err: unknown) => err);
      expect(isRetryableSendError(error)).toBe(retryable);
    }
  });

  test("a request that never got an answer is retried", async () => {
    const impl = (async () => {
      throw new TypeError("fetch failed");
    }) as unknown as typeof fetch;
    const sender = createResendSender(env, logger as never, impl);

    const error = await sender.send(email as never).catch((err: unknown) => err);

    expect(isRetryableSendError(error)).toBe(true);
  });

  test("without a key nothing is sent: a dry run", async () => {
    const { impl, calls } = fakeFetch(200, { id: "never" });
    const sender = createResendSender(
      { SES_FROM_ADDRESS: "no-reply@send.studafy.com" },
      logger as never,
      impl,
    );

    const result = await sender.send(email as never);

    expect(result.dryRun).toBe(true);
    expect(calls).toEqual([]);
  });
});

describe("createEmailSender", () => {
  test("uses SES unless EMAIL_PROVIDER says resend", async () => {
    sent.length = 0;
    const sender = createEmailSender(
      { EMAIL_PROVIDER: "ses", SES_REGION: "eu-central-1", SES_FROM_ADDRESS: "a@send.studafy.com" },
      logger as never,
    );

    await sender.send(email as never);

    expect(sent).toHaveLength(1);
  });
});
