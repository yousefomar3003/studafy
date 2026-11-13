import path from "node:path";

// eslint-disable-next-line import-x/no-unresolved -- "bun:test" is a virtual Bun built-in with no resolvable file path
import { describe, expect, test } from "bun:test";

import { buildOpenApiDocument } from "./document";

/**
 * Two different Zod schemas must never share one `.openapi("Name")`.
 *
 * zod-to-openapi keeps the FIRST schema it meets under a name and silently reuses that component for
 * every later schema with the same name, so openapi.json — and every client generated from it —
 * describes only one of them. That shipped a real bug: assignments and finance expenses both named
 * their confirm body `ConfirmAttachmentBody`; the document carried the expense shape (storage_key
 * only), the mobile app's generated client therefore never sent `content_type`, and every
 * assignment attachment from the app was refused with 400 (fixed server-side in #439).
 *
 * The document cannot show a collision (only the winner is in it), so this walks zod-to-openapi's
 * own metadata registry, where every schema that called `.openapi(refId)` is recorded, renders each
 * one on its own, and requires every schema under one name to render the same.
 *
 * Variants of ONE schema are not collisions and are normalised away: `.nullable()` / `.optional()`
 * wrappers (a "null" in `type`, a `{ type: "null" }` branch), and per-use `description`, `default`,
 * `example` and `title` overrides.
 */

const honoDir = path.dirname(Bun.resolveSync("@hono/zod-openapi", import.meta.dir));
// The same module instance @hono/zod-openapi uses, so its registry is the one routes populated.
const zodToOpenApi = (await import(Bun.resolveSync("@asteasolutions/zod-to-openapi", honoDir))) as {
  zodToOpenAPIRegistry: { _map: Map<unknown, { _internal?: { refId?: string } } | undefined> };
  OpenApiGeneratorV31: new (definitions: { type: "schema"; schema: unknown }[]) => {
    generateComponents(): { components?: { schemas?: Record<string, unknown> } };
  };
};

// Importing every route module is what registers the schemas.
await buildOpenApiDocument();

const PER_USE_KEYS = new Set(["description", "default", "example", "examples", "title"]);

function withoutNull(value: unknown): unknown {
  if (Array.isArray(value)) {
    const kept = value.filter((entry) => entry !== "null" && entry !== null);
    return kept.length === 1 ? kept[0] : kept;
  }
  return value;
}

/** Canonical JSON for one rendered component, ignoring the per-use differences described above. */
function normalise(node: unknown, topLevel = false): unknown {
  if (Array.isArray(node)) return node.map((entry) => normalise(entry));
  if (node === null || typeof node !== "object") return node;
  const record = node as Record<string, unknown>;
  const out: Record<string, unknown> = {};
  for (const key of Object.keys(record).sort()) {
    if (PER_USE_KEYS.has(key)) continue;
    let value = record[key];
    if (topLevel && (key === "type" || key === "enum")) value = withoutNull(value);
    if (topLevel && key === "anyOf" && Array.isArray(value)) {
      value = value.filter(
        (branch) =>
          !(branch && typeof branch === "object" && (branch as { type?: unknown }).type === "null"),
      );
    }
    if (topLevel && key === "allOf" && Array.isArray(value)) {
      value = value.map((part) => normalise(part, true));
      out[key] = value;
      continue;
    }
    out[key] = normalise(value);
  }
  return out;
}

function render(refId: string, schema: unknown): string {
  try {
    const generator = new zodToOpenApi.OpenApiGeneratorV31([{ type: "schema", schema }]);
    const rendered = generator.generateComponents().components?.schemas?.[refId];
    return JSON.stringify(normalise(rendered, true));
  } catch (error) {
    return `unrenderable: ${(error as Error).message}`;
  }
}

describe("OpenAPI component names", () => {
  test("no two different schemas share one .openapi() name", () => {
    const variantsByName = new Map<string, Set<string>>();
    for (const [schema, metadata] of zodToOpenApi.zodToOpenAPIRegistry._map) {
      const refId = metadata?._internal?.refId;
      if (!refId) continue;
      const variants = variantsByName.get(refId) ?? new Set<string>();
      variants.add(render(refId, schema));
      variantsByName.set(refId, variants);
    }

    // Sanity: the walk saw the registry, so an empty result is a real pass and not a broken probe.
    expect(variantsByName.size).toBeGreaterThan(500);

    const collisions = [...variantsByName]
      .filter(([, variants]) => variants.size > 1)
      .map(([name]) => name)
      .sort();
    // A failure lists the names. Give each schema its own name (e.g. prefix it with its module).
    expect(collisions).toEqual([]);
  });
});
