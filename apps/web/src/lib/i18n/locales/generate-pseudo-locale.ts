// Regenerates `qps-ploc.json` from `en.json` via `pseudoizeCatalog` (see pseudo-locale.ts). Loaded
// only in development (see `../i18next.ts`) so QA can switch to it and catch clipped/truncated
// strings without needing a linguist for every layout check.
//
// Run after any change to en.json: `bun run --cwd apps/web i18n:pseudo`.
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { pseudoizeCatalog } from "./pseudo-locale";

const localesDir = dirname(fileURLToPath(import.meta.url));
const en = JSON.parse(readFileSync(join(localesDir, "en.json"), "utf8")) as unknown;
const outPath = join(localesDir, "qps-ploc.json");

writeFileSync(outPath, `${JSON.stringify(pseudoizeCatalog(en), null, 2)}\n`, "utf8");
console.log(`Wrote ${outPath}`);
