/**
 * Assemble the OCR runtime assets next to an app's bundle. Run from the app's directory with its
 * dist directory as the argument (`bun ../../packages/ocr/scripts/build-assets.ts dist`):
 *
 *   dist/index.js              the app's main bundle (from its own `bun run build`)
 *   dist/ocr/index.js          tesseract worker-script bundle
 *   dist/ocr/tesseract-core-*.wasm   the WASM cores the worker-script loads, resolved relative to
 *                                    its own __dirname — hence next to it, never in node_modules
 *   dist/traineddata/*.traineddata   the OCR languages, resolved by the engine's default langPath
 *                                    (`new URL("./traineddata/", import.meta.url)` of the bundled
 *                                    main module), hence at dist/, not dist/ocr/
 *
 * A runtime image ships only the app's dist/ (no node_modules), so every asset tesseract.js would
 * normally resolve from packages must be here. The image points the engine's workerPath at
 * dist/ocr/index.js (OCR_WORKER_PATH).
 */
/* eslint-disable security/detect-non-literal-fs-filename -- build script; every path derives from resolution or the caller's argument, never user input */
import { copyFileSync, mkdirSync, readdirSync, realpathSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";

const target = process.argv[2];
if (!target) throw new Error("usage: build-assets.ts <dist directory>");
const distDir = resolve(process.cwd(), target);

const require = createRequire(join(import.meta.dir, "..", "package.json"));

function assertDir(path: string): string {
  readdirSync(path); // throws if missing — fail loudly, a silently missing core is a runtime crash
  return path;
}

const tesseractRoot = dirname(dirname(realpathSync(require.resolve("tesseract.js")))); // .../src/index.js -> package root

function resolveCoreDir(): string {
  try {
    return assertDir(dirname(require.resolve("tesseract.js-core")));
  } catch {
    // tesseract.js-core is tesseract.js's own dependency, not ours; with isolated installs it is a
    // sibling of tesseract.js rather than resolvable from this package.
    return assertDir(join(dirname(tesseractRoot), "tesseract.js-core"));
  }
}

const workerDist = join(distDir, "ocr");
const traineddataDist = join(distDir, "traineddata");
mkdirSync(workerDist, { recursive: true });
mkdirSync(traineddataDist, { recursive: true });

const bundled = await Bun.build({
  entrypoints: [join(tesseractRoot, "src", "worker-script", "node", "index.js")],
  outdir: workerDist,
  target: "bun",
});
if (!bundled.success)
  throw new AggregateError(bundled.logs, "tesseract worker-script bundle failed");

const coreDir = resolveCoreDir();
const wasmFiles = readdirSync(coreDir)
  .filter((file) => file.startsWith("tesseract-core") && file.endsWith(".wasm"))
  .map((file) => {
    copyFileSync(join(coreDir, file), join(workerDist, file));
    return file;
  });
if (wasmFiles.length === 0)
  throw new Error("no tesseract-core WASM files found in the tesseract.js-core package");

const traineddataSrc = join(import.meta.dir, "..", "src", "traineddata");
const traineddataFiles = readdirSync(traineddataSrc)
  .filter((file) => file.endsWith(".traineddata"))
  .map((file) => {
    copyFileSync(join(traineddataSrc, file), join(traineddataDist, file));
    return file;
  });
if (traineddataFiles.length === 0)
  throw new Error("no traineddata found in packages/ocr/src/traineddata");

console.log(
  `bundled the worker-script and copied ${wasmFiles.length} wasm cores to ${workerDist}, ` +
    `${traineddataFiles.length} traineddata files to ${traineddataDist}`,
);
