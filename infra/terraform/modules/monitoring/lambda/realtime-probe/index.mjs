import crypto from "node:crypto";
import tls from "node:tls";

// eslint-disable-next-line import-x/no-unresolved -- AWS SDK v3 is bundled with the Lambda runtime, not a repo dependency
import { CloudWatchClient, PutMetricDataCommand } from "@aws-sdk/client-cloudwatch";
// eslint-disable-next-line import-x/no-unresolved -- AWS SDK v3 is bundled with the Lambda runtime, not a repo dependency
import { GetSecretValueCommand, SecretsManagerClient } from "@aws-sdk/client-secrets-manager";

/*
 * Synthetic realtime probe (ST-149). Runs every minute in staging/prod via EventBridge
 * Scheduler. Measures the realtime propagation SLO end-to-end:
 *
 *   probe WebSocket client  --(wss://<edge-domain>/ws, the real public path)-->  realtime
 *   gateway  --(Redis PUBLISH on the probe's own user room channel)-->  gateway subscriber
 *   -->  room broadcast  -->  probe client receives the envelope.
 *
 * Latency is the time from the envelope's `publishedAt` (stamped just before the Redis
 * PUBLISH) to the probe client receiving the matching envelope on its socket. One CloudWatch
 * metric per run, `RealtimeProbeLatency` (unit Milliseconds) under the `Studafy/Realtime`
 * namespace (same `Studafy/<component>` convention as pgbouncer's `Studafy/PgBouncer`). On any
 * failure the run emits NO datapoint: the SLO alarm treats missing data as breaching, so a failed
 * or timed-out probe alerts exactly like a slow one — a single metric, a single alarm, covers
 * "slow", "failed" and "not running" with no extra counters.
 *
 * Runtime: nodejs22.x Lambda. Zero npm dependencies — WebSocket (global), node:crypto and
 * node:tls for the minimal RESP client are all built in; the AWS SDK v3 clients
 * (@aws-sdk/client-secrets-manager, @aws-sdk/client-cloudwatch) are bundled with the runtime.
 * ESM (index.mjs) so the handler needs no bundler.
 *
 * Why publish to the probe's own user room (`school:probe:user:probe`) rather than a role or
 * school room: it is the probe's most isolated home room, so no other client in the reserved
 * probe school can be a delivery target, and the gateway's single `PSUBSCRIBE school:*`
 * guarantees the gateway instance holding this socket receives the publish regardless of which
 * gateway the ALB routed the connection to (see apps/realtime/src/subscriber.ts). The direct
 * room-channel publish exercises the same fan-out core as the outbox-relay path
 * (apps/realtime/src/outbox-fanout.ts) without depending on the workers outbox relay — that
 * path writes to Postgres and is out of scope for a per-minute probe. `type` is a free string
 * at the schema level (apps/realtime/src/protocol.ts), so `synthetic.probe` needs no
 * DOMAIN_EVENTS entry.
 */

const METRIC_NAMESPACE = process.env.METRIC_NAMESPACE;
const METRIC_NAME = "RealtimeProbeLatency";
const WS_URL = process.env.WS_URL;
const WS_JWT_SECRET_ARN = process.env.WS_JWT_SECRET_ARN;
const REDIS_AUTH_SECRET_ARN = process.env.REDIS_AUTH_SECRET_ARN;
const PROBE_SCHOOL_ID = process.env.PROBE_SCHOOL_ID || "probe";
const PROBE_USER_ID = process.env.PROBE_USER_ID || "probe";
const TIMEOUT_MS = Number(process.env.TIMEOUT_MS || 8000);

const secrets = new SecretsManagerClient({});
const cloudwatch = new CloudWatchClient({});

function base64UrlEncode(input) {
  return Buffer.from(input).toString("base64url");
}

/** HS256-signs a JWT the realtime gateway's stub accepts (apps/realtime/src/auth.ts). */
function signJwt(claims, secret) {
  const header = { alg: "HS256", typ: "JWT" };
  const encodedHeader = base64UrlEncode(JSON.stringify(header));
  const encodedPayload = base64UrlEncode(JSON.stringify(claims));
  const signature = crypto
    .createHmac("sha256", secret)
    .update(`${encodedHeader}.${encodedPayload}`)
    .digest("base64url");
  return `${encodedHeader}.${encodedPayload}.${signature}`;
}

async function getSecretValue(arn) {
  const response = await secrets.send(new GetSecretValueCommand({ SecretId: arn }));
  return JSON.parse(response.SecretString);
}

/** Encodes a RESP array of commands (safe for any payload: bulk strings, not inline args). */
function respCommand(...args) {
  let out = `*${args.length}\r\n`;
  for (const arg of args) {
    const value = String(arg);
    out += `$${Buffer.byteLength(value)}\r\n${value}\r\n`;
  }
  return out;
}

/**
 * Publishes one message to one channel over TLS, returns once the server acknowledges the
 * PUBLISH. Only needs AUTH + PUBLISH, so the RESP client is two commands and a single-line
 * response reader — far smaller than bundling ioredis for one message a minute.
 *
 * Certificate identity is deliberately not verified (`rejectUnauthorized: false`): ElastiCache
 * transit-encryption certificates are not signed by a CA in Node's default trust store, and the
 * connection stays inside the private VPC. See modules/monitoring/README.md's known gaps for
 * what pinning the AWS RDS CA bundle would look like.
 */
