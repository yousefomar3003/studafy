/**
 * QA-005: production releases are gated, built once, scanned, deployed by digest, smoke-checked
 * for readiness, and rolled back on failure.
 *
 * The scripts run against fake `gh`, `flyctl`, `docker` and `curl` binaries; nothing here talks to
 * GitHub or Fly. The workflow assertions read .github/workflows/fly-production-deploy.yml.
 *
 *   bun test scripts/deploy
 */

import { chmodSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// eslint-disable-next-line import-x/no-unresolved -- "bun:test" is a virtual Bun built-in with no resolvable file path
import { describe, expect, test } from "bun:test";

const here = import.meta.dir;
const root = join(here, "../../..");
const SHA = "a".repeat(40);

/** A fake binary that prints `stdout` and exits with `code`. */
function fake(name: string, script: string): string {
  const dir = mkdtempSync(join(tmpdir(), "qa005-"));
  const path = join(dir, name);
  writeFileSync(path, `#!/usr/bin/env bash\n${script}\n`);
  chmodSync(path, 0o755);
  return path;
}

function run(script: string, args: string[], env: Record<string, string> = {}) {
  const result = Bun.spawnSync(["bash", join(here, "..", script), ...args], {
    env: { ...process.env, ...env },
  });
  return {
    code: result.exitCode,
    stdout: result.stdout.toString(),
    stderr: result.stderr.toString(),
  };
}

function ghReturning(runs: object[]) {
  return fake("gh", `cat <<'JSON'\n${JSON.stringify({ workflow_runs: runs })}\nJSON`);
}

const runFor = (overrides: object) => ({
  head_sha: SHA,
  status: "completed",
  conclusion: "success",
  created_at: "2026-11-16T10:00:00Z",
  html_url: "https://github.com/o/r/actions/runs/1",
  ...overrides,
});

describe("verify-ci-green.sh", () => {
  const verify = (ref: string, runs: object[], sha = SHA) =>
    run("verify-ci-green.sh", ["o/r", sha, ref], { GH: ghReturning(runs) });

  test("passes for main with a green CI run on that exact SHA", () => {
    expect(verify("refs/heads/main", [runFor({})]).code).toBe(0);
  });

  test("refuses any other ref, even with green CI", () => {
    // dev is refused too: production is released from main, which holds what dev was merged into.
    for (const ref of [
      "refs/heads/dev",
      "refs/heads/stage",
      "refs/heads/feature/x",
      "refs/tags/v1",
    ]) {
      const result = verify(ref, [runFor({})]);
      expect(result.code).toBe(1);
      expect(result.stderr).toContain("only from main");
    }
  });

  test("refuses red, cancelled, running or missing CI", () => {
    expect(verify("refs/heads/main", [runFor({ conclusion: "failure" })]).code).toBe(1);
    expect(verify("refs/heads/main", [runFor({ conclusion: "cancelled" })]).code).toBe(1);
    expect(
      verify("refs/heads/main", [runFor({ status: "in_progress", conclusion: null })]).code,
    ).toBe(1);
    expect(verify("refs/heads/main", []).code).toBe(1);
  });

  test("judges the newest run: a later red re-run wins over an earlier green one", () => {
    const result = verify("refs/heads/main", [
      runFor({ created_at: "2026-11-16T10:00:00Z" }),
      runFor({ created_at: "2026-11-16T11:00:00Z", conclusion: "failure" }),
    ]);
    expect(result.code).toBe(1);
  });

  test("ignores runs for other commits", () => {
    expect(verify("refs/heads/main", [runFor({ head_sha: "b".repeat(40) })]).code).toBe(1);
  });
});

describe("release.sh", () => {
  const digest = `sha256:${"c".repeat(64)}`;

  test("build prints the pushed image by digest", () => {
    const result = run("release.sh", ["build", "studafy-core-api", "infra/fly/api.toml", "rel1"], {
      FLYCTL: fake("flyctl", "exit 0"),
      DOCKER: fake("docker", `echo '{"digest":"${digest}"}'`),
    });
    expect(result.code).toBe(0);
    expect(result.stdout.trim()).toBe(`registry.fly.io/studafy-core-api@${digest}`);
  });

  test("build waits for a registry that lags the push", () => {
    const counter = join(mkdtempSync(join(tmpdir(), "qa005-")), "count");
    const result = run("release.sh", ["build", "studafy-core-web", "infra/fly/web.toml", "rel1"], {
      FLYCTL: fake("flyctl", "exit 0"),
      // "not found" twice, then the manifest: what registry.fly.io did right after a push.
      DOCKER: fake(
        "docker",
        `n=$(( $(cat "${counter}" 2>/dev/null || echo 0) + 1 )); echo $n > "${counter}"
if [ $n -lt 3 ]; then echo "ERROR: not found" >&2; exit 1; fi
echo '{"digest":"${digest}"}'`,
      ),
      DIGEST_RETRY_DELAY: "0",
    });
    expect(result.code).toBe(0);
    expect(result.stdout.trim()).toBe(`registry.fly.io/studafy-core-web@${digest}`);
    expect(readFileSync(counter, "utf8").trim()).toBe("3");
  });

  test("build fails, printing nothing, when the digest never appears", () => {
    const result = run("release.sh", ["build", "studafy-core-web", "infra/fly/web.toml", "rel1"], {
      FLYCTL: fake("flyctl", "exit 0"),
      DOCKER: fake("docker", `echo "ERROR: not found" >&2; exit 1`),
      DIGEST_ATTEMPTS: "2",
      DIGEST_RETRY_DELAY: "0",
    });
    expect(result.code).toBe(1);
    expect(result.stdout.trim()).toBe("");
    expect(result.stderr).toContain("Could not resolve a digest");
  });

  test("deploy refuses a mutable tag", () => {
    const result = run(
      "release.sh",
      [
        "deploy",
        "studafy-core-api",
        "infra/fly/api.toml",
        "registry.fly.io/studafy-core-api:latest",
      ],
      { FLYCTL: fake("flyctl", "exit 0") },
    );
    expect(result.code).toBe(1);
    expect(result.stderr).toContain("mutable");
  });

  test("current-image reads the running digest", () => {
    const result = run("release.sh", ["current-image", "studafy-core-api"], {
      FLYCTL: fake(
        "flyctl",
        `echo '{"Registry":"registry.fly.io","Repository":"studafy-core-api","Digest":"${digest}"}'`,
      ),
    });
    expect(result.stdout.trim()).toBe(`registry.fly.io/studafy-core-api@${digest}`);
  });

  /** A curl that answers per URL suffix, writing a body to --output when given one. */
  function curl(answers: Record<string, [string, string?]>) {
    const cases = Object.entries(answers)
      .map(
        ([suffix, [code, body]]) =>
          `  *${suffix}) ${body ? `printf '%s' '${body}' > "$out";` : ""} printf '${code}' ;;`,
      )
      .join("\n");
    return fake(
      "curl",
      `out=/dev/null; url=""
while [ $# -gt 0 ]; do case "$1" in --output) out="$2"; shift 2;; --*) [ "$1" = --max-time ] || [ "$1" = --write-out ] && shift; shift;; *) url="$1"; shift;; esac; done
case "$url" in
${cases}
  *) printf 000 ;;
esac`,
    );
  }

  const jwks = '{"keys":[{"kid":"k1"}]}';
  const healthy = {
    "/readyz": ["200"],
    "/healthz": ["200"],
    "/api/auth/sessions": ["401"],
    "/.well-known/jwks.json": ["200", jwks],
  } as Record<string, [string, string?]>;
  const smoke = (answers: Record<string, [string, string?]>) =>
    run("release.sh", ["smoke", "https://api", "https://web"], {
      CURL: curl(answers),
      SMOKE_ATTEMPTS: "2",
      SMOKE_DELAY: "0",
    });

  test("smoke passes on a ready, consistent deployment", () => {
    const result = smoke(healthy);
    expect(result.stderr).toBe("");
    expect(result.code).toBe(0);
  });

  test("smoke fails when /readyz is not ready (liveness alone is not enough)", () => {
    expect(smoke({ ...healthy, "/readyz": ["503"] }).code).toBe(1);
  });

  test("smoke fails when the auth surface errors", () => {
    expect(smoke({ ...healthy, "/api/auth/sessions": ["500"] }).code).toBe(1);
  });

  const ips = (list: object[] | null) =>
    run("release.sh", ["private-only", "studafy-core-erpnext"], {
      FLYCTL: fake("flyctl", `echo '${JSON.stringify(list)}'`),
    });
  const privateIp = { Address: "fdaa:0:1::3", Type: "private_v6" };

  test("private-only passes for an app with only a private address", () => {
    const result = ips([privateIp]);
    expect(result.code).toBe(0);
    expect(result.stdout).toContain("private address only");
  });

  test("private-only fails when any public address exists, and names it", () => {
    const result = ips([privateIp, { Address: "2a09:8280:1::1", Type: "v6" }]);
    expect(result.code).toBe(1);
    expect(result.stderr).toContain("2a09:8280:1::1");
  });

  test("private-only fails for an app with no address (a deploy would allocate public ones)", () => {
    expect(ips([]).code).toBe(1);
    expect(ips(null).code).toBe(1);
  });

  /** A flyctl with one started machine whose `machine exec` prints `execOutput`. */
  const machine = (execOutput: string) =>
    fake(
      "flyctl",
      `case "$1 $2" in
  "machine list") echo '[{"id":"m1","state":"started"}]' ;;
  "machine exec") [ "$3" = m1 ] && printf '%s\\n' '${execOutput}' ;;
  *) exit 1 ;;
esac`,
    );
  const smokePrivate = (flyctl: string) =>
    run("release.sh", ["smoke-private", "studafy-core-erpnext", "http://127.0.0.1:8000/x"], {
      FLYCTL: flyctl,
      SMOKE_ATTEMPTS: "2",
      SMOKE_DELAY: "0",
    });

  test("smoke-private passes when the URL answers below 500 inside the machine", () => {
    // Frappe answers 404 when no site matches the Host header: the web process is up.
    const result = smokePrivate(machine("smoke-status-404"));
    expect(result.code).toBe(0);
    expect(result.stdout).toContain("answers http://127.0.0.1:8000/x with 404");
  });

  test("smoke-private fails on a 5xx, a refused connection, or no started machine", () => {
    expect(smokePrivate(machine("smoke-status-502")).code).toBe(1);
    expect(smokePrivate(machine("smoke-status-000")).code).toBe(1);
    const none = smokePrivate(fake("flyctl", `echo '[{"id":"m1","state":"stopped"}]'`));
    expect(none.code).toBe(1);
    expect(none.stderr).toContain("never answered");
  });
});

describe("fly-production-deploy.yml", () => {
  const workflow = readFileSync(join(root, ".github/workflows/fly-production-deploy.yml"), "utf8");

  test("a gate job without secrets checks the ref and CI before the deploy job runs", () => {
    expect(workflow).toMatch(/^ {2}gate:/m);
    expect(workflow).toContain("scripts/deploy/verify-ci-green.sh");
    expect(workflow).toMatch(/needs:\s*gate/);
    const gate = workflow.slice(workflow.indexOf("  gate:"), workflow.indexOf("  deploy:"));
    expect(gate).not.toContain("environment:");
    expect(gate).not.toContain("secrets.");
  });

  test("app images are built once, scanned at HIGH, and deployed by digest", () => {
    expect(workflow).toContain("release.sh build");
    expect(workflow).toContain("aquasecurity/trivy-action");
    expect(workflow).toMatch(/severity:\s*HIGH,CRITICAL/);
    expect(workflow).toContain("release.sh deploy");
    expect(workflow).not.toMatch(
      /flyctl deploy \. --config infra\/fly\/(api|realtime|workers|web)\.toml --remote-only/,
    );
  });

  test("the smoke check uses readiness, and a failure rolls back to the previous digests", () => {
    expect(workflow).toContain("release.sh smoke");
    expect(workflow).not.toMatch(/fly\.dev\/healthz;/);
    expect(workflow).toMatch(/Roll back[\s\S]*if:\s*\$\{\{\s*failure\(\)/);
    expect(workflow).toContain("release.sh current-image");
  });

  test("the JWT signing key is required and staged onto the API (QA-023)", () => {
    expect(workflow).toContain("JWT_PRIVATE_KEY_PEM: ${{ secrets.JWT_PRIVATE_KEY_PEM }}");
    expect(workflow).toMatch(/for key in[^;]*JWT_PRIVATE_KEY_PEM/);
    expect(workflow).toMatch(/stage studafy-core-api[\s\S]*?JWT_PRIVATE_KEY_PEM/);
  });

  describe("ERPNext stays off unless ERPNEXT_ENABLED is 'true'", () => {
    interface Step {
      name?: string;
      id?: string;
      if?: string;
      run?: string;
      env?: Record<string, string>;
      with?: Record<string, string>;
    }
    const parsed = Bun.YAML.parse(workflow) as { jobs: { deploy: { steps: Step[] } } };
    const steps = parsed.jobs.deploy.steps;
    const isErpNext = (step: Step) => (step.name ?? "").startsWith("ERPNext:");
    const gate = /^\$\{\{ vars\.ERPNEXT_ENABLED == 'true' \}\}$/;

    test("every ERPNext step is gated on the variable (the rollback on its gated deploy)", () => {
      const erpnext = steps.filter(isErpNext);
      expect(erpnext.map((step) => step.id ?? step.name)).toEqual([
        "ERPNext: check the app is private, and copy its secrets",
        "previous_erpnext",
        "erpnext_image",
        "deploy_erpnext",
        "ERPNext: smoke check",
        "ERPNext: roll back to the previous image",
      ]);
      for (const step of erpnext.slice(0, -1)) expect(step.if).toMatch(gate);
      expect(erpnext.at(-1)!.if).toBe(
        "${{ failure() && steps.deploy_erpnext.outcome != 'skipped' }}",
      );
    });

    test("no ungated step builds, stages or deploys anything ERPNext", () => {
      for (const step of steps.filter((s) => !isErpNext(s))) {
        expect(JSON.stringify(step)).not.toMatch(/erpnext|MARIADB|BACKUP_S3/i);
      }
    });

    test("ERPNext deploys after the migrations and before the API", () => {
      const index = (name: string) => steps.findIndex((step) => step.name === name);
      expect(index("Run database migrations")).toBeLessThan(index("ERPNext: deploy"));
      expect(index("ERPNext: smoke check")).toBeLessThan(index("Deploy the API"));
    });
  });
});
