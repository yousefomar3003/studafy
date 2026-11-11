// eslint-disable-next-line import-x/no-unresolved -- "bun:test" is a virtual Bun built-in with no resolvable file path
import { describe, expect, test } from "bun:test";

import { createEmailSender, isRetryableSendError, RESEND_API_URL } from "./sender";

const logger = { warn: () => undefined, info: () => undefined, error: () => undefined };
const email = { to: "parent@example.com", subject: "Welcome", text: "Hi", html: "<p>Hi</p>" };

describe("createEmailSender", () => {
  const env = {
    RESEND_API_KEY: "re_test_key",
    EMAIL_FROM_ADDRESS: "no-reply@send.studafy.com",
    EMAIL_FROM_NAME: "Studafy",
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
    const sender = createEmailSender(env, logger as never, impl);

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

  test("a quote in the display name cannot break out of it", async () => {
    const { impl, calls } = fakeFetch(200, { id: "re-email-2" });
    const sender = createEmailSender(
      { ...env, EMAIL_FROM_NAME: 'Evil" <attacker@example.com>' },
      logger as never,
      impl,
    );

    await sender.send(email as never);

    expect(JSON.parse(calls[0]!.init.body as string).from).toBe(
      '"Evil <attacker@example.com>" <no-reply@send.studafy.com>',
    );
  });

  test("rate limiting and server errors are retried; a rejected request is not", async () => {
    for (const [status, retryable] of [
      [429, true],
      [503, true],
      [422, false],
      [401, false],
    ] as const) {
      const sender = createEmailSender(env, logger as never, fakeFetch(status, {}).impl);
      const error = await sender.send(email as never).catch((err: unknown) => err);
      expect(isRetryableSendError(error)).toBe(retryable);
    }
  });

  test("a request that never got an answer is retried", async () => {
    const impl = (async () => {
      throw new TypeError("fetch failed");
    }) as unknown as typeof fetch;
    const sender = createEmailSender(env, logger as never, impl);

    const error = await sender.send(email as never).catch((err: unknown) => err);

    expect(isRetryableSendError(error)).toBe(true);
  });

  test("without a key nothing is sent: a dry run", async () => {
    const { impl, calls } = fakeFetch(200, { id: "never" });
    const sender = createEmailSender(
      { EMAIL_FROM_ADDRESS: "no-reply@send.studafy.com" },
      logger as never,
      impl,
    );

    const result = await sender.send(email as never);

    expect(result.dryRun).toBe(true);
    expect(calls).toEqual([]);
  });
});
