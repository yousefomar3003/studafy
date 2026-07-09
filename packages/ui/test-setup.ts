import { cleanup } from "@testing-library/react";
// eslint-disable-next-line import-x/no-unresolved -- "bun:test" is a virtual Bun built-in with no resolvable file path
import { afterEach } from "bun:test";

/**
 * Testing Library auto-registers `afterEach(cleanup)` only when it finds a Jest/Vitest global.
 * Under bun:test it finds nothing, so we register it once here. Without this, portalled Modal and
 * Toast nodes accumulate on document.body and later tests match stale DOM.
 *
 * Loaded after happydom.ts (see bunfig.toml) — Testing Library needs `document` at import time.
 */
afterEach(cleanup);
