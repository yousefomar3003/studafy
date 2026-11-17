/**
 * QA-071: the workers' object-storage keys are Cloudflare R2 keys, so they are configured under the
 * same `S3_ACCESS_KEY_ID`/`S3_SECRET_ACCESS_KEY` names as the api, not as AWS credentials. The S3
 * SDK's default credential chain, which every S3Client in this app uses, reads
 * `AWS_ACCESS_KEY_ID`/`AWS_SECRET_ACCESS_KEY`, so bootstrap copies the pair across before any client
 * asks for credentials (the chain resolves them lazily, on the first request).
 *
 * The S3_* pair wins over any AWS_* value already present: the deploy used to stage the keys under
 * those names, so an app can still carry the old ones until someone unsets them.
 */
export function applyS3CredentialAliases(
  env: Record<string, string | undefined> = process.env,
): void {
  const accessKeyId = env.S3_ACCESS_KEY_ID;
  const secretAccessKey = env.S3_SECRET_ACCESS_KEY;
  if (!accessKeyId || !secretAccessKey) return;
  env.AWS_ACCESS_KEY_ID = accessKeyId;
  env.AWS_SECRET_ACCESS_KEY = secretAccessKey;
}
