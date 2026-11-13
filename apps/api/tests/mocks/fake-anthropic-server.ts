/**
 * Standalone runner for `createFakeAnthropic()` (see fake-anthropic.ts for what it is and why it
 * exists). Started by the critical-journeys E2E suite's global setup
 * (apps/web/e2e/critical/support/global-setup.ts) as its own process, listening on `PORT`.
 */
import { createFakeAnthropic } from "./fake-anthropic";

const port = Number(process.env.PORT ?? 38071);
const app = createFakeAnthropic();
app.get("/healthz", (c) => c.text("ok"));

const server = Bun.serve({ port, hostname: "127.0.0.1", fetch: app.fetch });
console.log(`fake anthropic listening on http://${server.hostname}:${server.port}`);

process.on("SIGTERM", () => process.exit(0));
process.on("SIGINT", () => process.exit(0));
