/**
 * QA-071: nothing that deploys or runs Studafy still points at AWS.
 *
 * Production moved to fly.io, Supabase, Redis Cloud and Cloudflare R2. The R2 keys used to reach the
 * workers as AWS_ACCESS_KEY_ID/AWS_SECRET_ACCESS_KEY, and the rotation issue template still asked
 * for CloudTrail evidence. This scans the files that act (workflows, fly configs, Dockerfiles,
 * compose) for AWS services and AWS credential names, outside comments, where history is allowed.
 * Supabase's `aws-1-…pooler.supabase.com` host and Axiom's `…aws.edge.axiom.co` are not AWS
 * accounts of ours and do not match.
 */

import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

// eslint-disable-next-line import-x/no-unresolved -- "bun:test" is a virtual Bun built-in with no resolvable file path
import { describe, expect, test } from "bun:test";

const root = join(import.meta.dir, "../../..");

const LIVE_AWS =
  /\b(CloudTrail|CloudWatch|Secrets Manager|ECS|RDS|ElastiCache|AWS_ACCESS_KEY_ID|AWS_SECRET_ACCESS_KEY|[Tt]erraform|aws (?:s3|ecs|rds|ecr|secretsmanager|cloudformation)|amazonaws\.com)\b/;

/** `file:line: text` for every non-comment line that names AWS. */
function liveAwsLines(name: string, text: string): string[] {
  return text
    .split("\n")
    .map((line, index) => ({ line, number: index + 1 }))
    .filter(({ line }) => !/^\s*#/.test(line) && LIVE_AWS.test(line))
    .map(({ line, number }) => `${name}:${number}: ${line.trim()}`);
}

function filesIn(directory: string, suffix: string): string[] {
  return readdirSync(join(root, directory))
    .filter((name) => name.endsWith(suffix))
    .map((name) => join(directory, name));
}

const scanned = [
  ...filesIn(".github/workflows", ".yml"),
  ...filesIn("infra/fly", ".toml"),
  ...filesIn("infra/docker", ".Dockerfile"),
  "compose.yml",
];

describe("no live AWS references (QA-071)", () => {
  test("workflows, fly configs, Dockerfiles and compose name no AWS service or AWS key", () => {
    const hits = scanned.flatMap((file) =>
      liveAwsLines(file, readFileSync(join(root, file), "utf8")),
    );
    expect(hits).toEqual([]);
  });

  test("catches the references this task removed, and allows comments and look-alike hosts", () => {
    const before = [
      '          export AWS_ACCESS_KEY_ID="$S3_ACCESS_KEY_ID"',
      "          - [ ] Audit evidence recorded (CloudTrail + log queries)",
      "  # The retired AWS ECS deploy workflows were removed.",
      '  DATABASE_HOST = "aws-1-eu-central-1.pooler.supabase.com"',
      '  HTTP_URL = "https://eu-central-1.aws.edge.axiom.co/v1/ingest/studafy-logs"',
    ].join("\n");
    expect(liveAwsLines("fixture", before)).toEqual([
      'fixture:1: export AWS_ACCESS_KEY_ID="$S3_ACCESS_KEY_ID"',
      "fixture:2: - [ ] Audit evidence recorded (CloudTrail + log queries)",
    ]);
  });
});
