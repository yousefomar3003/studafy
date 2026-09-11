// eslint-disable-next-line import-x/no-unresolved -- AWS SDK v3 is bundled with the Lambda runtime, not a repo dependency
import { GetObjectCommand, PutObjectCommand, S3Client } from "@aws-sdk/client-s3";

/*
 * Confirm / unsubscribe (ST-264) — the two "a human clicks a link in an email" flows for the
 * status page's subscriber list. One Lambda for both, not two: they are the same shape of
 * operation (find the subscriber matching email+token, mutate one record, write it back) and
 * splitting them would just be the same code twice. `?action=confirm` completes double opt-in
 * (lambda/status-page-subscribe sends the link this satisfies); `?action=unsubscribe` removes the
 * subscriber (every incident-update email from lambda/status-page-incident carries this link,
 * per-subscriber, using their own token).
 *
 * Answers HTML, not JSON: a human is looking at this in a browser tab, having just clicked a link
 * in their inbox — a JSON blob would be a worse response to that click than a short, readable page.
 *
 * Runtime: nodejs22.x. Zero npm dependencies beyond the bundled AWS SDK v3 client.
 */

const DATA_BUCKET = process.env.DATA_BUCKET;
const SUBSCRIBERS_KEY = "subscribers.json";

const s3 = new S3Client({});

class NotFoundError extends Error {}

function htmlResponse(statusCode, title, message) {
  const body = `<!doctype html><html><head><meta charset="utf-8"><title>${title}</title>
<style>body{font-family:system-ui,sans-serif;max-width:32rem;margin:4rem auto;padding:0 1rem;color:#1a1a1a}</style>
</head><body><h1>${title}</h1><p>${message}</p></body></html>`;
  return { statusCode, headers: { "content-type": "text/html; charset=utf-8" }, body };
}

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
      if (error.name !== "PreconditionFailed") throw error;
      lastError = error;
    }
  }
  throw lastError;
}

export const handler = async (event) => {
  const method = event.requestContext?.http?.method ?? "GET";
  if (method !== "GET") return htmlResponse(405, "Method not allowed", "");

  const params = event.queryStringParameters ?? {};
  const action = params.action;
  const email = params.email;
  const token = params.token;

  if (action !== "confirm" && action !== "unsubscribe") {
    return htmlResponse(400, "Invalid request", "Missing or unrecognized action.");
  }
  if (!email || !token) {
    return htmlResponse(400, "Invalid request", "This link is missing required parameters.");
  }

  try {
    await readModifyWrite(DATA_BUCKET, SUBSCRIBERS_KEY, { subscribers: [] }, (current) => {
      const subscribers = current.subscribers ?? [];
      const index = subscribers.findIndex(
        (s) => s.email.toLowerCase() === email.toLowerCase() && s.token === token,
      );
      if (index === -1) throw new NotFoundError();

      if (action === "unsubscribe") {
        subscribers.splice(index, 1);
      } else {
        subscribers[index] = { ...subscribers[index], confirmed: true };
      }
      return { subscribers };
    });
  } catch (error) {
    if (error instanceof NotFoundError) {
      // Already used (a confirm link clicked twice, or an unsubscribe link clicked after the
      // subscriber already unsubscribed) reads the same as "invalid" from here — this Lambda
      // cannot tell the two apart once the record is gone, and does not need to.
      return htmlResponse(
        404,
        "Link no longer valid",
        "This link has already been used, or the subscription no longer exists.",
      );
    }
    throw error;
  }

  console.log(JSON.stringify({ msg: "status page subscription action", action }));

  return action === "confirm"
    ? htmlResponse(
        200,
        "Subscribed",
        "You're subscribed to status updates. You can close this tab.",
      )
    : htmlResponse(200, "Unsubscribed", "You won't receive any further status updates.");
};
