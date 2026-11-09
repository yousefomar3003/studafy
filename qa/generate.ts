#!/usr/bin/env bun
// Renders qa/accounts.json and the Bruno login requests from db/seeds/qa-credentials.ts QA_LOGINS
// (QA-02): `bun run qa:generate`. The files are committed so a tester needs neither bun nor the repo's
// dependencies, and packages/db/tests/qa-tenant-seed.test.ts fails when they drift from the seed.
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";

import { QA_LOGINS, QA_SCHOOLS } from "../db/seeds/qa-credentials";
import { isMobileOnly } from "../packages/constants/src";

import type { QaLogin } from "../db/seeds/qa-credentials";

export const QA_DIR = import.meta.dir;

const schoolName = (login: QaLogin) =>
  QA_SCHOOLS.find((school) => school.key === login.school)!.name;

// The channel a role's session has to be on. Member roles get no web session at all
// (WEB_ACCESS_MOBILE_ONLY, apps/api .../web-access.ts); everyone else needs `web`, because admin,
// platform, records and custom-list writes refuse any other channel (CHANNEL_NOT_AUTHORIZED).
export function loginChannel(login: QaLogin): "web" | "mobile" {
  return isMobileOnly([login.role]) ? "mobile" : "web";
}

// The variable a token is stored under: QA_TOKEN_A_ORG_ADMIN, QA_TOKEN_PLATFORM_SUPER_ADMIN, ...
export function tokenVariable(login: QaLogin): string {
  return `QA_TOKEN_${login.school}_${login.role}`.toUpperCase();
}

function renderAccounts(): string {
  const accounts = QA_LOGINS.map((login) => ({
    school: login.school,
    school_name: schoolName(login),
    role: login.role,
    email: login.email,
    channel: loginChannel(login),
    token_variable: tokenVariable(login),
  }));
  return `${JSON.stringify(accounts, null, 2)}\n`;
}

function renderLoginRequest(login: QaLogin, seq: number): string {
  return `meta {
  name: ${schoolName(login)} · ${login.role}
  type: http
  seq: ${seq}
}

post {
  url: {{baseUrl}}/api/auth/login/qa
  body: json
  auth: none
}

body:json {
  {
    "email": "${login.email}",
    "password": "{{qaPassword}}",
    "channel": "${loginChannel(login)}"
  }
}

script:post-response {
  if (res.status === 200) bru.setEnvVar("${tokenVariable(login)}", res.body.access_token);
}

tests {
  test("signed in", () => expect(res.status).to.equal(200));
}
`;
}

// Published path (relative to qa/) -> content, for every generated file.
export function renderQaFiles(): Map<string, string> {
  const files = new Map<string, string>([["accounts.json", renderAccounts()]]);
  QA_LOGINS.forEach((login, index) => {
    const name = `${login.school}-${login.role.toLowerCase().replaceAll("_", "-")}.bru`;
    files.set(`bruno/Login/${name}`, renderLoginRequest(login, index + 1));
  });
  return files;
}

async function main(): Promise<void> {
  for (const [path, content] of renderQaFiles()) {
    const target = resolve(QA_DIR, path);
    await mkdir(dirname(target), { recursive: true });
    await writeFile(target, content);
  }
}

if (import.meta.main) await main();
