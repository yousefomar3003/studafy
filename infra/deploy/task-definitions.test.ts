import { readFile } from "node:fs/promises";
import { join } from "node:path";

// eslint-disable-next-line import-x/no-unresolved -- "bun:test" is a virtual Bun built-in
import { describe, expect, test } from "bun:test";

interface TaskDefinition {
  taskRoleArn?: string;
  containerDefinitions: {
    environment: { name: string; value: string }[];
    secrets: { name: string; valueFrom: string }[];
  }[];
}

async function renderTemplate(service: "api" | "workers"): Promise<TaskDefinition> {
  const template = await readFile(
    join(import.meta.dir, "ecs", service, "task-definition.json.tpl"),
    "utf8",
  );
  return JSON.parse(template.replaceAll(/\$\{[A-Z0-9_]+\}/g, "1")) as TaskDefinition;
}

function values(entries: { name: string; value: string }[]): Record<string, string> {
  return Object.fromEntries(entries.map((entry) => [entry.name, entry.value]));
}

describe("attendance report ECS task definitions", () => {
  test("API renders a task role, read pool, storage, and queue configuration", async () => {
    const task = await renderTemplate("api");
    const container = task.containerDefinitions[0]!;
    expect(task.taskRoleArn).toBe("1");
    expect(values(container.environment)).toMatchObject({
      READ_DATABASE_HOST: "1",
      READ_DATABASE_PORT: "6432",
      READ_DATABASE_NAME: "api_read",
      S3_REGION: "1",
      S3_APP_FILES_BUCKET: "1",
      S3_PRESIGN_TTL_SECONDS: "900",
    });
    expect(values(container.secrets)).toHaveProperty("REDIS_URL");
    expect(values(container.secrets)).toHaveProperty("DATABASE_CA_CERT");
  });

  test("workers render their task role, distinct read pool, storage, and verified TLS CA", async () => {
    const task = await renderTemplate("workers");
    const container = task.containerDefinitions[0]!;
    expect(task.taskRoleArn).toBe("1");
    expect(values(container.environment)).toMatchObject({
      READ_DATABASE_HOST: "1",
      READ_DATABASE_PORT: "6432",
      READ_DATABASE_NAME: "workers_read",
      S3_REGION: "1",
      S3_APP_FILES_BUCKET: "1",
    });
    expect(values(container.secrets)).toHaveProperty("DATABASE_CA_CERT");
  });
});

interface FullTaskDefinition {
  containerDefinitions: {
    name: string;
    image?: string;
    essential?: boolean;
    environment?: { name: string; value: string }[];
    secrets?: { name: string; valueFrom: string }[];
    dependsOn?: { containerName: string; condition: string }[];
    healthCheck?: { command: string[]; startPeriod?: number };
  }[];
}

/** Renders like render.sh does: every ${VAR} replaced, here with its own name so values are traceable. */
async function renderNamed(service: "api" | "workers"): Promise<FullTaskDefinition> {
  const template = await readFile(
    join(import.meta.dir, "ecs", service, "task-definition.json.tpl"),
    "utf8",
  );
  return JSON.parse(
    template.replaceAll(/\$\{([A-Z0-9_]+)\}/g, (_, name: string) => `<${name}>`),
  ) as FullTaskDefinition;
}

