/**
 * Errors the AI-ingestion parsers raise, distinguished by the reason they should write into
 * `app.materials.ingest_error`.
 *
 * `reason` is deliberately a short, stable, human-readable string — it becomes the material's
 * `ingest_error`, which the schema constrains to a non-empty trimmed string, and it is what a
 * support agent or a later re-ingestion tool will see. The subclass is what lets the worker decide
 * between a corrupt file and an unsupported format without parsing messages.
 */
export class MaterialParseError extends Error {
  readonly reason: string;

  constructor(reason: string, message?: string) {
    super(message ?? reason);
    this.name = new.target.name;
    this.reason = reason;
  }
}

/** The MIME type is not one the ingestion pipeline can parse. */
export class UnsupportedFormatError extends MaterialParseError {
  constructor(reason: string, message?: string) {
    super(reason, message);
  }
}

/** The bytes were not a well-formed document of the claimed type. */
export class CorruptDocumentError extends MaterialParseError {
  constructor(reason: string, message?: string) {
    super(reason, message);
  }
}

/** The document parsed but yielded no extractable text. */
export class EmptyDocumentError extends MaterialParseError {
  constructor(reason: string, message?: string) {
    super(reason, message);
  }
}

/** The document is encrypted and no password was supplied. */
export class EncryptedDocumentError extends MaterialParseError {
  constructor(reason: string, message?: string) {
    super(reason, message);
  }
}
