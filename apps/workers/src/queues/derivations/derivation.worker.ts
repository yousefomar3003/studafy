/**
 * Material thumbnail + first-page preview derivation (derivations queue).
 *
 * Consumes one job per clean material, enqueued by the file-scan worker the moment a material is
 * flipped to `ready`. The worker reads the material's bytes from S3, derives JPEGs, writes them
 * under `permanent/<schoolId>/<materialId>/`, and records the keys on `app.materials`:
 *
 *   raster (png/jpeg/bmp)  — a fit-within-320px thumbnail; the original is already the preview.
 *   pdf                    — page 1 rendered at scale 2, from which both a fit-within-320px
 *                            thumbnail and a fit-within-1280px preview are derived.
 *   anything else (pptx, docx, tiff, …) — no image; `thumbnail_key`/`preview_key` stay NULL.
 *
 * ## Why the status/key guards are the claim
 *
 * The worker only derives a material that is `ready` (a clean scan verdict) and whose
 * `thumbnail_key` is still NULL. A duplicate or retried job therefore either re-derives the same
 * bytes into the same keys (a harmless overwrite) or — after the keys are written — becomes a
 * no-op. BullMQ's at-least-once delivery would otherwise double the S3 writes and the DB write.
 *
 * ## Graceful degradation is the NULL key
 *
 * The material list shows a per-type icon whenever `thumbnail_key` is NULL. That makes every
 * failure mode of this worker non-blocking by construction: an unsupported type, a corrupt source,
 * a missing object, or an oversized object all end with NULL keys and the icon, never with a failed
 * material. Only transient infrastructure errors (S3/DB/network) are thrown so BullMQ retries
 * them; content errors are per-material and immutable, so retrying them would only burn the
 * attempt budget. The original object is never modified — only read.
 */

import { createCanvas, loadImage } from "@napi-rs/canvas";
import postgres from "postgres";
import { getDocumentProxy, renderPageAsImage } from "unpdf";

import { withSystemTenantTx } from "../../db/tenant-tx";

import { deriveMaterialJobDataSchema } from "./job";

import type { DerivationS3Client } from "./s3";
import type { Image } from "@napi-rs/canvas";
import type { Job } from "bullmq";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface MaterialDerivationConfig {
  databaseUrl: string;
  databaseCaCert?: string;
  s3: DerivationS3Client | null;
  bucket?: string;
}

export type DerivationResult =
  { processed: true; outcome: "generated" | "skipped" } | { processed: false; reason: string };

interface MaterialDerivationRow {
  storage_key: string;
  mime_type: string;
  ingest_status: string;
  thumbnail_key: string | null;
  preview_key: string | null;
}

