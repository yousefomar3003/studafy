/**
 * Structured NDJSON logging. One log record is one line; lines are framed by U+000A and nothing
 * else. The wire format matches pino's so the same aggregator queries, level integers, and field
 * names work — without taking pino as a dependency. See docs/architecture/SAD_28_logging_conventions.md.
 *
 * Two properties are load-bearing and easy to break:
 *
 *  1. Injection safety. Every dynamic value — keys included — goes through JSON.stringify, which
 *     cannot emit a raw newline. The only raw newline this module produces is the one the writer
 *     appends. Never interpolate an unstringified value into a line.
 *  2. Cost. Bindings are held pre-serialized as a string fragment, so child() is a string concat
 *     rather than an object spread plus re-serialization, and a disabled level is a no-op function
 *     resolved at construction rather than a branch at every call site.
 */

export const LOG_LEVEL_NAMES = ["trace", "debug", "info", "warn", "error", "fatal"] as const;
export type LogLevel = (typeof LOG_LEVEL_NAMES)[number];

/** pino's level integers. Aggregator queries are written against these numbers, not the names. */
export const LOG_LEVELS: Readonly<Record<LogLevel, number>> = {
  trace: 10,
  debug: 20,
  info: 30,
  warn: 40,
  error: 50,
  fatal: 60,
};

/**
 * The same thresholds keyed for lookup. A Map rather than an index into LOG_LEVELS: a computed member
 * access trips eslint-plugin-security's detect-object-injection, and this module takes no disables.
 */
const LEVEL_THRESHOLDS = new Map<LogLevel, number>(
  Object.entries(LOG_LEVELS) as [LogLevel, number][],
);

export type LogFields = Readonly<Record<string, unknown>>;

export interface LogMethod {
  (msg: string): void;
  (fields: LogFields, msg: string): void;
}

export interface Logger {
  readonly level: LogLevel;
  trace: LogMethod;
  debug: LogMethod;
  info: LogMethod;
  warn: LogMethod;
  error: LogMethod;
  fatal: LogMethod;
  /**
   * Derive a logger carrying additional bindings. Keys already bound are re-emitted rather than
   * replaced; a JSON reader keeps the last occurrence, so a later child overrides an earlier
   * binding. This is what lets a downstream middleware refine context it did not create.
   */
  child(bindings: LogFields): Logger;
}

export interface LoggerOptions {
  /** Minimum level to emit. Anything below it costs nothing at the call site. Default "info". */
  level?: LogLevel;
  /** Bindings on every line from this logger and its children — service, env, release_version. */
  base?: LogFields;
  /** Where a finished line goes. Injected by tests so a run never writes to real stdout. */
  destination?: (line: string) => void;
  /** Clock for the `time` field. Injected by tests for deterministic output. */
  now?: () => number;
  /**
   * Called with every record after its line has been written — an addition to stdout, never a
   * replacement for it. Receives the call-site fields and the accumulated bindings as live objects,
   * so a consumer (error monitoring's log forwarding, wired in index.ts) can read `err` as the
   * actual Error rather than its serialized shape. When unset, bindings are never materialized as
   * an object, so a logger without an observer pays nothing for this seam.
   */
  observer?: LogObserver;
}

export type LogObserver = (
  level: LogLevel,
  msg: string | undefined,
  fields: LogFields,
  bindings: LogFields,
) => void;

const NO_FIELDS: LogFields = Object.freeze({});

/**
 * Bun's process.stdout is a buffered FileSink: writes are ordered and synchronous from the caller's
 * view, under a TTY and under a pipe alike. Bun.write returns a promise (which would interleave
 * lines), and console.log runs the inspector and appends its own newline — neither is usable here.
 */
const writeToStdout = (line: string): void => {
  process.stdout.write(line);
};

const noop: LogMethod = () => undefined;

/**
 * pino's standard `err` serializer shape. Required because JSON.stringify(new Error("boom")) is
 * "{}" — an Error's message and stack are non-enumerable own properties, so they serialize away.
 */
