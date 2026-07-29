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
