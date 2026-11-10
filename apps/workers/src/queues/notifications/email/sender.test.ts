// eslint-disable-next-line import-x/no-unresolved -- "bun:test" is a virtual Bun built-in with no resolvable file path
import { describe, expect, test } from "bun:test";

import { ResendSendError, createEmailSender, isRetryableSendError } from "./sender";

interface Captured {
  url: string;
  headers: Record<string, string>;
  body: Record<string, unknown>;
}

const logger = { warn: () => undefined };
const email = { to: "parent@example.com", subject: "Welcome", text: "Hi", html: "<p>Hi</p>" };
const env = {
  RESEND_API_KEY: "re_test_key",
  EMAIL_FROM_ADDRESS: "no-reply@send.studafy.com",
  EMAIL_FROM_NAME: "Studafy",
};

function stubFetch(status: number, response: unknown) {
  const calls: Captured[] = [];
  const fetchImpl = (async (url: string | URL | Request, init?: RequestInit) => {
    calls.push({
      url: String(url),
      headers: init?.headers as Record<string, string>,
      body: JSON.parse(String(init?.body)) as Record<string, unknown>,
    });
    return new Response(JSON.stringify(response), { status });
  }) as unknown as typeof fetch;
  return { calls, fetchImpl };
}

describe("createEmailSender", () => {
  test("sends as Studafy from the verified address with the API key", async () => {
    const { calls, fetchImpl } = stubFetch(200, { id: "re-message-1" });
    const sender = createEmailSender(env, logger, fetchImpl);

    const result = await sender.send({ ...email, idempotencyKey: "outbox-event-7" });

    expect(result).toEqual({ messageId: "re-message-1", dryRun: false });
    expect(calls[0]!.url).toBe("https://api.resend.com/emails");
    expect(calls[0]!.headers).toMatchObject({
      Authorization: "Bearer re_test_key",
      "Idempotency-Key": "outbox-event-7",
    });
    expect(calls[0]!.body).toEqual({
      from: '"Studafy" <no-reply@send.studafy.com>',
      to: ["parent@example.com"],
      subject: "Welcome",
      text: "Hi",
      html: "<p>Hi</p>",
    });
  });

  test("passes reply-to through", async () => {
    const { calls, fetchImpl } = stubFetch(200, { id: "re-message-2" });
    await createEmailSender(env, logger, fetchImpl).send({
      ...email,
      replyTo: "prospect@example.com",
    });
    expect(calls[0]!.body.reply_to).toEqual(["prospect@example.com"]);
    expect(calls[0]!.headers["Idempotency-Key"]).toBeUndefined();
  });

  test("a quote in the display name cannot break out of it", async () => {
    const { calls, fetchImpl } = stubFetch(200, { id: "re-message-3" });
    await createEmailSender(
      { ...env, EMAIL_FROM_NAME: 'Evil" <attacker@example.com>' },
      logger,
      fetchImpl,
    ).send(email);
    expect(calls[0]!.body.from).toBe('"Evil <attacker@example.com>" <no-reply@send.studafy.com>');
  });

  test("a Resend error surfaces its status and name", async () => {
    const { fetchImpl } = stubFetch(422, { name: "validation_error", message: "bad to" });
    const failure = createEmailSender(env, logger, fetchImpl).send(email);
    await expect(failure).rejects.toBeInstanceOf(ResendSendError);
    await expect(failure).rejects.toMatchObject({ status: 422, code: "validation_error" });
  });

  test("a 200 without an id is an error, not a send", async () => {
    const { fetchImpl } = stubFetch(200, {});
    await expect(createEmailSender(env, logger, fetchImpl).send(email)).rejects.toThrow(
      "no message id",
    );
  });

  test("without an API key nothing is sent: a dry run", async () => {
    const { calls, fetchImpl } = stubFetch(200, { id: "never" });
    const sender = createEmailSender(
      { EMAIL_FROM_ADDRESS: "no-reply@send.studafy.com" },
      logger,
      fetchImpl,
    );

    const result = await sender.send(email);

    expect(result.dryRun).toBe(true);
    expect(calls).toEqual([]);
  });
});

describe("isRetryableSendError", () => {
  test("rate limits, server errors and in-flight idempotent requests retry", () => {
    expect(isRetryableSendError(new ResendSendError(429, "rate_limit_exceeded", ""))).toBe(true);
    expect(isRetryableSendError(new ResendSendError(503, "application_error", ""))).toBe(true);
    expect(
      isRetryableSendError(new ResendSendError(409, "concurrent_idempotent_requests", "")),
    ).toBe(true);
  });

  test("request errors are terminal", () => {
    expect(isRetryableSendError(new ResendSendError(422, "validation_error", ""))).toBe(false);
    expect(isRetryableSendError(new ResendSendError(403, "invalid_api_key", ""))).toBe(false);
    expect(isRetryableSendError(new ResendSendError(409, "invalid_idempotent_request", ""))).toBe(
      false,
    );
    expect(isRetryableSendError(new Error("boom"))).toBe(false);
  });

  test("timeouts and connection failures retry", () => {
    const timeout = new Error("timed out");
    timeout.name = "TimeoutError";
    expect(isRetryableSendError(timeout)).toBe(true);
    expect(isRetryableSendError(Object.assign(new Error("reset"), { code: "ECONNRESET" }))).toBe(
      true,
    );
    expect(
      isRetryableSendError(Object.assign(new Error("refused"), { code: "ConnectionRefused" })),
    ).toBe(true);
  });
});
