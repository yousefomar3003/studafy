// eslint-disable-next-line import-x/no-unresolved -- "bun:test" is a virtual Bun built-in with no resolvable file path
import { describe, expect, test } from "bun:test";

import { createLogger, LOG_LEVELS } from "./logger";

import type { Logger, LogLevel } from "./logger";

/** Build a logger writing to an array instead of stdout, with a frozen clock. */
const buildLogger = (level?: LogLevel): { logger: Logger; lines: string[] } => {
  const lines: string[] = [];
  const logger = createLogger({
    level,
    base: { service: "api", env: "test", release_version: "1.2.3" },
    destination: (line) => lines.push(line),
    now: () => 1_700_000_000_000,
  });
  return { logger, lines };
};

const parse = (line: string): Record<string, unknown> =>
  JSON.parse(line) as Record<string, unknown>;

describe("log record format", () => {
  test("emits one newline-terminated JSON line per call", () => {
    const { logger, lines } = buildLogger();

    logger.info("hello");

    expect(lines).toHaveLength(1);
    expect(lines[0]!.endsWith("\n")).toBe(true);
    expect(parse(lines[0]!)).toMatchObject({
      level: 30,
      time: 1_700_000_000_000,
      service: "api",
      env: "test",
      release_version: "1.2.3",
      msg: "hello",
    });
  });

  test("key order matches pino: level and time first, msg last", () => {
    const { logger, lines } = buildLogger();

    logger.info({ school_id: "s1" }, "ordered");

    // Asserted on the raw string, not the parsed object: key order is the parity claim, and
    // JSON.parse discards it.
    expect(lines[0]!.startsWith('{"level":30,"time":1700000000000,')).toBe(true);
    expect(lines[0]!.endsWith('"msg":"ordered"}\n')).toBe(true);
  });

  test("each method emits its pino level integer", () => {
    const { logger, lines } = buildLogger("trace");

    logger.trace("a");
    logger.debug("b");
    logger.info("c");
    logger.warn("d");
    logger.error("e");
    logger.fatal("f");

    expect(lines.map((line) => parse(line).level)).toEqual([10, 20, 30, 40, 50, 60]);
    expect(LOG_LEVELS).toEqual({ trace: 10, debug: 20, info: 30, warn: 40, error: 50, fatal: 60 });
  });

  test("call-site fields land at the root of the document, not nested", () => {
    const { logger, lines } = buildLogger();

    logger.info({ school_id: "s1", user_id: "u1", request_id: "r1" }, "flat");

    // Root-level primary keys are the point: an aggregator query filters on them directly.
    expect(parse(lines[0]!)).toMatchObject({ school_id: "s1", user_id: "u1", request_id: "r1" });
  });

  test("drops keys whose values cannot be represented in JSON", () => {
    const { logger, lines } = buildLogger();

    logger.info({ fn: () => undefined, sym: Symbol("s"), nope: undefined, kept: 1 }, "dropped");

    const record = parse(lines[0]!);
    expect(record).toMatchObject({ kept: 1, msg: "dropped" });
    expect(record).not.toHaveProperty("fn");
    expect(record).not.toHaveProperty("sym");
    expect(record).not.toHaveProperty("nope");
  });
});

describe("level filtering", () => {
  test("levels below the threshold emit nothing at all", () => {
    const { logger, lines } = buildLogger("warn");

    logger.trace("no");
    logger.debug("no");
    logger.info("no");

    expect(lines).toHaveLength(0);
  });

  test("levels at or above the threshold emit", () => {
    const { logger, lines } = buildLogger("warn");

    logger.warn("yes");
    logger.error("yes");
    logger.fatal("yes");

    expect(lines).toHaveLength(3);
  });

  test("a child inherits the parent threshold", () => {
    const { logger, lines } = buildLogger("error");

    logger.child({ request_id: "r1" }).info("filtered");

    expect(lines).toHaveLength(0);
  });
});

describe("child loggers", () => {
  test("a child merges its bindings and leaves the parent untouched", () => {
    const { logger, lines } = buildLogger();

    const child = logger.child({ request_id: "r1" });
    child.info("from child");
    logger.info("from parent");

    expect(parse(lines[0]!)).toMatchObject({ request_id: "r1", msg: "from child" });
    expect(parse(lines[1]!)).not.toHaveProperty("request_id");
  });

  test("a grandchild carries bindings from both ancestors", () => {
    const { logger, lines } = buildLogger();

    logger.child({ request_id: "r1" }).child({ school_id: "s1" }).info("deep");

    expect(parse(lines[0]!)).toMatchObject({ request_id: "r1", school_id: "s1" });
  });

  test("a child key overrides the same key bound by its parent", () => {
    const { logger, lines } = buildLogger();

    // The mechanism the auth seam depends on: request-context binds school_id: null before an
    // identity is known, and a later middleware re-childs with the real value. The duplicate key
    // is legal JSON and a reader keeps the last one — so the override costs one concat.
    logger.child({ school_id: null }).child({ school_id: "s1" }).info("overridden");

    expect(lines[0]).toInclude('"school_id":null');
    expect(parse(lines[0]!).school_id).toBe("s1");
  });
});

