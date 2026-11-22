// eslint-disable-next-line import-x/no-unresolved -- "bun:test" is a virtual Bun built-in with no resolvable file path
import { describe, expect, test } from "bun:test";

import { assembleGeneralPrompt, assembleGroundedPrompt } from "../ask/prompt";
import { PLAIN_TEXT_RULE } from "../language";

import { routingPrivacy } from "./openai-compatible";
import { createAnthropicProvider } from "./provider";

describe("routingPrivacy", () => {
  test("OpenRouter: only hosts that neither retain nor train on the data", () => {
    expect(routingPrivacy("https://openrouter.ai/api/v1")).toEqual({
      provider: { data_collection: "deny" },
    });
  });

  test("any other host gets nothing extra", () => {
    expect(routingPrivacy("https://api.together.xyz/v1")).toEqual({});
    expect(routingPrivacy("https://openrouter.ai.evil.example/v1")).toEqual({});
    expect(routingPrivacy("not a url")).toEqual({});
  });

  test("the provider sends it on every OpenRouter request", async () => {
    const bodies: Record<string, unknown>[] = [];
    const provider = createAnthropicProvider({
      apiKey: "sk-or-test",
      apiFormat: "openai-compatible",
      baseUrl: "https://openrouter.ai/api/v1",
      fetch: (async (_url: string, init: RequestInit) => {
        bodies.push(JSON.parse(String(init.body)) as Record<string, unknown>);
        return new Response(JSON.stringify({ choices: [{ message: { content: "ok" } }] }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }) as unknown as typeof fetch,
    });

    await provider.generate({ model: "google/gemma-4-31b-it", prompt: "hi" });

    expect(bodies[0]?.provider).toEqual({ data_collection: "deny" });
  });
});

describe("answers shown as written are asked for plain text", () => {
  test("grounded and general chat prompts carry the plain-text rule", () => {
    const grounded = assembleGroundedPrompt("ما هو البناء الضوئي؟", [], "b0", { language: "ar" });
    const general = assembleGeneralPrompt("ساعدني", "high", { language: "ar" }, "b0");
    expect(grounded.system).toContain(PLAIN_TEXT_RULE);
    expect(general.system).toContain(PLAIN_TEXT_RULE);
  });
});
