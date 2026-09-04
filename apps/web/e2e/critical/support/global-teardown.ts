/**
 * Tears down everything global-setup.ts started: the spawned fake-Anthropic/API/workers processes
 * (by PID, from the state file global-setup.ts wrote — see its own header for why setup and
 * teardown can't just share memory), then the disposable Postgres+Redis containers, matching the
 * `db:down` step every other database-backed CI job in this repo already runs.
 */
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, rmSync } from "node:fs";
import path from "node:path";

const REPO_ROOT = path.resolve(__dirname, "../../../../..");
const STATE_FILE = path.join(__dirname, ".e2e-pids.json");

interface SpawnedProcess {
  name: string;
  pid: number;
}

function killTree(pid: number): void {
  try {
    if (process.platform === "win32") {
      spawnSync("taskkill", ["/pid", String(pid), "/T", "/F"], { stdio: "ignore" });
    } else {
      process.kill(-pid, "SIGTERM");
    }
  } catch {
    // Already exited — nothing to do.
  }
}

export default async function globalTeardown(): Promise<void> {
  if (existsSync(STATE_FILE)) {
    const processes = JSON.parse(readFileSync(STATE_FILE, "utf8")) as SpawnedProcess[];
    for (const proc of processes) {
      console.log(`[e2e] stopping ${proc.name} (pid ${proc.pid})`);
      killTree(proc.pid);
    }
    rmSync(STATE_FILE, { force: true });
  }

  console.log("[e2e] stopping disposable Postgres + Redis");
  spawnSync("docker", ["compose", "-f", "db/compose.yml", "down"], {
    cwd: REPO_ROOT,
    stdio: "inherit",
    shell: true,
  });
}
