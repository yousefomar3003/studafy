import { ERROR_CODES } from "@studafy/constants";
// eslint-disable-next-line import-x/no-unresolved -- "bun:test" is a virtual Bun built-in with no resolvable file path
import { describe, expect, test } from "bun:test";
import { Hono } from "hono";

import { createApp } from "../app";
import { createInflightTracker } from "../lifecycle";
import { createLogger } from "../logger";

import { parseAcceptLanguage, getLocalizedMessage, type SupportedLocale } from "./locale";

import type { AppEnv } from "./requestId";
import type { ErrorCode } from "@studafy/constants";

const buildApp = (routes?: (app: Hono<AppEnv>) => void) => {
  const lines: string[] = [];
  const app = createApp({
    isReady: () => true,
    tracker: createInflightTracker(),
    logger: createLogger({ destination: (line) => lines.push(line) }),
  });
  routes?.(app);
  return { app, lines };
};

describe("parseAcceptLanguage", () => {
  test("returns 'en' for undefined header", () => {
    expect(parseAcceptLanguage(undefined)).toBe("en");
  });

  test("returns 'en' for empty string", () => {
    expect(parseAcceptLanguage("")).toBe("en");
  });

  test("parses simple language code", () => {
    expect(parseAcceptLanguage("ar")).toBe("ar");
  });

  test("parses language with quality factor", () => {
    expect(parseAcceptLanguage("ar;q=0.9")).toBe("ar");
  });

  test("parses multiple languages and picks highest quality", () => {
    expect(parseAcceptLanguage("fr,ar;q=0.9,en;q=0.8")).toBe("ar");
  });

  test("falls back to English for unsupported language", () => {
    expect(parseAcceptLanguage("fr-FR,fr;q=0.9")).toBe("en");
  });

  test("handles complex Accept-Language header", () => {
    expect(parseAcceptLanguage("ar-SA,ar;q=0.9,en-US;q=0.8,en;q=0.7")).toBe("ar");
  });

  test("handles malformed quality factor gracefully", () => {
    expect(parseAcceptLanguage("ar;q=invalid")).toBe("en");
  });

  test("handles extra whitespace", () => {
    expect(parseAcceptLanguage("  ar , en;q=0.9  ")).toBe("ar");
  });
});

describe("getLocalizedMessage", () => {
  test("returns English message for AUTH_INVALID_CREDENTIALS", () => {
    const message = getLocalizedMessage(ERROR_CODES.AUTH_INVALID_CREDENTIALS, "en");
    expect(message).toBe("Invalid credentials provided");
  });

  test("returns Arabic message for AUTH_INVALID_CREDENTIALS", () => {
    const message = getLocalizedMessage(ERROR_CODES.AUTH_INVALID_CREDENTIALS, "ar");
    expect(message).toBe("بيانات الاعتماد غير صالحة");
  });

  test("falls back to English for unsupported locale", () => {
    const message = getLocalizedMessage(
      ERROR_CODES.AUTH_INVALID_CREDENTIALS,
      "fr" as SupportedLocale,
    );
    expect(message).toBe("Invalid credentials provided");
  });

  test("returns error code as fallback if message not found", () => {
    const message = getLocalizedMessage("UNKNOWN_CODE" as ErrorCode, "en");
    expect(message).toBe("UNKNOWN_CODE");
  });

  test("returns localized messages for all error codes", () => {
    const errorCodes = Object.values(ERROR_CODES) as ErrorCode[];
    for (const code of errorCodes) {
      const enMessage = getLocalizedMessage(code, "en");
      const arMessage = getLocalizedMessage(code, "ar");
      expect(enMessage).toBeTruthy();
      expect(arMessage).toBeTruthy();
      expect(enMessage).not.toBe(arMessage);
    }
  });
});

describe("locale middleware integration", () => {
  test("sets locale to 'en' when Accept-Language header is missing", async () => {
    const { app } = buildApp((a) => {
      a.get("/locale", (c) => c.json({ locale: c.get("locale") }));
    });

    const res = await app.request("/locale");
    const body = (await res.json()) as { locale: string };

    expect(body.locale).toBe("en");
  });

  test("sets locale to 'ar' when Accept-Language header is 'ar'", async () => {
    const { app } = buildApp((a) => {
      a.get("/locale", (c) => c.json({ locale: c.get("locale") }));
    });

    const res = await app.request("/locale", {
      headers: { "Accept-Language": "ar" },
    });
    const body = (await res.json()) as { locale: string };

    expect(body.locale).toBe("ar");
  });

  test("sets locale to 'ar' when Accept-Language header is 'ar,en;q=0.9'", async () => {
    const { app } = buildApp((a) => {
      a.get("/locale", (c) => c.json({ locale: c.get("locale") }));
    });

    const res = await app.request("/locale", {
      headers: { "Accept-Language": "ar,en;q=0.9" },
    });
    const body = (await res.json()) as { locale: string };

    expect(body.locale).toBe("ar");
  });

  test("returns localized error message for 404", async () => {
    const { app } = buildApp();

    const res = await app.request("/nonexistent", {
      headers: { "Accept-Language": "ar" },
    });
    const body = (await res.json()) as { code: string; detail: string };

    expect(res.status).toBe(404);
    expect(body.code).toBe("RESOURCE_NOT_FOUND");
    expect(body.detail).toContain("لم يتم العثور على المورد");
  });

  test("returns English error message when Accept-Language is 'en'", async () => {
    const { app } = buildApp();

    const res = await app.request("/nonexistent", {
      headers: { "Accept-Language": "en" },
    });
    const body = (await res.json()) as { code: string; detail: string };

    expect(res.status).toBe(404);
    expect(body.code).toBe("RESOURCE_NOT_FOUND");
    expect(body.detail).toContain("Resource not found");
  });

  test("500 errors do not expose detail to the client", async () => {
    const { app } = buildApp((a) => {
      a.get("/forbidden", () => {
        throw new Error("Forbidden");
      });
    });

    const res = await app.request("/forbidden", {
      headers: { "Accept-Language": "ar" },
    });
    const body = (await res.json()) as { code: string; detail: string };

    expect(res.status).toBe(500);
    expect(body.code).toBe("INTERNAL_ERROR");
    expect(body.detail).toBeUndefined();
  });
});
