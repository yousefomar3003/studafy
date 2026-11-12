import { readFileSync } from "node:fs";
import { join } from "node:path";

// eslint-disable-next-line import-x/no-unresolved -- "bun:test" is a virtual Bun built-in with no resolvable file path
import { describe, expect, test } from "bun:test";
import { Hono } from "hono";

import { corsMiddleware } from "../cors";

const ORIGIN = "https://app.example.test";

function app() {
  const hono = new Hono();
  hono.use("*", corsMiddleware({ allowedOrigins: [ORIGIN] }));
  hono.get("/json", (c) => c.json({ ok: true }));
  // A file download builds its own Response, replacing the context's.
  hono.get("/file", () => new Response("a,b\n", { headers: { "Content-Type": "text/csv" } }));
  return hono;
}

describe("corsMiddleware", () => {
  for (const path of ["/json", "/file"]) {
    test(`an allowed origin can read ${path}`, async () => {
      const res = await app().request(path, { headers: { Origin: ORIGIN } });
      expect(res.status).toBe(200);
      expect(res.headers.get("access-control-allow-origin")).toBe(ORIGIN);
      expect(res.headers.get("access-control-allow-credentials")).toBe("true");
      expect(res.headers.get("vary")).toBe("Origin");
    });
  }

  test("the preflight allows every header the web app's XHR upload sends", async () => {
    // apps/web sets these by hand on its XMLHttpRequest upload; a header missing here makes the
    // browser refuse the request before it is sent, with nothing in the API's logs.
    const source = readFileSync(
      join(import.meta.dir, "../../../../web/src/features/admin/students/queries.ts"),
      "utf8",
    );
    const sent = [...source.matchAll(/setRequestHeader\("([^"]+)"/g)].map((match) => match[1]!);
    expect(sent).toContain("X-File-Name");

    const res = await app().request("/json", {
      method: "OPTIONS",
      headers: {
        Origin: ORIGIN,
        "Access-Control-Request-Method": "POST",
        "Access-Control-Request-Headers": sent.join(",").toLowerCase(),
      },
    });
    const allowed = (res.headers.get("access-control-allow-headers") ?? "")
      .split(",")
      .map((header) => header.trim().toLowerCase());
    for (const header of sent) expect(allowed).toContain(header.toLowerCase());
  });

  test("a refused origin gets no CORS headers, even on a file", async () => {
    const res = await app().request("/file", { headers: { Origin: "https://evil.test" } });
    expect(res.status).toBe(200);
    expect(res.headers.get("access-control-allow-origin")).toBeNull();
  });
});
