#!/usr/bin/env bun
/**
 * Runs `eslint --fix` over staged files the way `turbo lint` runs it: once per workspace package,
 * from inside that package.
 *
 * ## Why this exists
 *
 * `eslint` resolves imports relative to its own working directory, and every workspace package
 * here carries its own `tsconfig.json` (`apps/workers/tsconfig.json` extends
 * `@studafy/tsconfig/api.json`, and so on). There is no root `tsconfig.json` at all. So a single
 * root-level `eslint --fix` over a list of staged paths does not see what `eslint .` sees when
 * `turbo lint` runs it inside the package — and the two disagree, in a way that is not cosmetic.
 *
 * The concrete case that forced this (ST-290): Bun's virtual builtins (`bun:test` and friends) have
 * no on-disk entry point. From a package cwd they are unresolvable, so every workers test file
 * carries an `// eslint-disable-next-line import-x/no-unresolved` comment and `import-x/order`
 * groups `bun:test` alongside the `@studafy/*` imports. From the root cwd they resolve, so
 * `import-x/order` files them as *builtins* — first, in their own group — and the disable comment
 * reads as unused, which `--fix` then deletes. The upshot was a pre-commit hook that rewrote
 * already-CI-clean files into a shape `turbo lint` rejects, and no file content could satisfy both.
 *
 * Sharding by package makes the hook agree with CI by construction rather than by coincidence.
 *
 * ## Contract
 *
 * Invoked by `lint-staged.config.js` with the staged file paths as arguments, from the repo root.
 * Files outside `apps/*` / `packages/*` (root config files, `scripts/`) are linted from the root,
 * which is also where `turbo lint` has no package to run them in. Exits non-zero if any group
 * fails, after running all of them, so one package's errors do not hide another's.
 */

import { existsSync } from "node:fs";
import { relative, resolve, sep } from "node:path";

const ROOT = process.cwd();

/**
 * The node-launched eslint binary, deliberately not `bunx --bun eslint`: under the Bun runtime
 * `bun:test` becomes a resolvable builtin of the running process, which is the very difference in
 * `import-x` classification this script exists to avoid. `turbo lint` runs each package's
 * `eslint .` under node, so this must too.
 */
const ESLINT = ["eslint.exe", "eslint.cmd", "eslint"]
  .map((name) => resolve(ROOT, "node_modules", ".bin", name))
  .find((candidate) => existsSync(candidate));

if (!ESLINT) {
  console.error("eslint-staged: no eslint binary in node_modules/.bin - run `bun install`");
  process.exit(1);
}

/** The workspace package owning `file`, per the root package.json "workspaces" globs. */
const packageFor = (file: string): string => {
  const [group, name] = relative(ROOT, resolve(file)).split(sep);
  return (group === "apps" || group === "packages") && name ? `${group}/${name}` : ".";
};

const files = process.argv.slice(2);
if (files.length === 0) process.exit(0);

const byPackage = new Map<string, string[]>();
for (const file of files) {
  const pkg = packageFor(file);
  const bucket = byPackage.get(pkg);
  if (bucket) bucket.push(file);
  else byPackage.set(pkg, [file]);
}

let failed = false;
for (const [pkg, pkgFiles] of byPackage) {
  const cwd = resolve(ROOT, pkg);
  const { exited } = Bun.spawn({
    cmd: [ESLINT, "--fix", ...pkgFiles.map((file) => relative(cwd, file))],
    cwd,
    stdout: "inherit",
    stderr: "inherit",
  });
  if ((await exited) !== 0) failed = true;
}

process.exit(failed ? 1 : 0);
