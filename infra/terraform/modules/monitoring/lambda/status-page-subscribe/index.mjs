import { randomBytes } from "node:crypto";

// eslint-disable-next-line import-x/no-unresolved -- AWS SDK v3 is bundled with the Lambda runtime, not a repo dependency
import { GetObjectCommand, PutObjectCommand, S3Client } from "@aws-sdk/client-s3";
// eslint-disable-next-line import-x/no-unresolved -- AWS SDK v3 is bundled with the Lambda runtime, not a repo dependency
import { SendEmailCommand, SESv2Client } from "@aws-sdk/client-sesv2";

/*
 * Public subscribe endpoint (ST-264). The only Lambda in this module anyone on the internet can
 * call unauthenticated — that is the point, it is the public page's "get emailed about updates"
 * form. Double opt-in: this Lambda only ever records `confirmed: false` and emails a confirmation
 * link; lambda/status-page-subscription/index.mjs is what actually flips a subscriber to
 * confirmed (or removes them, from an unsubscribe link). Nothing here ever sends an update email —
 * that is lambda/status-page-incident's job, and it only mails confirmed subscribers.
 *
 * State lives in DATA_BUCKET's subscribers.json (never the public site bucket — see
 * status_page.tf's header for why subscriber emails are a separate, non-CloudFront-readable
 * bucket), one JSON array, read-modify-write with a short S3 conditional-PutObject retry loop —
 * see lambda/status-page-incident/index.mjs's own comment for why that is proportionate here.
 *
 * Known gap, stated plainly: no rate limiting on this endpoint. A public POST-an-email endpoint is
 * a predictable target for junk submissions; nothing here throttles by IP. Confirmation being
 * double opt-in bounds the damage to "someone gets one unwanted confirmation email", not an actual
 * subscription, and this repo has no WAF wired to a Lambda Function URL today to do better.
 *
 * Runtime: nodejs22.x. Zero npm dependencies beyond node:crypto and the bundled AWS SDK v3 clients.
 */

const DATA_BUCKET = process.env.DATA_BUCKET;
const SUBSCRIBERS_KEY = "subscribers.json";
const SES_FROM_ADDRESS = process.env.SES_FROM_ADDRESS;
const CONFIRM_BASE_URL = process.env.CONFIRM_BASE_URL;
const STATUS_PAGE_URL = process.env.STATUS_PAGE_URL;
// Deliberately permissive (format only, no MX/deliverability check — that's what the confirmation
// email itself proves): this only gates "is this shaped like an email address".
const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

const s3 = new S3Client({});
const ses = new SESv2Client({});

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

function parseBody(event) {
  const raw = event.isBase64Encoded
    ? Buffer.from(event.body ?? "", "base64").toString("utf8")
    : (event.body ?? "{}");
  return JSON.parse(raw);
}

export const handler = async (event) => {
  const method = event.requestContext?.http?.method ?? "POST";
  if (method !== "POST") return jsonResponse(405, { error: "method_not_allowed" });

  if (!SES_FROM_ADDRESS) {
    // status_page.tf only creates this Lambda when SES is actually wired up (ses_domain_identity_arn
    // set), so this should be unreachable in practice — kept as an explicit 503 rather than a send
    // that silently fails, in case that invariant is ever broken by a future change.
    return jsonResponse(503, { error: "email_not_configured" });
  }

  let payload;
  try {
    payload = parseBody(event);
  } catch {
    return jsonResponse(400, { error: "invalid_json" });
  }

  const email = typeof payload.email === "string" ? payload.email.trim() : "";
  if (!EMAIL_PATTERN.test(email)) {
    return jsonResponse(400, { error: "invalid_email" });
  }

  const token = randomBytes(24).toString("hex");
  let alreadyConfirmed = false;

  await readModifyWrite(DATA_BUCKET, SUBSCRIBERS_KEY, { subscribers: [] }, (current) => {
    const subscribers = current.subscribers ?? [];
    const index = subscribers.findIndex((s) => s.email.toLowerCase() === email.toLowerCase());

    if (index !== -1 && subscribers[index].confirmed) {
      alreadyConfirmed = true;
      return current;
    }

    const record = { email, confirmed: false, token, subscribedAt: nowIso() };
    if (index === -1) subscribers.push(record);
    else subscribers[index] = record;

    return { subscribers };
  });

  if (!alreadyConfirmed) {
    const confirmUrl = `${CONFIRM_BASE_URL}?action=confirm&email=${encodeURIComponent(email)}&token=${token}`;
    await ses.send(
      new SendEmailCommand({
        FromEmailAddress: SES_FROM_ADDRESS,
        Destination: { ToAddresses: [email] },
        Content: {
          Simple: {
            Subject: { Data: "Confirm your status page subscription" },
            Body: {
              Text: {
                Data: [
                  `Confirm your subscription to status updates${STATUS_PAGE_URL ? ` for ${STATUS_PAGE_URL}` : ""}:`,
                  "",
                  confirmUrl,
                  "",
                  "If you didn't request this, ignore this email — you won't be subscribed unless you click the link above.",
                ].join("\n"),
              },
            },
          },
        },
      }),
    );
  }

  console.log(JSON.stringify({ msg: "status page subscribe requested", alreadyConfirmed }));

  return jsonResponse(200, {
    status: alreadyConfirmed ? "already_subscribed" : "pending_confirmation",
  });
};
