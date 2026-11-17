import { spawnSync } from "node:child_process";
import path from "node:path";

/**
 * The raw one-time token an email would have carried, read from the disposable E2E database.
 *
 * `POST /api/schools/register` is anonymous, so it never returns its verification or invitation
 * token (QA-007): they reach their owners only by email, through the `school.verificationEmailSent`
 * and `invitation.sent` outbox events. This suite has no inbox to open, so it reads the same outbox
 * row the email dispatcher reads -- from the `test-postgres` container global-setup.ts started, via
 * `docker compose exec`, never from any other database.
 */
export type EmailedTokenEvent = "school.verificationEmailSent" | "invitation.sent";

const REPO_ROOT = path.resolve(__dirname, "../../../../..");

export function emailedToken(event: EmailedTokenEvent, email: string): string {
  const query = `
    SELECT payload->>'token'
    FROM app.outbox_events
    WHERE event_name = :'event' AND payload->>'email' = :'email'
    ORDER BY id DESC
    LIMIT 1;
  `;
  const result = spawnSync(
    "docker",
    [
      "compose",
      "exec",
      "-T",
      "test-postgres",
      "psql",
      "-U",
      "studafy_test",
      "-d",
      "postgres",
      "-tA",
      "-v",
      "ON_ERROR_STOP=1",
      "-v",
      `event=${event}`,
      "-v",
      `email=${email}`,
      "-f",
      "-",
    ],
    { cwd: REPO_ROOT, input: query, encoding: "utf8" },
  );
  if (result.status !== 0) {
    throw new Error(`reading the ${event} token for ${email} failed: ${result.stderr}`);
  }
  const token = result.stdout.trim();
  if (!/^[0-9a-f]{64}$/.test(token)) {
    throw new Error(`no ${event} email was queued for ${email}`);
  }
  return token;
}
