import type { LlmGenerateInput, LlmProvider, LlmStreamEvent } from "./provider";

/**
 * Removes Chinese, Japanese and Korean characters a model wrote when nothing it was given contains
 * any.
 *
 * Studafy's students write Arabic and English, but the production model (Qwen3.5-9B) sometimes
 * drops Chinese words into an Arabic answer. Every prompt pins the answer's language
 * (`../language.ts`); this is the safety net for what still slips through. It stays out of the way
 * when the prompt itself has such characters -- a Chinese lesson, a student asking about a kanji --
 * so a legitimate answer is never cut.
 *
 * The mapping is per character, so filtering each streamed delta gives exactly the filtered whole
 * answer.
 */

const CJK_SCRIPT =
  /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}\p{Script=Bopomofo}]/u;

/**
 * Full-width and ideographic punctuation, by code point, mapped to the ASCII mark it stands for.
 * Written as numbers so the source holds no invisible or look-alike characters.
 */
const CJK_PUNCTUATION_TO_ASCII = new Map<number, string>([
  [0x3000, " "], // ideographic space
  [0x3001, ","], // ideographic comma
  [0x3002, "."], // ideographic full stop
  [0x300c, '"'], // corner brackets
  [0x300d, '"'],
  [0x300e, '"'],
  [0x300f, '"'],
  [0x3010, "["], // black lenticular brackets
  [0x3011, "]"],
  [0xff01, "!"], // full-width forms
  [0xff08, "("],
  [0xff09, ")"],
  [0xff0c, ","],
  [0xff0e, "."],
  [0xff1a, ":"],
  [0xff1b, ";"],
  [0xff1f, "?"],
]);

export function containsCjk(text: string): boolean {
  return CJK_SCRIPT.test(text);
}

/** Drop CJK characters and turn CJK punctuation into its ASCII counterpart. */
export function stripCjk(text: string): string {
  let out = "";
  for (const char of text) {
    const ascii = CJK_PUNCTUATION_TO_ASCII.get(char.codePointAt(0) ?? 0);
    if (ascii !== undefined) out += ascii;
    else if (!CJK_SCRIPT.test(char)) out += char;
  }
  return out;
}

function guardApplies(input: LlmGenerateInput): boolean {
  return !containsCjk(input.prompt) && !containsCjk(input.system ?? "");
}

export function withScriptGuard(provider: LlmProvider): LlmProvider {
  return {
    async generate(input) {
      const generation = await provider.generate(input);
      if (!guardApplies(input)) return generation;
      return { ...generation, content: stripCjk(generation.content) };
    },

    async *stream(input): AsyncGenerator<LlmStreamEvent, void, unknown> {
      if (!guardApplies(input)) {
        yield* provider.stream(input);
        return;
      }
      let text = "";
      for await (const event of provider.stream(input)) {
        if (event.type === "delta") {
          const delta = stripCjk(event.delta);
          if (delta === "") continue;
          text += delta;
          yield { type: "delta", delta, text };
        } else {
          yield { ...event, text: stripCjk(event.text) };
        }
      }
    },
  };
}