function publishToRedis(redisUrl, channel, message) {
  return new Promise((resolve, reject) => {
    const url = new URL(redisUrl);
    const password = url.password ? decodeURIComponent(url.password) : undefined;
    const port = url.port ? Number(url.port) : 6379;

    const socket = tls.connect(
      {
        host: url.hostname,
        port,
        rejectUnauthorized: false,
      },
      () => {
        const commands = [];
        if (password) {
          commands.push(respCommand("AUTH", password));
        }
        commands.push(respCommand("PUBLISH", channel, message));
        socket.write(commands.join(""));
      },
    );

    let buffer = "";
    let settled = false;

    const fail = (error) => {
      if (!settled) {
        settled = true;
        socket.destroy();
        reject(error);
      }
    };

    socket.setTimeout(5000, () => fail(new Error("redis publish timed out")));

    socket.on("data", (chunk) => {
      buffer += chunk.toString("utf8");
      while (buffer.includes("\r\n")) {
        const [line, rest] = buffer.split("\r\n");
        buffer = rest;
        if (line.startsWith("-")) {
          fail(new Error(`redis error: ${line.slice(1)}`));
          return;
        }
        if (line.startsWith(":")) {
          settled = true;
          socket.end();
          resolve();
          return;
        }
        // "+OK" (AUTH response) — keep reading for the PUBLISH response.
      }
    });

    socket.on("error", fail);
    socket.on("close", () => {
      if (!settled) {
        fail(new Error("redis connection closed before the publish was acknowledged"));
      }
    });
  });
}

/**
 * Connects a probe client, waits for the gateway's `system.joined` ack for the probe's own
 * user room (deterministic proof the socket is a member before anything is published), then
 * publishes the probe envelope to Redis and resolves with the round-trip latency in
 * milliseconds once the matching envelope arrives back on the socket.
 */
function runProbe({ jwt, room, redisUrl }) {
  return new Promise((resolve, reject) => {
    if (typeof WebSocket === "undefined") {
      reject(new Error("WebSocket global is unavailable; runtime must be nodejs22.x+"));
      return;
    }

    const url = `${WS_URL}?token=${jwt}`;
    let ws;
    try {
      ws = new WebSocket(url);
    } catch (error) {
      reject(error);
      return;
    }

    const probeId = crypto.randomUUID();
    let joined = false;
    let publishedAtMs = 0;
    let settled = false;

    const fail = (error) => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timer);
      try {
        ws.close();
      } catch {
        // Socket already closed — nothing to clean up.
      }
      reject(error);
    };

    const timer = setTimeout(
      () => fail(new Error(`probe timed out after ${TIMEOUT_MS}ms`)),
      TIMEOUT_MS,
    );

    ws.addEventListener("message", (event) => {
      let message;
      try {
        message = JSON.parse(String(event.data));
      } catch {
        return;
      }

      if (!joined) {
        if (message.type === "system.joined" && message.room === room) {
          joined = true;
          publishedAtMs = Date.now();
          const envelope = {
            id: probeId,
            type: "synthetic.probe",
            room,
            payload: { probeId },
            publishedAt: new Date(publishedAtMs).toISOString(),
          };
          publishToRedis(redisUrl, room, JSON.stringify(envelope)).catch(fail);
        }
        return;
      }

      if (message.type === "synthetic.probe" && message.id === probeId) {
        if (settled) {
          return;
        }
        settled = true;
        clearTimeout(timer);
        try {
          ws.close();
        } catch {
          // Socket already closed — nothing to clean up.
        }
        resolve(Date.now() - publishedAtMs);
      }
    });

    ws.addEventListener("error", () => fail(new Error("websocket connection error")));
    ws.addEventListener("close", (event) => {
      if (!settled && event.code !== 1000) {
        fail(new Error(`websocket closed (code ${event.code}) before the probe event arrived`));
      }
    });
  });
}

export const handler = async () => {
  const startedAt = Date.now();
  try {
    const [realtimeSecret, redisSecret] = await Promise.all([
      getSecretValue(WS_JWT_SECRET_ARN),
      getSecretValue(REDIS_AUTH_SECRET_ARN),
    ]);

    const jwt = signJwt(
      {
        sub: PROBE_USER_ID,
        schoolId: PROBE_SCHOOL_ID,
        role: "GUEST",
        // 5 minutes: far beyond this run, but present so the token is a realistic client token
        // and the gateway schedules its (irrelevant here) re-auth timer.
        exp: Math.floor(Date.now() / 1000) + 300,
      },
      realtimeSecret.WS_JWT_SECRET,
    );

    const room = `school:${PROBE_SCHOOL_ID}:user:${PROBE_USER_ID}`;
    const latencyMs = await runProbe({
      jwt,
      room,
      redisUrl: redisSecret.pubsub_url,
    });

    await cloudwatch.send(
      new PutMetricDataCommand({
        Namespace: METRIC_NAMESPACE,
        MetricData: [
          {
            MetricName: METRIC_NAME,
            Value: latencyMs,
            Unit: "Milliseconds",
            Timestamp: new Date(),
          },
        ],
      }),
    );

    console.log(
      JSON.stringify({
        msg: "realtime probe succeeded",
        latencyMs,
        totalMs: Date.now() - startedAt,
      }),
    );
    return { statusCode: 200, body: JSON.stringify({ latencyMs }) };
  } catch (error) {
    // No latency datapoint is emitted on failure: the SLO alarm treats missing data as
    // breaching, so a failed run alerts exactly like a slow one.
    console.error(
      JSON.stringify({
        msg: "realtime probe failed",
        error: error instanceof Error ? error.message : String(error),
      }),
    );
    return { statusCode: 500, body: JSON.stringify({ error: String(error) }) };
  }
};
