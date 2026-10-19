import {
  CreateBucketCommand,
  HeadBucketCommand,
  PutBucketCorsCommand,
  S3Client,
} from "@aws-sdk/client-s3";

/**
 * Prepares the local S3 stand-in (the `s3` service in db/compose.yml) for the app: creates the
 * app-files bucket and gives it the same browser CORS rule as the real one
 * (infra/terraform/modules/storage/main.tf), so presigned uploads from the Vite dev server work.
 *
 * Run by `bun run db:up` after the containers report healthy; safe to re-run. Every value can be
 * overridden from the environment, and the defaults match db/compose.yml and .env.example. Refuses
 * anything but a loopback endpoint so it can never be pointed at a real AWS bucket by accident.
 */
const endpoint = process.env.S3_ENDPOINT ?? "http://127.0.0.1:9000";
const bucket = process.env.S3_APP_FILES_BUCKET ?? "studafy-files";
const webOrigin = process.env.FRONTEND_URL ?? "http://localhost:5173";

async function main(): Promise<void> {
  const { hostname } = new URL(endpoint);
  if (!["127.0.0.1", "localhost", "::1", "[::1]"].includes(hostname)) {
    throw new Error(`refusing to initialise non-local S3 endpoint ${endpoint}`);
  }

  const client = new S3Client({
    endpoint,
    region: process.env.S3_REGION ?? "us-east-1",
    forcePathStyle: true,
    credentials: {
      accessKeyId: process.env.S3_ACCESS_KEY_ID ?? "studafy-local",
      secretAccessKey: process.env.S3_SECRET_ACCESS_KEY ?? "studafy-local-secret",
    },
  });

  try {
    await client.send(new HeadBucketCommand({ Bucket: bucket }));
  } catch {
    await client.send(new CreateBucketCommand({ Bucket: bucket }));
    console.log(`created bucket ${bucket}`);
  }

  await client.send(
    new PutBucketCorsCommand({
      Bucket: bucket,
      CORSConfiguration: {
        CORSRules: [
          {
            AllowedMethods: ["GET", "PUT", "POST", "HEAD"],
            AllowedOrigins: [webOrigin],
            AllowedHeaders: ["*"],
            ExposeHeaders: ["ETag"],
            MaxAgeSeconds: 3000,
          },
        ],
      },
    }),
  );
  console.log(`local storage ready: ${endpoint}/${bucket} (CORS for ${webOrigin})`);
}

await main();
