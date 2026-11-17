/**
 * QA-072: on fly.io, the unauthenticated Prometheus endpoint listens on the private network only.
 *
 * Every app in a fly organisation shares one private network (6PN). The metrics endpoint has no
 * auth, so it binds `fly-local-6pn` (the machine's 6PN address, where fly's scraper reaches it)
 * rather than every interface. Moving Studafy into an organisation of its own, so that no unrelated
 * app shares that network, is the human half: docs/runbooks/fly-org-migration.md.
 */

import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

// eslint-disable-next-line import-x/no-unresolved -- "bun:test" is a virtual Bun built-in with no resolvable file path
import { describe, expect, test } from "bun:test";

const root = join(import.meta.dir, "../../..");
const flyDir = join(root, "infra/fly");
const configs = readdirSync(flyDir).filter((name) => name.endsWith(".toml"));

describe("fly private network (QA-072)", () => {
  const withMetrics = configs.filter((name) =>
    /^\[metrics\]/m.test(readFileSync(join(flyDir, name), "utf8")),
  );

  test("the api, realtime and workers apps export metrics", () => {
    expect(withMetrics.sort()).toEqual(["api.toml", "realtime.toml", "workers.toml"]);
  });

  for (const name of withMetrics) {
    test(`${name} binds its metrics endpoint to the private network address`, () => {
      const text = readFileSync(join(flyDir, name), "utf8");
      const env = /^\[env\]\n([\s\S]*?)(?=^\[)/m.exec(text)?.[1] ?? "";
      expect(env).toMatch(/^\s*METRICS_HOST = "fly-local-6pn"$/m);
    });
  }

  for (const app of ["api", "realtime", "workers"]) {
    test(`apps/${app} passes METRICS_HOST to the metrics server`, () => {
      const source = readFileSync(join(root, `apps/${app}/src/index.ts`), "utf8");
      expect(source).toMatch(/startMetricsServer\(\{[^}]*host: env\.METRICS_HOST/);
    });
  }
});
