import { readFile } from "node:fs/promises";
import { join } from "node:path";

// eslint-disable-next-line import-x/no-unresolved -- "bun:test" is a virtual Bun built-in
import { describe, expect, test } from "bun:test";

// Mirrors infra/deploy/task-definitions.test.ts: substitute every ${VAR} with a placeholder and
// assert the template is valid JSON with the shape preview-up.sh and the runbook promise. Keeps
// the two-container contract (api + web, web waits for api HEALTHY, only web is published) from
// silently drifting.

interface Container {
  name: string;
  essential: boolean;
  dependsOn?: { containerName: string; condition: string }[];
  portMappings?: { containerPort: number }[];
  environment?: { name: string; value: string }[];
  secrets?: { name: string; valueFrom: string }[];
}
interface TaskDefinition {
  networkMode: string;
  requiresCompatibilities: string[];
  taskRoleArn?: string;
  containerDefinitions: Container[];
}

function values(entries: { name: string; value: string }[] = []): Record<string, string> {
  return Object.fromEntries(entries.map((entry) => [entry.name, entry.value]));
}

const rendered = JSON.parse(
  (await readFile(join(import.meta.dir, "task-definition.json.tpl"), "utf8")).replaceAll(
    /\$\{[A-Z0-9_]+\}/g,
    "1",
  ),
) as TaskDefinition;

describe("preview ECS task definition", () => {
  test("is a two-container FARGATE task with no task role", () => {
    expect(rendered.networkMode).toBe("awsvpc");
    expect(rendered.requiresCompatibilities).toEqual(["FARGATE"]);
    // No taskRoleArn: a preview API makes no AWS SDK calls (S3 presigning etc. is not wired for
    // previews), same reasoning as infra/deploy/README.md's "Known gaps" #4 for api/workers.
    expect(rendered.taskRoleArn).toBeUndefined();
    expect(rendered.containerDefinitions.map((c) => c.name)).toEqual(["api", "web"]);
  });

  test("only web is published, and only after api is healthy", () => {
    const api = rendered.containerDefinitions.find((c) => c.name === "api")!;
    const web = rendered.containerDefinitions.find((c) => c.name === "web")!;
    expect(api.portMappings).toBeUndefined();
    expect(web.portMappings).toEqual([{ containerPort: 8080, protocol: "tcp" }]);
    expect(web.dependsOn).toEqual([{ containerName: "api", condition: "HEALTHY" }]);
    expect(api.essential).toBe(true);
    expect(web.essential).toBe(true);
  });

  test("api runs in development mode against the per-PR database over a non-TLS connection", () => {
    const api = rendered.containerDefinitions.find((c) => c.name === "api")!;
    expect(values(api.environment)).toMatchObject({
      NODE_ENV: "development",
      APP_ENV: "development",
      HOST: "127.0.0.1",
      DATABASE_SSL_MODE: "disable",
      DATABASE_NAME: "1",
    });
    // Credentials come from Secrets Manager, never the plaintext environment block.
    expect(Object.keys(values(api.environment))).not.toContain("DATABASE_PASSWORD");
    expect((api.secrets ?? []).map((s) => s.name).sort()).toEqual([
      "DATABASE_PASSWORD",
      "DATABASE_USER",
    ]);
    expect((api.secrets ?? []).every((s) => s.valueFrom.includes("::"))).toBe(true);
  });
});
