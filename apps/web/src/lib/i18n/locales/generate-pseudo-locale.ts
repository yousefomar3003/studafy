// Regenerates `qps-ploc.json` from the merged English catalog (`catalog.ts`) via `pseudoizeCatalog` (see pseudo-locale.ts). Loaded
// only in development (see `../i18next.ts`) so QA can switch to it and catch clipped/truncated
// strings without needing a linguist for every layout check.
//
// Run after any change to an English catalog file: `bun run --cwd apps/web i18n:pseudo`.
import { writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { enCatalog } from "./catalog";
import { pseudoizeCatalog } from "./pseudo-locale";

const localesDir = dirname(fileURLToPath(import.meta.url));
const outPath = join(localesDir, "qps-ploc.json");

writeFileSync(outPath, `${JSON.stringify(pseudoizeCatalog(enCatalog), null, 2)}\n`, "utf8");
console.log(`Wrote ${outPath}`);