describe("production readiness of the ECS task definitions", () => {
  test("the API gets its tier, web origin, CORS allowlist and OAuth redirect URIs", async () => {
    const api = (await renderNamed("api")).containerDefinitions[0]!;
    expect(values(api.environment!)).toMatchObject({
      APP_ENV: "<APP_ENV>",
      FRONTEND_URL: "<WEB_ORIGIN>",
      CORS_ALLOWED_ORIGINS: "<WEB_ORIGIN>",
      GOOGLE_OAUTH_REDIRECT_URI: "<API_ORIGIN>/api/auth/oauth/google/callback",
      MICROSOFT_OAUTH_REDIRECT_URI: "<API_ORIGIN>/api/auth/oauth/microsoft/callback",
    });
  });

  test("the API reads sign-in and bot-check credentials from its app secret", async () => {
    const api = (await renderNamed("api")).containerDefinitions[0]!;
    const secrets = Object.fromEntries(api.secrets!.map((s) => [s.name, s.valueFrom]));
    for (const key of [
      "GOOGLE_OAUTH_CLIENT_ID",
      "GOOGLE_OAUTH_CLIENT_SECRET",
      "MICROSOFT_OAUTH_CLIENT_ID",
      "MICROSOFT_OAUTH_CLIENT_SECRET",
      "TURNSTILE_SECRET_KEY",
    ]) {
      expect(secrets[key]).toBe(`<API_APP_SECRETS_ARN>:${key}::`);
    }
  });

  test("every key the API reads from its app secret exists there by default", async () => {
    // ECS refuses to start a task whose secret references a JSON key that isn't present, so each
    // key must be seeded by app_secret_defaults (or be deliberately required from TF_VAR).
    const api = (await renderNamed("api")).containerDefinitions[0]!;
    const keys = api
      .secrets!.filter((s) => s.valueFrom.startsWith("<API_APP_SECRETS_ARN>:"))
      .map((s) => s.valueFrom.split(":")[1]!);
    const mainTf = await readFile(join(import.meta.dir, "..", "terraform", "main.tf"), "utf8");
    const defaults = /app_secret_defaults = \{\s*api = \{([\s\S]*?)\}/.exec(mainTf)?.[1] ?? "";
    for (const key of keys) {
      expect(defaults).toMatch(new RegExp(`\\b${key}\\s*=\\s*""`));
    }
  });

  test("the API and workers get the AI provider settings and its key from their app secrets", async () => {
    const api = (await renderNamed("api")).containerDefinitions[0]!;
    expect(values(api.environment!)).toMatchObject({
      AI_LLM_ENABLED: "<AI_LLM_ENABLED>",
      AI_LLM_PROVIDER: "<AI_LLM_PROVIDER>",
      AI_LLM_BASE_URL: "<AI_LLM_BASE_URL>",
      AI_LLM_SMALL_MODEL: "<AI_LLM_SMALL_MODEL>",
      AI_LLM_LARGE_MODEL: "<AI_LLM_LARGE_MODEL>",
    });
    expect(api.secrets).toContainEqual({
      name: "AI_LLM_API_KEY",
      valueFrom: "<API_APP_SECRETS_ARN>:AI_LLM_API_KEY::",
    });

    const workers = (await renderNamed("workers")).containerDefinitions.find(
      (c) => c.name === "workers",
    )!;
    expect(values(workers.environment!)).toMatchObject({
      AI_LLM_PROVIDER: "<AI_LLM_PROVIDER>",
      AI_LLM_BASE_URL: "<AI_LLM_BASE_URL>",
    });
    expect(workers.secrets).toContainEqual({
      name: "AI_LLM_API_KEY",
      valueFrom: "<WORKERS_APP_SECRETS_ARN>:AI_LLM_API_KEY::",
    });
    const mainTf = await readFile(join(import.meta.dir, "..", "terraform", "main.tf"), "utf8");
    expect(mainTf).toMatch(/workers = \{[^}]*\bAI_LLM_API_KEY = ""/);
  });

  test("the API and workers reach ERPNext through the rendered URL and their app-secret key", async () => {
    const api = (await renderNamed("api")).containerDefinitions[0]!;
    expect(values(api.environment!)).toMatchObject({
      ERPNEXT_API_URL: "<ERPNEXT_API_URL>",
      ERPNEXT_SITE_DOMAIN: "<ERPNEXT_SITE_DOMAIN>",
    });
    expect(api.secrets).toContainEqual({
      name: "ERPNEXT_API_KEY",
      valueFrom: "<API_APP_SECRETS_ARN>:ERPNEXT_API_KEY::",
    });

    const workers = (await renderNamed("workers")).containerDefinitions.find(
      (c) => c.name === "workers",
    )!;
    expect(values(workers.environment!)).toMatchObject({ ERPNEXT_API_URL: "<ERPNEXT_API_URL>" });
    expect(workers.secrets).toContainEqual({
      name: "ERPNEXT_API_KEY",
      valueFrom: "<WORKERS_APP_SECRETS_ARN>:ERPNEXT_API_KEY::",
    });
    const mainTf = await readFile(join(import.meta.dir, "..", "terraform", "main.tf"), "utf8");
    expect(mainTf).toMatch(/workers = \{[^}]*\bERPNEXT_API_KEY = ""/);

    // ERPNext's webhooks are verified by the API; the daily reconciliation is triggered by the
    // workers calling the API with the shared service key.
    expect(api.secrets).toContainEqual({
      name: "ERPNEXT_WEBHOOK_SECRET",
      valueFrom: "<API_APP_SECRETS_ARN>:ERPNEXT_WEBHOOK_SECRET::",
    });
    expect(api.secrets).toContainEqual({
      name: "RECONCILIATION_API_KEY",
      valueFrom: "<API_APP_SECRETS_ARN>:RECONCILIATION_API_KEY::",
    });
    expect(values(workers.environment!)).toMatchObject({ API_BASE_URL: "<API_ORIGIN>" });
    expect(workers.secrets).toContainEqual({
      name: "RECONCILIATION_API_KEY",
      valueFrom: "<WORKERS_APP_SECRETS_ARN>:RECONCILIATION_API_KEY::",
    });
    expect(mainTf).toMatch(/workers = \{[^}]*\bRECONCILIATION_API_KEY = ""/);

    // render.sh derives the URL from the plane's internal ALB, empty (integration off) in dev.
    const render = await readFile(join(import.meta.dir, "scripts", "render.sh"), "utf8");
    expect(render).toContain("output -json erpnext_internal_alb_dns_name");
    expect(render).toMatch(/export ERPNEXT_API_URL=/);
    for (const tier of ["dev", "staging", "prod"]) {
      const env = await readFile(join(import.meta.dir, "environments", `${tier}.env`), "utf8");
      expect(env).toMatch(/^ERPNEXT_SITE_DOMAIN=\S+/m);
    }
  });

  test("the API gets the in-app purchase ids from its tier and the Play secrets from its app secret", async () => {
    const api = (await renderNamed("api")).containerDefinitions[0]!;
    const ids = [
      "AI_STORE_PRODUCT_ID",
      "APPLE_IAP_BUNDLE_ID",
      "APPLE_IAP_APP_APPLE_ID",
      "GOOGLE_PLAY_PACKAGE_NAME",
    ];
    expect(values(api.environment!)).toMatchObject(
      Object.fromEntries(ids.map((name) => [name, `<${name}>`])),
    );
    for (const key of ["GOOGLE_PLAY_SERVICE_ACCOUNT", "GOOGLE_PLAY_RTDN_TOKEN"]) {
      expect(api.secrets).toContainEqual({
        name: key,
        valueFrom: `<API_APP_SECRETS_ARN>:${key}::`,
      });
    }
    // Every tier defines each id (empty = that store is off), so envsubst never renders a stale shell
    // value into the task definition.
    for (const tier of ["dev", "staging", "prod"]) {
      const env = await readFile(join(import.meta.dir, "environments", `${tier}.env`), "utf8");
      for (const name of ids) expect(env).toMatch(new RegExp(`^${name}=`, "m"));
    }
  });

  test("every deploy tier sets each AI variable the task definitions reference", async () => {
    for (const tier of ["dev", "staging", "prod"]) {
      const env = await readFile(join(import.meta.dir, "environments", `${tier}.env`), "utf8");
      for (const key of [
        "AI_LLM_ENABLED",
        "AI_LLM_PROVIDER",
        "AI_LLM_BASE_URL",
        "AI_LLM_SMALL_MODEL",
        "AI_LLM_LARGE_MODEL",
      ]) {
        expect(env).toMatch(new RegExp(`^${key}=\\S+`, "m"));
      }
    }
  });

  test("workers link emails to the web origin and scan through a healthy ClamAV sidecar", async () => {
    const task = await renderNamed("workers");
    const workers = task.containerDefinitions.find((c) => c.name === "workers")!;
    const clamav = task.containerDefinitions.find((c) => c.name === "clamav")!;

    expect(values(workers.environment!)).toMatchObject({
      FRONTEND_URL: "<WEB_ORIGIN>",
      CLAMAV_HOST: "127.0.0.1",
    });
    // No scan may run before clamd has loaded its signatures.
    expect(workers.dependsOn).toEqual([{ containerName: "clamav", condition: "HEALTHY" }]);

    expect(clamav.image).toBe("<CLAMAV_IMAGE>");
    expect(clamav.essential).toBe(true);
    // The upstream clamdcheck.sh dials `localhost` (::1) and never sees clamd's 127.0.0.1 bind.
    expect(clamav.healthCheck!.command).toEqual(["CMD-SHELL", "studafy-clamdcheck.sh"]);
    expect(clamav.healthCheck!.startPeriod).toBeGreaterThanOrEqual(120);
  });

  test("every deploy tier defines the values these templates render", async () => {
    for (const tier of ["dev", "staging", "prod"]) {
      const env = await readFile(join(import.meta.dir, "environments", `${tier}.env`), "utf8");
      for (const name of ["APP_ENV", "WEB_ORIGIN", "API_ORIGIN"]) {
        expect(env).toMatch(new RegExp(`^${name}=\\S+`, "m"));
      }
    }
    const prod = await readFile(join(import.meta.dir, "environments", "prod.env"), "utf8");
    expect(prod).toMatch(/^APP_ENV=production$/m);
    expect(prod).toMatch(/^WEB_ORIGIN=https:\/\/app\.studafy\.com$/m);
    expect(prod).toMatch(/^API_ORIGIN=https:\/\/api\.studafy\.com$/m);
  });
});

describe("task-role storage permissions cover what the apps do", () => {
  // Without these grants the feature fails only in a deployed tier (local S3 credentials are
  // all-powerful), so a regression would surface as "Access Denied" in production, not in CI.
  async function policyBlock(name: string): Promise<string> {
    const tf = await readFile(
      join(import.meta.dir, "..", "terraform", "modules", "compute", "main.tf"),
      "utf8",
    );
    const start = tf.indexOf(`data "aws_iam_policy_document" "${name}"`);
    expect(start).toBeGreaterThan(-1);
    const end = tf.indexOf('\nresource "', start);
    return tf.slice(start, end);
  }

  test("workers can scan, quarantine, derive, export and reconcile", async () => {
    const policy = await policyBlock("workers_reports");
    for (const prefix of ["permanent/*", "quarantine/*", "reports/*", "tenant-*/reports/*"]) {
      expect(policy).toContain(`/${prefix}"`);
    }
    for (const action of ["s3:GetObject", "s3:PutObject", "s3:DeleteObject", "s3:ListBucket"]) {
      expect(policy).toContain(`"${action}"`);
    }
  });

  test("the API can download finance reports and count storage", async () => {
    const policy = await policyBlock("api_storage");
    expect(policy).toContain('/tenant-*/reports/*"');
    expect(policy).toContain('"s3:ListBucket"');
  });
});
