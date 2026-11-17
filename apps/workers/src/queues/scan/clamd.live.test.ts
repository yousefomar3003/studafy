/**
 * QA-054 against a real clamd built from infra/docker/clamav.Dockerfile. Skipped unless
 * CLAMAV_LIVE_PORT names a running scanner (and `zip` is installed, for the encrypted archive):
 *
 *   docker build --platform linux/amd64 --build-arg CLAMAV_TCP_ADDRS=0.0.0.0 \
 *     -f infra/docker/clamav.Dockerfile -t studafy-clamav .
 *   docker run -d -p 127.0.0.1:33100:3310 studafy-clamav
 *   CLAMAV_LIVE_PORT=33100 bun test src/queues/scan/clamd.live.test.ts
 */

import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// eslint-disable-next-line import-x/no-unresolved -- "bun:test" is a virtual Bun built-in
import { afterAll, describe, expect, test } from "bun:test";

import { scanStream } from "./clamd";

const port = Number(process.env.CLAMAV_LIVE_PORT ?? 0);
const hasZip = spawnSync("zip", ["-v"]).status === 0;
const describeLive = port > 0 ? describe : describe.skip;

const EICAR = "X5O!P%@AP[4\\PZX54(P^)7CC)7}$EICAR-STANDARD-ANTIVIRUS-TEST-FILE!$H+H*";
const config = { host: "127.0.0.1", port, timeoutMs: 120_000, maxFileBytes: 100 * 1024 * 1024 };
const scratch = mkdtempSync(join(tmpdir(), "clamd-live-"));

afterAll(() => rmSync(scratch, { recursive: true, force: true }));

async function* chunks(bytes: Uint8Array): AsyncIterable<Uint8Array> {
  for (let offset = 0; offset < bytes.length; offset += 1024 * 1024) {
    yield bytes.subarray(offset, offset + 1024 * 1024);
  }
}

describeLive("clamd limits, live (QA-054)", () => {
  test("EICAR is detected (the scanner works at all)", async () => {
    const verdict = await scanStream(chunks(new TextEncoder().encode(EICAR)), config);
    expect(verdict.kind).toBe("infected");
  }, 120_000);

  test.skipIf(!hasZip)(
    "an encrypted zip holding EICAR is not passed as clean",
    async () => {
      writeFileSync(join(scratch, "eicar.txt"), EICAR);
      spawnSync("zip", ["-q", "-P", "secret", "locked.zip", "eicar.txt"], { cwd: scratch });
      const verdict = await scanStream(chunks(readFileSync(join(scratch, "locked.zip"))), config);
      expect(verdict).toEqual({ kind: "infected", virus: expect.stringContaining("Encrypted") });
    },
    120_000,
  );

  test("a 30 MiB material is scanned, not refused for size", async () => {
    const bytes = new Uint8Array(30 * 1024 * 1024);
    for (let i = 0; i < bytes.length; i += 4096) bytes[i] = i % 251;
    const verdict = await scanStream(chunks(bytes), config);
    expect(verdict).toEqual({ kind: "clean" });
  }, 300_000);
});
