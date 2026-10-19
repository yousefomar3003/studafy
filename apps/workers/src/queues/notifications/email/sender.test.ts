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

const { createSesSender } = await import("./sender");

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
