import { HTTPException } from "hono/http-exception";

import type { ErrorCode } from "@studafy/constants";
import type { ContentfulStatusCode } from "hono/utils/http-status";

/** An authored, client-safe HTTP failure carrying a canonical machine-readable error code. */
export class CodedHttpException extends HTTPException {
  readonly code: ErrorCode;

  constructor(status: ContentfulStatusCode, code: ErrorCode, message: string) {
    super(status, { message });
    this.code = code;
  }
}
