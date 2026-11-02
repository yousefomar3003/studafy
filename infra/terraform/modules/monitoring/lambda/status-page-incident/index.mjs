// eslint-disable-next-line import-x/no-unresolved -- AWS SDK v3 is bundled with the Lambda runtime, not a repo dependency
import { GetObjectCommand, PutObjectCommand, S3Client } from "@aws-sdk/client-s3";
// eslint-disable-next-line import-x/no-unresolved -- AWS SDK v3 is bundled with the Lambda runtime, not a repo dependency
import { GetSecretValueCommand, SecretsManagerClient } from "@aws-sdk/client-secrets-manager";
// eslint-disable-next-line import-x/no-unresolved -- AWS SDK v3 is bundled with the Lambda runtime, not a repo dependency
import { SendEmailCommand, SESv2Client } from "@aws-sdk/client-sesv2";

/*
 * Manual incident updates (ST-264) — the human half status-page-sync (index.mjs next door) cannot
 * do by itself: posting or updating an incident, and emailing every confirmed subscriber. Invoked
 * through this Lambda's own Function URL (status_page.tf), authenticated with a shared bearer
 * token (STATUS_PAGE_ADMIN_TOKEN, in the `monitoring` app-secrets container) rather than AWS IAM —
 * this repo has no per-person IAM principal for "on-call engineer" to grant
 * lambda:InvokeFunctionUrl to, and a shared credential in that same secrets container is the exact
 * access-control shape Grafana's admin password and Alertmanager's receiver URLs already use here.
 * Known gap, stated plainly: this is a bearer token over HTTPS with no rate limiting or IP
 * allowlist behind it — proportionate to a low-traffic, human-operated endpoint, not
 * defense-in-depth.
 *
 * State: one S3 object, incidents.json (public — the status page's incident bucket, not the
 * subscriber one), a capped array of the most recent incidents, each holding its own update
 * timeline. Read-modify-write uses an S3 conditional PutObject (If-Match on the read's ETag) with
 * a short retry loop, so two concurrent posts cannot silently clobber each other — proportionate
 * given incident posting is a rare, human-initiated action, not a guard against real concurrency.
 *
 * Runtime: nodejs22.x. Zero npm dependencies beyond the bundled AWS SDK v3 clients.
 */

const SITE_BUCKET = process.env.SITE_BUCKET;
const DATA_BUCKET = process.env.DATA_BUCKET;
const INCIDENTS_KEY = "incidents.json";
const SUBSCRIBERS_KEY = "subscribers.json";
const MAX_INCIDENTS = 25;
const MONITORING_SECRET_ARN = process.env.MONITORING_SECRET_ARN;
const SES_FROM_ADDRESS = process.env.SES_FROM_ADDRESS;
const SUBSCRIPTION_URL = process.env.SUBSCRIPTION_URL;
// The five components the public page shows (status_page.tf's header explains why `ai` is here
// too despite having a thinner automatic signal than the other four).
const ALLOWED_COMPONENTS = new Set(["api", "web", "realtime", "ai", "billing"]);
const ALLOWED_STATUSES = new Set(["investigating", "identified", "monitoring", "resolved"]);

const s3 = new S3Client({});
const ses = new SESv2Client({});
const secrets = new SecretsManagerClient({});

class NotFoundError extends Error {}

function jsonResponse(statusCode, payload) {
  return {
    statusCode,
    headers: { "content-type": "application/json" },
    body: JSON.stringify(payload),
  };
}

function nowIso() {
  return new Date().toISOString();
}

async function getSecretValue(arn) {
  const response = await secrets.send(new GetSecretValueCommand({ SecretId: arn }));
  return JSON.parse(response.SecretString);
}

/** Reads a JSON object plus its ETag; a missing object reads as `fallback` with no ETag (the
 * first write to a fresh bucket has nothing to condition on). */
async function getJsonWithEtag(bucket, key, fallback) {
  try {
    const response = await s3.send(new GetObjectCommand({ Bucket: bucket, Key: key }));
    const text = await response.Body.transformToString();
    return { value: JSON.parse(text), etag: response.ETag };
  } catch (error) {
    if (error.name === "NoSuchKey") return { value: fallback, etag: undefined };
    throw error;
  }
}

/** Read-modify-write with S3's conditional PutObject (If-Match on the ETag just read, IfNoneMatch
 * on a first write) and a short retry loop — the concurrency guard a plain Get/Put pair lacks.
 * `mutate` receives the current value and returns the next one; throwing NotFoundError from it
 * aborts the whole operation without retrying (there is nothing to retry against). */