interface DerivedArtifacts {
  thumbnail: Uint8Array;
  /** NULL for rasters: the original object is already the preview. */
  preview: Uint8Array | null;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const THUMBNAIL_MAX_DIM = 320;
const PREVIEW_MAX_DIM = 1280;
const JPEG_QUALITY = 0.8;
// Buffering the whole source is unavoidable (image decode and PDF render both need it), so the
// cap mirrors CLAMAV_MAX_FILE_BYTES: anything a scan would not stream is not worth rasterizing.
const MAX_SOURCE_BYTES = 25 * 1024 * 1024;

const PDF_MIME_TYPES = new Set(["application/pdf", "application/x-pdf", "text/pdf"]);
// Rasters the @napi-rs/canvas rasterizer can decode. TIFF is deliberately absent: skia has no
// verified TIFF decoder, so it degrades to the type icon like any unsupported type.
const RASTER_MIME_TYPES = new Set(["image/png", "image/jpeg", "image/bmp"]);

// ---------------------------------------------------------------------------
// Keys
// ---------------------------------------------------------------------------

/**
 * The derived-image keys. The material's own key is `permanent/<schoolId>/materials/<slug>`, so the
 * derived images use the material id as the object id — a uuid is a safe key segment and is unique
 * where the original's filename slug is not. This stays inside the canonical
 * `<category>/<schoolId>/<objectId>/<filename>` scheme, and the daily storage reconciliation counts
 * them like any permanent content.
 */
export function thumbnailKeyOf(schoolId: string, materialId: string): string {
  return `permanent/${schoolId}/${materialId}/thumbnail.jpg`;
}

export function previewKeyOf(schoolId: string, materialId: string): string {
  return `permanent/${schoolId}/${materialId}/preview.jpg`;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * A condition that will never change for this material, so the job must not retry it: the source is
 * unsupported, corrupt, missing, or too large to buffer. Thrown only after the material row was
 * claimed, so it always resolves to a graceful NULL-key skip rather than a failed material.
 */
class DerivationSkipError extends Error {
  constructor(reason: string) {
    super(reason);
    this.name = "DerivationSkipError";
  }
}

function isNotFound(error: unknown): boolean {
  return (error as { $metadata?: { httpStatusCode?: number } }).$metadata?.httpStatusCode === 404;
}

/** Read an object's bytes, bounding memory with MAX_SOURCE_BYTES. An oversized object is a skip. */
async function readObject(
  s3: DerivationS3Client,
  bucket: string,
  key: string,
): Promise<Uint8Array> {
  let response;
  try {
    response = await s3.getObject({ Bucket: bucket, Key: key });
  } catch (error) {
    if (isNotFound(error)) throw new DerivationSkipError("source object is missing");
    throw error;
  }
  const body = response.Body;
  if (!body) throw new Error("object body is not streamable");

  const parts: Uint8Array[] = [];
  let total = 0;
  for await (const part of body) {
    total += part.byteLength;
    if (total > MAX_SOURCE_BYTES)
      throw new DerivationSkipError("source exceeds derivation size limit");
    parts.push(part);
  }

  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const part of parts) {
    bytes.set(part, offset);
    offset += part.byteLength;
  }
  return bytes;
}

/**
 * Scale a decoded image down to fit within `maxDimension`, preserving aspect ratio (never upscaling),
 * and encode it as a JPEG on a white background. JPEG has no alpha channel, so transparency is
 * flattened before encode — for both rasters and rendered PDF pages.
 */
function encodeJpeg(source: Image, maxDimension: number): Uint8Array {
  if (source.width <= 0 || source.height <= 0) {
    throw new DerivationSkipError("source image has no dimensions");
  }
  const scale = Math.min(1, maxDimension / Math.max(source.width, source.height));
  const width = Math.max(1, Math.round(source.width * scale));
  const height = Math.max(1, Math.round(source.height * scale));

  const canvas = createCanvas(width, height);
  const ctx = canvas.getContext("2d");
  ctx.fillStyle = "white";
  ctx.fillRect(0, 0, width, height);
  ctx.drawImage(source, 0, 0, width, height);
  return new Uint8Array(canvas.toBuffer("image/jpeg", JPEG_QUALITY));
}

// Exported for the no-database rasterizer tests; the worker's own dispatch stays private.
export async function deriveRaster(bytes: Uint8Array): Promise<DerivedArtifacts> {
  let image: Image;
  try {
    image = await loadImage(bytes);
  } catch {
    throw new DerivationSkipError("raster could not be decoded");
  }
  return { thumbnail: encodeJpeg(image, THUMBNAIL_MAX_DIM), preview: null };
}

export async function derivePdf(bytes: Uint8Array): Promise<DerivedArtifacts> {
  let proxy: Awaited<ReturnType<typeof getDocumentProxy>>;
  try {
    proxy = await getDocumentProxy(bytes);
  } catch {
    throw new DerivationSkipError("file is not a valid PDF");
  }

  try {
    // One render at scale 2 feeds both outputs, so a PDF never pays for the page twice. The render
    // path is the one parsers/pdf.ts already proves: unpdf's renderPageAsImage over @napi-rs/canvas.
    const rendered = await renderPageAsImage(proxy, 1, {
      canvasImport: () => import("@napi-rs/canvas"),
      scale: 2,
    });
    let image: Image;
    try {
      image = await loadImage(new Uint8Array(rendered));
    } catch {
      throw new DerivationSkipError("first page could not be decoded");
    }
    return {
      thumbnail: encodeJpeg(image, THUMBNAIL_MAX_DIM),
      preview: encodeJpeg(image, PREVIEW_MAX_DIM),
    };
  } finally {
    await proxy.loadingTask.destroy();
  }
}

/**
 * Derive the artifacts for a material, or return null for a type this worker does not rasterize.
 * Dispatch is by the stored MIME type — the same untrusted-input policy the ingestion parsers use:
 * never by file extension.
 */
async function deriveFromSource(
  s3: DerivationS3Client,
  bucket: string,
  material: MaterialDerivationRow,
): Promise<DerivedArtifacts | null> {
  if (PDF_MIME_TYPES.has(material.mime_type)) {
    return derivePdf(await readObject(s3, bucket, material.storage_key));
  }
  if (RASTER_MIME_TYPES.has(material.mime_type)) {
    return deriveRaster(await readObject(s3, bucket, material.storage_key));
  }
  return null;
}

// ---------------------------------------------------------------------------
// Processor
// ---------------------------------------------------------------------------

/**
 * Process one `derive-material-previews` job.
 *
 * `config` is injected rather than read from the environment, so the processor is callable from a
 * test against a disposable database and an in-memory fake S3 — the shape processMaterialScan
 * establishes. Throws only for transient infrastructure errors (BullMQ retries those); everything
 * content-shaped resolves to a skip and leaves the material's keys NULL.
 */
export async function processMaterialDerivation(
  job: Job,
  config: MaterialDerivationConfig,
): Promise<DerivationResult> {
  const parsed = deriveMaterialJobDataSchema.safeParse(job.data);
  if (!parsed.success) return { processed: false, reason: "invalid job data" };
  const { schoolId, materialId } = parsed.data;

  if (!config.s3 || !config.bucket) throw new Error("derivation storage is not configured");

  const sql = postgres(config.databaseUrl, {
    max: 2,
    idle_timeout: 20,
    prepare: false,
    ...(config.databaseCaCert
      ? { ssl: { ca: config.databaseCaCert, rejectUnauthorized: true } }
      : {}),
  });

  try {
    const material = await withSystemTenantTx(sql, { schoolId }, async (tx) => {
      const [row] = await tx<MaterialDerivationRow[]>`
        SELECT storage_key, mime_type, ingest_status::text AS ingest_status,
               thumbnail_key, preview_key
        FROM app.materials
        WHERE id = ${materialId}::uuid AND school_id = ${schoolId}::uuid
      `;
      return row;
    });

    // Not ready (not yet scanned, quarantined, failed) or already derived: nothing to do. The
    // "not ready" case is the claim being lost — a duplicate enqueue racing the scan verdict —
    // and the "keys set" case is the dedup working.
    if (!material || material.ingest_status !== "ready") {
      return { processed: true, outcome: "skipped" };
    }
    if (material.thumbnail_key !== null || material.preview_key !== null) {
      return { processed: true, outcome: "skipped" };
    }

    const derived = await deriveFromSource(config.s3, config.bucket, material);
    if (derived === null) {
      // Not a type we rasterize (pptx, docx, tiff, …). Keys stay NULL: the list shows the icon.
      return { processed: true, outcome: "skipped" };
    }

    const thumbnailKey = thumbnailKeyOf(schoolId, materialId);
    const previewKey = derived.preview === null ? null : previewKeyOf(schoolId, materialId);

    await Promise.all([
      config.s3.putObject({
        Bucket: config.bucket,
        Key: thumbnailKey,
        Body: derived.thumbnail,
        ContentType: "image/jpeg",
      }),
      ...(derived.preview
        ? [
            config.s3.putObject({
              Bucket: config.bucket,
              Key: previewKey as string,
              Body: derived.preview,
              ContentType: "image/jpeg",
            }),
          ]
        : []),
    ]);

    // Guarded by the same NULL check that claimed the material, so a concurrent duplicate becomes
    // a no-op rather than overwriting a finished run. The write is transactional with the row's
    // RLS context (SET LOCAL ROLE studafy_admin), like every other material flip.
    await withSystemTenantTx(sql, { schoolId }, async (tx) => {
      await tx`
        UPDATE app.materials
        SET thumbnail_key = ${thumbnailKey},
            preview_key = ${previewKey},
            updated_at = clock_timestamp()
        WHERE id = ${materialId}::uuid AND school_id = ${schoolId}::uuid
          AND thumbnail_key IS NULL AND preview_key IS NULL
      `;
    });

    return { processed: true, outcome: "generated" };
  } catch (error) {
    if (error instanceof DerivationSkipError) {
      return { processed: true, outcome: "skipped" };
    }
    throw error;
  } finally {
    await sql.end({ timeout: 5 });
  }
}