function serializeError(value: unknown, depth = 0): unknown {
  if (!(value instanceof Error)) return value;

  const serialized: Record<string, unknown> = { type: value.name, message: value.message };
  if (value.stack !== undefined) serialized.stack = value.stack;
  // Depth-bounded: a `cause` chain can cycle, and a cycle here would overflow the stack inside a
  // log call — turning an error report into a second, worse error.
  if (depth < 2 && value.cause instanceof Error) {
    serialized.cause = serializeError(value.cause, depth + 1);
  }
  return serialized;
}

/** Serialize one pair into a `,"key":value` fragment. Both halves pass through JSON.stringify. */
function fragment(key: string, value: unknown): string {
  let json: string | undefined;
  try {
    json = JSON.stringify(value);
  } catch {
    // Circular structures and BigInt throw. A log call must never break the request that made it.
    return `,${JSON.stringify(key)}:"[unserializable]"`;
  }
  // JSON.stringify returns undefined for functions, symbols, and undefined: drop those keys, the
  // way pino does, rather than emitting invalid JSON.
  return json === undefined ? "" : `,${JSON.stringify(key)}:${json}`;
}

function fragments(fields: LogFields): string {
  let out = "";
  // Object.entries rather than a computed member access: the latter trips
  // eslint-plugin-security's detect-object-injection, and there is no reason to take the disable.
  for (const [key, value] of Object.entries(fields)) {
    out += fragment(key, key === "err" ? serializeError(value) : value);
  }
  return out;
}

function build(
  level: LogLevel,
  threshold: number,
  bindings: string,
  destination: (line: string) => void,
  now: () => number,
  observer: LogObserver | undefined,
  bindingFields: LogFields,
): Logger {
  const method = (name: LogLevel, value: number): LogMethod => {
    // Resolved once, here. A disabled level is a no-op call — never a serialization, never an
    // allocation — which is what makes LOG_LEVEL free rather than merely cheap.
    if (value < threshold) return noop;

    return (a: LogFields | string, b?: string): void => {
      const msg = typeof a === "string" ? a : b;
      const extra = typeof a === "string" ? "" : fragments(a);
      // Key order matches pino: level, time, base, bindings, call-site fields, msg last. The \n
      // below is the only raw newline in this module; every dynamic value above went through
      // JSON.stringify and therefore cannot contain one.
      destination(
        `{"level":${value},"time":${now()}${bindings}${extra}` +
          `${msg === undefined ? "" : `,"msg":${JSON.stringify(msg)}`}}\n`,
      );
      if (observer) {
        try {
          observer(name, msg, typeof a === "string" ? NO_FIELDS : a, bindingFields);
        } catch {
          // Same rule as fragment(): a log call must never break the request that made it.
        }
      }
    };
  };

  return {
    level,
    trace: method("trace", LOG_LEVELS.trace),
    debug: method("debug", LOG_LEVELS.debug),
    info: method("info", LOG_LEVELS.info),
    warn: method("warn", LOG_LEVELS.warn),
    error: method("error", LOG_LEVELS.error),
    fatal: method("fatal", LOG_LEVELS.fatal),
    // The cheap merge: the parent's bindings are already a serialized string, so a child costs one
    // concat of its own fragment and never re-serializes the parent's. The object form is only
    // kept up to date when an observer is there to read it.
    child: (extra) =>
      build(
        level,
        threshold,
        bindings + fragments(extra),
        destination,
        now,
        observer,
        observer ? { ...bindingFields, ...extra } : NO_FIELDS,
      ),
  };
}

export function createLogger(options: LoggerOptions = {}): Logger {
  const level = options.level ?? "info";
  return build(
    level,
    LEVEL_THRESHOLDS.get(level)!,
    fragments(options.base ?? {}),
    options.destination ?? writeToStdout,
    options.now ?? Date.now,
    options.observer,
    options.observer ? (options.base ?? NO_FIELDS) : NO_FIELDS,
  );
}