describe("error serialization", () => {
  test("JSON.stringify alone loses an Error entirely", () => {
    // The control assertion: this is why serializeError exists. If this ever stops being true,
    // the serializer can go.
    expect(JSON.stringify(new Error("boom"))).toBe("{}");
  });

  test("the err key expands to type, message, and stack", () => {
    const { logger, lines } = buildLogger();

    logger.error({ err: new TypeError("boom") }, "failed");

    const err = parse(lines[0]!).err as Record<string, unknown>;
    expect(err.type).toBe("TypeError");
    expect(err.message).toBe("boom");
    expect(err.stack).toBeString();
  });

  test("a cause chain is serialized", () => {
    const { logger, lines } = buildLogger();

    logger.error({ err: new Error("outer", { cause: new Error("inner") }) }, "failed");

    const err = parse(lines[0]!).err as Record<string, Record<string, unknown>>;
    expect(err.cause!.message).toBe("inner");
  });

  test("a cyclic cause chain terminates instead of overflowing the stack", () => {
    const { logger, lines } = buildLogger();
    const a = new Error("a");
    const b = new Error("b", { cause: a });
    (a as { cause?: unknown }).cause = b;

    expect(() => logger.error({ err: b }, "cyclic")).not.toThrow();
    expect(lines).toHaveLength(1);
  });

  test("a non-Error err value passes through unchanged", () => {
    const { logger, lines } = buildLogger();

    logger.error({ err: "just a string" }, "failed");

    expect(parse(lines[0]!).err).toBe("just a string");
  });

  test("a circular field does not throw and still yields one valid line", () => {
    const { logger, lines } = buildLogger();
    const circular: Record<string, unknown> = {};
    circular.self = circular;

    expect(() => logger.info({ circular, kept: 1 }, "circular")).not.toThrow();
    expect(lines).toHaveLength(1);
    expect(parse(lines[0]!)).toMatchObject({ circular: "[unserializable]", kept: 1 });
  });
});

describe("log injection safety", () => {
  // NDJSON frames on U+000A and nothing else, so forging a record means emitting a raw newline
  // mid-line. JSON.stringify provably cannot: ECMA-262 QuoteJSONString escapes U+000A, U+000D, and
  // every code point below U+0020. These tests pin that guarantee at each place a value enters.

  test("a newline in a field value cannot forge a second record", () => {
    const { logger, lines } = buildLogger();
    const payload = '\n{"level":50,"time":0,"msg":"FORGED"}\n';

    logger.info({ user_agent: payload }, "real");

    expect(lines).toHaveLength(1);
    // A reader splitting the stream on newlines sees exactly one record.
    expect(lines.join("").split("\n").filter(Boolean)).toHaveLength(1);
    expect(lines[0]!.slice(0, -1)).not.toInclude("\n");

    const record = parse(lines[0]!);
    expect(record.user_agent).toBe(payload); // the payload survives — as inert data
    expect(record.msg).toBe("real");
    expect(record.level).toBe(30); // not 50: nothing was forged
  });

  test("a newline in the message cannot forge a second record", () => {
    const { logger, lines } = buildLogger();

    logger.info('real\n{"level":50,"msg":"FORGED"}');

    expect(lines.join("").split("\n").filter(Boolean)).toHaveLength(1);
    expect(parse(lines[0]!).level).toBe(30);
  });

  test("a newline in a binding cannot forge a second record", () => {
    const { logger, lines } = buildLogger();

    logger.child({ path: '/x\n{"level":50,"msg":"FORGED"}' }).info("real");

    expect(lines.join("").split("\n").filter(Boolean)).toHaveLength(1);
    expect(parse(lines[0]!).level).toBe(30);
  });

  test("a quote or backslash in a key cannot escape the document", () => {
    const { logger, lines } = buildLogger();

    // Keys are attacker-reachable wherever fields are built from request data, so they are
    // stringified too — not just values.
    logger.info({ 'evil":1,"level': 50, "back\\slash": 1 }, "keys");

    const record = parse(lines[0]!);
    expect(record.level).toBe(30);
    expect(record['evil":1,"level']).toBe(50);
    expect(record["back\\slash"]).toBe(1);
  });

  test("carriage returns and quotes in a value are escaped", () => {
    const { logger, lines } = buildLogger();
    const payload = '\r\n"}{"level":50';

    logger.info({ header: payload }, "escaped");

    expect(lines[0]!.slice(0, -1)).not.toInclude("\r");
    expect(parse(lines[0]!).header).toBe(payload);
  });
});
