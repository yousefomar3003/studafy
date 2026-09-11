import { authGuide } from "./auth";
import { errorsGuide } from "./errors";
import { idempotencyGuide } from "./idempotency";
import { paginationGuide } from "./pagination";

import type { Guide } from "./types";

/** Nav order is guide order — deliberately not alphabetical (auth first, errors second: every other
 * guide's examples assume the reader already has both). */
export const guides: readonly Guide[] = [authGuide, errorsGuide, idempotencyGuide, paginationGuide];

export type { Guide, GuideSection, CodeBlock, ApiExampleRef, HttpMethod } from "./types";
