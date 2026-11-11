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

  test("a refused origin gets no CORS headers, even on a file", async () => {
    const res = await app().request("/file", { headers: { Origin: "https://evil.test" } });
    expect(res.status).toBe(200);
    expect(res.headers.get("access-control-allow-origin")).toBeNull();
  });
});
