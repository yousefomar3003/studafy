import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, test } from "bun:test";

import { checksum, discoverMigrations } from "../src/discovery";

const directories: string[] = [];

async function fixture(files: Record<string, string>): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "studafy-migrations-"));
  directories.push(directory);
  await Promise.all(
    // Test filenames are fixed fixture input written only beneath the fresh temporary directory.
    // eslint-disable-next-line security/detect-non-literal-fs-filename
    Object.entries(files).map(([name, contents]) => writeFile(join(directory, name), contents)),
  );
  return directory;
}

afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true })));
});

describe("migration discovery", () => {
  test("orders six-digit versions and calculates deterministic SHA-256 checksums", async () => {
    const directory = await fixture({
      "000002_second.sql": "SELECT 2;\n",
      "000001_first.sql": "SELECT 1;\n",
    });
    const migrations = await discoverMigrations(directory);
    expect(migrations.map(({ filename }) => filename)).toEqual([
      "000001_first.sql",
      "000002_second.sql",
    ]);
    expect(migrations[0]?.checksum).toBe(checksum(Buffer.from("SELECT 1;\n")));
  });

  test("rejects invalid filenames and duplicate canonical names", async () => {
    await expect(discoverMigrations(await fixture({ "1_bad.sql": "SELECT 1;" }))).rejects.toThrow(
      "Invalid migration filename",
    );
    await expect(
      discoverMigrations(
        await fixture({
          "000001_same.sql": "SELECT 1;",
          "000002_same.sql": "SELECT 2;",
        }),
      ),
    ).rejects.toThrow("Duplicate migration name");
  });

  test("recognizes only the explicit non-transactional directive", async () => {
    const migrations = await discoverMigrations(
      await fixture({
        "000001_transactional.sql": "SELECT 1;",
        "000002_concurrent_index.sql":
          "-- studafy:migration transaction=off\nCREATE INDEX CONCURRENTLY idx_x ON x(id);",
      }),
    );
    expect(migrations.map(({ transactional }) => transactional)).toEqual([true, false]);
    await expect(
      discoverMigrations(
        await fixture({
          "000003_bad_directive.sql": "-- studafy:migration transaction=no\nSELECT 1;",
        }),
      ),
    ).rejects.toThrow("unsupported migration directive");
  });
});
