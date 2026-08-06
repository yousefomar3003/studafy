/**
 * Assemble the OCR runtime assets next to the workers bundle (`dist/`):
 *
 *   dist/index.js              the main bundle (from `bun run build`)
 *   dist/ocr/index.js          tesseract worker-script bundle (from `bun run build:ocr`)
 *   dist/ocr/tesseract-core-*.wasm   the WASM cores the worker-script loads, resolved relative to
 *                                    its own __dirname — hence next to it, never in node_modules
 *   dist/traineddata/*.traineddata   the OCR languages, resolved by the engine's default langPath
 *                                    (`new URL("./traineddata/", import.meta.url)` of the bundled
 *                                    main module), hence at dist/, not dist/ocr/
 *
 * The production image copies only apps/workers/dist (see infra/docker/workers.Dockerfile); there
 * is no node_modules, so every tesseract asset tesseract.js would normally pull from packages must
 * be in place here. Run as `bun run build:ocr` from apps/workers.
 */
/* eslint-disable security/detect-non-literal-fs-filename -- build script; every path derives from resolution, never user input */
import { copyFileSync, mkdirSync, readdirSync, realpathSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";

const require = createRequire(join(import.meta.dir, "..", "package.json"));
const distDir = join(import.meta.dir, "..", "dist");

function assertDir(path: string): string {
  readdirSync(path); // throws if missing — fail loudly, a silently missing core is a runtime crash
  return path;
}

/**
 * The tesseract.js-core package directory, wherever Bun hoisted it: directly reachable from
 * apps/workers when it is a top-level dependency, or nested under the realpath of tesseract.js in
 * the `.bun` install store (a Bun workspace layout, verified at build time).
 */
function resolveCoreDir(): string {
  try {
    return assertDir(dirname(require.resolve("tesseract.js-core")));
  } catch {
    // tesseract.js is the dependency that declares tesseract.js-core, so resolve it and walk to
    // the sibling node_modules the Bun install store keeps — dependencies of a hoisted package sit
    // in the same node_modules/ dir as the package itself
    // (node_modules/.bun/tesseract.js@7.0.0/node_modules/{tesseract.js,tesseract.js-core}).
    const tesseractIndex = realpathSync(require.resolve("tesseract.js"));
    const tesseractRoot = dirname(dirname(tesseractIndex)); // .../tesseract.js/src/index.js -> package root
    const sibling = join(dirname(tesseractRoot), "tesseract.js-core");
    return assertDir(sibling);
  }
}

const coreDir = resolveCoreDir();
const workerDist = join(distDir, "ocr");
const traineddataDist = join(distDir, "traineddata");
mkdirSync(workerDist, { recursive: true });
mkdirSync(traineddataDist, { recursive: true });

const wasmCount = readdirSync(coreDir)
  .filter((file) => file.startsWith("tesseract-core") && file.endsWith(".wasm"))
  .map((file) => {
    copyFileSync(join(coreDir, file), join(workerDist, file));
    return file;
  });
if (wasmCount.length === 0)
  throw new Error("no tesseract-core WASM files found in the tesseract.js-core package");

const traineddataSrc = join(
  import.meta.dir,
  "..",
  "src",
  "queues",
  "ai-ingestion",
  "ocr",
  "traineddata",
);
const traineddataCount = readdirSync(traineddataSrc)
  .filter((file) => file.endsWith(".traineddata"))
  .map((file) => {
    copyFileSync(join(traineddataSrc, file), join(traineddataDist, file));
    return file;
  });
if (traineddataCount.length === 0)
  throw new Error("no traineddata found in src/queues/ai-ingestion/ocr/traineddata");

console.log(
  `copied ${wasmCount.length} wasm cores to dist/ocr/ and ${traineddataCount.length} traineddata files to dist/traineddata/`,
);
