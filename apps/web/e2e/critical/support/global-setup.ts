/**
 * Global setup for the critical-journeys E2E suite (ST-246).
 *
 * Everything here is sequenced by hand rather than split across Playwright's `webServer` array,
 * because migration and seeding are one-shot steps that must fully finish before anything that reads
 * the database starts, and `/healthz` deliberately never checks a dependency (see src/health.ts) — a
 * `webServer` readiness check against it would pass the instant the process binds a port, whether or
 * not migrations had run yet. Doing the whole sequence here, awaited step by step, makes that race
 * structurally impossible instead of relying on webServer-vs-globalSetup ordering that isn't this
 * suite's to depend on. Playwright's own `webServer` (playwright.critical.config.ts) is left to do
 * only the one thing it fits well: building and previewing the web app, which touches no database.
 *
 * Sequence: start disposable Postgres+Redis (db/compose.yml, shared with the rest of this repo's
 * local/CI database-backed suites) → migrate → seed (idempotent — a re-run against an already-seeded
 * database is a clean no-op, per db/seeds/seed.ts's own header) → start the fake Anthropic server →
 * start the E2E API process (tests/e2e/server.ts) with the mock OAuth provider and the fake
 * Anthropic base URL wired in → start the real workers process (needed for the invoice→payment
 * journey's async batch-generation job and the outbox relay). PIDs and the docker lifecycle are
 * handed to global-teardown.ts via a small state file, since globalSetup and globalTeardown run as
 * separate Playwright invocations that do not share memory.
 */
import { spawn } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";

import {
  API_BASE_URL,
  API_PORT,
  FAKE_ANTHROPIC_BASE_URL,
  FAKE_ANTHROPIC_PORT,
  MOCK_OAUTH_ISSUER_URL,
  MOCK_OAUTH_REDIRECT_URI,
  WEB_BASE_URL,
} from "./ports";

const REPO_ROOT = path.resolve(__dirname, "../../../../..");
const STATE_FILE = path.join(__dirname, ".e2e-pids.json");
const READY_TIMEOUT_MS = 60_000;

interface SpawnedProcess {
  name: string;
  pid: number;
}

function run(command: string, args: string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd: REPO_ROOT, stdio: "inherit", shell: true });
    child.on("exit", (code) => {
      if (code === 0) resolve();
      else reject(new Error(`${command} ${args.join(" ")} exited with code ${code}`));
    });
    child.on("error", reject);
  });
}

function spawnLongRunning(
  name: string,
  command: string,
  args: string[],
  env: Record<string, string>,
): SpawnedProcess {
  const child = spawn(command, args, {
    cwd: REPO_ROOT,
    stdio: "inherit",
    shell: true,
    env: { ...process.env, ...env },
    detached: process.platform !== "win32",
  });
  if (!child.pid) throw new Error(`failed to spawn ${name}`);
  return { name, pid: child.pid };
}

async function waitForHealthy(url: string, label: string): Promise<void> {
  const deadline = Date.now() + READY_TIMEOUT_MS;
  let lastError: unknown;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(url);
      if (res.ok) return;
    } catch (error) {
      lastError = error;
    }
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  throw new Error(
    `${label} did not become healthy within ${READY_TIMEOUT_MS}ms: ${String(lastError)}`,
  );
}

export default async function globalSetup(): Promise<void> {
  const processes: SpawnedProcess[] = [];

  console.log("[e2e] starting disposable Postgres + Redis");
  await run("docker", ["compose", "-f", "db/compose.yml", "up", "-d", "--wait"]);

  console.log("[e2e] running migrations");
  await run("bun", ["run", "db:migrate"]);

  console.log("[e2e] seeding the demo tenant (idempotent)");
  await run("bun", ["run", "db:seed"]);

  console.log("[e2e] adding this suite's own small fixtures (idempotent)");
  await run("bun", ["run", "db/seeds/e2e-critical-fixtures.ts"]);

  console.log("[e2e] starting fake Anthropic server");
  processes.push(
    spawnLongRunning(
      "fake-anthropic",
      "bun",
      ["run", "apps/api/tests/mocks/fake-anthropic-server.ts"],
      { PORT: String(FAKE_ANTHROPIC_PORT) },
    ),
  );
  await waitForHealthy(`${FAKE_ANTHROPIC_BASE_URL}/healthz`, "fake Anthropic server");

  console.log("[e2e] starting the E2E API process");
  processes.push(
    spawnLongRunning("api", "bun", ["run", "apps/api/tests/e2e/server.ts"], {
      PORT: String(API_PORT),
      HOST: "127.0.0.1",
      NODE_ENV: "development",
      MOCK_OAUTH_ISSUER_URL,
      MOCK_OAUTH_REDIRECT_URI,
      ANTHROPIC_BASE_URL: `${FAKE_ANTHROPIC_BASE_URL}/v1`,
      ANTHROPIC_API_KEY: "fake-e2e-anthropic-key",
      AI_LLM_ENABLED: "true",
      FRONTEND_URL: WEB_BASE_URL,
    }),
  );
  await waitForHealthy(`${API_BASE_URL}/healthz`, "E2E API process");

  console.log("[e2e] starting the workers process (billing batches + outbox relay)");
  processes.push(spawnLongRunning("workers", "bun", ["run", "apps/workers/src/index.ts"], {}));

  mkdirSync(path.dirname(STATE_FILE), { recursive: true });
  writeFileSync(STATE_FILE, JSON.stringify(processes, null, 2));

  console.log("[e2e] stack ready");
}
