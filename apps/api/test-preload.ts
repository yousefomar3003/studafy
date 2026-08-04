/**
 * Loaded before every `bun test` file in this package.
 *
 * `@hono/zod-openapi`'s import side effect calls extendZodWithOpenApi on the shared `zod`
 * prototype. zod v4 copies prototype methods onto each schema instance at construction time, so a
 * schema built by @studafy/shared-schemas only carries `.openapi()` if the extension ran first.
 * bun test evaluates a module once per process and whichever test file first imports
 * @studafy/shared-schemas decides for the whole run — so importing it here guarantees the patch
 * is in place before any test file, or any of its imports, can construct a schema.
 */
import "@hono/zod-openapi";