async function readModifyWrite(bucket, key, fallback, mutate) {
  let lastError;
  for (let attempt = 0; attempt < 3; attempt++) {
    const { value, etag } = await getJsonWithEtag(bucket, key, fallback);
    const next = mutate(value);
    try {
      await s3.send(
        new PutObjectCommand({
          Bucket: bucket,
          Key: key,
          Body: JSON.stringify(next),
          ContentType: "application/json",
          CacheControl: "no-cache",
          ...(etag ? { IfMatch: etag } : { IfNoneMatch: "*" }),
        }),
      );
      return next;
    } catch (error) {
      // PreconditionFailed: someone else wrote in between the read and this write. Retry against
      // whatever is current rather than overwriting their change.
      if (error.name !== "PreconditionFailed") throw error;
      lastError = error;
    }
  }
  throw lastError;
}

async function notifySubscribers(incident, update) {
  if (!SES_FROM_ADDRESS) return { sent: 0, skipped: "ses_not_configured" };

  const { value: subscribersDoc } = await getJsonWithEtag(DATA_BUCKET, SUBSCRIBERS_KEY, {
    subscribers: [],
  });
  const confirmed = (subscribersDoc.subscribers ?? []).filter((s) => s.confirmed);
  if (confirmed.length === 0) return { sent: 0 };

  const subject = `[${update.status}] ${incident.title}`;

  const results = await Promise.allSettled(
    confirmed.map((subscriber) => {
      const unsubscribeUrl = SUBSCRIPTION_URL
        ? `${SUBSCRIPTION_URL}?action=unsubscribe&email=${encodeURIComponent(subscriber.email)}&token=${subscriber.token}`
        : null;
      const text = [
        update.body,
        "",
        `Components: ${incident.components.join(", ")}`,
        `Status: ${update.status}`,
        unsubscribeUrl ? `\nUnsubscribe: ${unsubscribeUrl}` : "",
      ].join("\n");

      return ses.send(
        new SendEmailCommand({
          FromEmailAddress: SES_FROM_ADDRESS,
          Destination: { ToAddresses: [subscriber.email] },
          Content: { Simple: { Subject: { Data: subject }, Body: { Text: { Data: text } } } },
        }),
      );
    }),
  );

  const sent = results.filter((r) => r.status === "fulfilled").length;
  const failed = results.length - sent;
  if (failed > 0) {
    console.error(JSON.stringify({ event: "status_page_notify_partial_failure", sent, failed }));
  }
  return { sent, failed };
}

function parseBody(event) {
  const raw = event.isBase64Encoded
    ? Buffer.from(event.body ?? "", "base64").toString("utf8")
    : (event.body ?? "{}");
  return JSON.parse(raw);
}

export const handler = async (event) => {
  const method = event.requestContext?.http?.method ?? "POST";
  if (method !== "POST") return jsonResponse(405, { error: "method_not_allowed" });

  const credentials = await getSecretValue(MONITORING_SECRET_ARN);
  const providedToken = event.headers?.["x-status-page-admin-token"];
  if (!providedToken || providedToken !== credentials.STATUS_PAGE_ADMIN_TOKEN) {
    return jsonResponse(401, { error: "unauthorized" });
  }

  let payload;
  try {
    payload = parseBody(event);
  } catch {
    return jsonResponse(400, { error: "invalid_json" });
  }

  const { incidentId, title, components, impact, status, body } = payload;

  if (!status || !ALLOWED_STATUSES.has(status)) {
    return jsonResponse(400, { error: "invalid_status", allowed: [...ALLOWED_STATUSES] });
  }
  if (!body || typeof body !== "string") {
    return jsonResponse(400, { error: "body_required" });
  }
  if (!incidentId) {
    if (!title || !Array.isArray(components) || components.length === 0) {
      return jsonResponse(400, { error: "title_and_components_required_for_new_incident" });
    }
    if (!components.every((component) => ALLOWED_COMPONENTS.has(component))) {
      return jsonResponse(400, { error: "invalid_component", allowed: [...ALLOWED_COMPONENTS] });
    }
  }

  const update = { status, body, postedAt: nowIso() };
  let incident;

  try {
    await readModifyWrite(SITE_BUCKET, INCIDENTS_KEY, { incidents: [] }, (current) => {
      const incidents = current.incidents ?? [];

      if (incidentId) {
        const index = incidents.findIndex((candidate) => candidate.id === incidentId);
        if (index === -1) throw new NotFoundError(`incident ${incidentId} not found`);
        incident = {
          ...incidents[index],
          status,
          impact: impact ?? incidents[index].impact,
          updatedAt: update.postedAt,
          updates: [...incidents[index].updates, update],
        };
        incidents[index] = incident;
      } else {
        incident = {
          id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
          title,
          components,
          impact: impact ?? "minor",
          status,
          createdAt: update.postedAt,
          updatedAt: update.postedAt,
          updates: [update],
        };
        incidents.unshift(incident);
      }

      return { incidents: incidents.slice(0, MAX_INCIDENTS) };
    });
  } catch (error) {
    if (error instanceof NotFoundError) return jsonResponse(404, { error: "incident_not_found" });
    throw error;
  }

  const notify = await notifySubscribers(incident, update);

  console.log(
    JSON.stringify({ msg: "status page incident posted", incidentId: incident.id, status, notify }),
  );

  return jsonResponse(200, { incident, notified: notify });
};
