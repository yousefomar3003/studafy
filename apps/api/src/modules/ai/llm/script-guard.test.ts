// eslint-disable-next-line import-x/no-unresolved -- "bun:test" is a virtual Bun built-in with no resolvable file path
import { describe, expect, test } from "bun:test";

import { containsCjk, stripCjk, withScriptGuard } from "./script-guard";

import type { LlmGenerateInput, LlmProvider, LlmStreamEvent } from "./provider";

// Built from code points so the test reads the same in any editor.
const XUEXI = String.fromCodePoint(0x5b66, 0x4e60); // "study" in Chinese
const IDEOGRAPHIC_FULL_STOP = String.fromCodePoint(0x3002);
const FULLWIDTH_COMMA = String.fromCodePoint(0xff0c);
const ARABIC = "التمثيل الضوئي";

const usage = { inputTokens: 10, outputTokens: 5, totalTokens: 15 };

function fakeProvider(deltas: string[]): LlmProvider {
  const full = deltas.join("");
  return {
    generate: async () => ({ content: full, model: "m", usage, stopReason: "stop" }),
    async *stream() {
      let text = "";
      for (const delta of deltas) {
        text += delta;
        yield { type: "delta", delta, text } satisfies LlmStreamEvent;
      }
      yield { type: "done", text: full, usage, stopReason: "stop", model: "m" };
    },
  };
}

const input = (prompt: string): LlmGenerateInput => ({ model: "m", prompt, system: "Be helpful." });

async function collect(stream: AsyncGenerator<LlmStreamEvent>): Promise<LlmStreamEvent[]> {
  const events: LlmStreamEvent[] = [];
  for await (const event of stream) events.push(event);
  return events;
}

describe("stripCjk", () => {
  test("drops Chinese characters and keeps Arabic and English", () => {
    expect(stripCjk(`${ARABIC} ${XUEXI} photosynthesis`)).toBe(`${ARABIC}  photosynthesis`);
  });

  test("turns ideographic and full-width punctuation into ASCII", () => {
    expect(stripCjk(`${ARABIC}${FULLWIDTH_COMMA} done${IDEOGRAPHIC_FULL_STOP}`)).toBe(
      `${ARABIC}, done.`,
    );
  });

  test("leaves text without CJK unchanged", () => {
    expect(stripCjk(`${ARABIC}: 2 + 2 = 4 (H₂O) ✓`)).toBe(`${ARABIC}: 2 + 2 = 4 (H₂O) ✓`);
    expect(containsCjk(ARABIC)).toBe(false);
    expect(containsCjk(XUEXI)).toBe(true);
  });
});

describe("withScriptGuard", () => {
  test("generate: strips CJK from an answer to an Arabic prompt", async () => {
    const guarded = withScriptGuard(fakeProvider([`${ARABIC} ${XUEXI}`]));
    const result = await guarded.generate(input(`اشرح ${ARABIC}`));
    expect(result.content).toBe(`${ARABIC} `);
    expect(result.usage).toEqual(usage);
  });

  test("stream: filters every delta, skips one left empty, and the done text matches", async () => {
    const guarded = withScriptGuard(fakeProvider([ARABIC, ` ${XUEXI}`, XUEXI, " end"]));
    const events = await collect(guarded.stream(input("Explain photosynthesis")));

    const deltas = events.filter((e) => e.type === "delta");
    expect(deltas.map((e) => e.delta)).toEqual([ARABIC, " ", " end"]);
    expect(deltas.at(-1)?.text).toBe(`${ARABIC}  end`);
    const done = events.at(-1);
    expect(done?.type).toBe("done");
    expect(done?.text).toBe(`${ARABIC}  end`);
  });

  test("stays out of the way when the prompt itself has CJK", async () => {
    const guarded = withScriptGuard(fakeProvider([`${XUEXI} means study`]));
    const result = await guarded.generate(input(`What does ${XUEXI} mean?`));
    expect(result.content).toBe(`${XUEXI} means study`);

    const events = await collect(guarded.stream(input(`What does ${XUEXI} mean?`)));
    expect(events.at(-1)?.text).toBe(`${XUEXI} means study`);
  });
});
