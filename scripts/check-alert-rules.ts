#!/usr/bin/env bun
/**
 * The alerting invariants CI enforces (ST-262's "each alert has a runbook link (CI check on rules
 * file)").
 *
 * ## Division of labour
 *
 * `promtool check rules` and `amtool check-config` already verify that the rules and the routing
 * config are *valid* — PromQL parses, durations are durations, receivers exist. The workflow runs
 * both, from the same pinned images the tasks themselves run (`.github/workflows/ci.yml`'s
 * `alerting` job), so there is no second opinion about what a valid rule is.
 *
 * This script checks the things only this repo can have an opinion about, and which are exactly
 * the things that rot: that every alert carries a severity Alertmanager actually routes, that every
 * alert links a runbook, and that the runbook it links to exists. It needs nothing but the repo, so
 * it runs locally (`bun run scripts/check-alert-rules.ts`) as fast as it runs in CI.
 *
 * ## Both alerting planes, one standard
 *
 * Prometheus rules and CloudWatch alarms are checked together and against the same rules. The
 * alarms are read straight out of `alerts.tf`'s catalog, because a CloudWatch alarm reaches the
 * same on-call rotation through the same Alertmanager and there is no reason it should be allowed
 * to arrive without a runbook when a Prometheus alert may not.
 *
 * The HCL is matched with a regular expression rather than parsed. That is a deliberate limit, not
 * an oversight: the properties checked here are string literals (`alertname = "..."`,
 * `severity = "..."`), a real HCL parser would be a dependency this script otherwise does not need,
 * and a false *pass* is impossible — the failure mode of the regex missing an attribute is a name
 * that never gets anchor-checked, which the orphan check below then catches from the other
 * direction. That is not hypothetical: the first version of this script anchored both patterns to
 * the start of a line and silently skipped the certificate alarms, whose attributes sit inline
 * inside a list literal. The orphan check is what reported it.
 */

import { readdir } from "node:fs/promises";
import { join } from "node:path";

const RULES_DIR = "infra/docker/prometheus/rules";
const ALARMS_FILE = "infra/terraform/modules/monitoring/alerts.tf";
const CATALOG_FILE = "docs/runbooks/alert-catalog.md";

/**
 * The closed set. `infra/docker/alertmanager/alertmanager.yml` has one route per value and no
 * catch-all below them, so a fourth severity would fall through to the root receiver — routed
 * somewhere, but not where its author meant, and nobody would find out until it fired.
 */
const SEVERITIES = new Set(["critical", "warning", "info"]);

/**
 * Annotations every alert must carry, and what each is for on the receiving end.
 *
 * Read out of the annotations object by destructuring rather than by a computed key, so there is no
 * dynamic property access for eslint-plugin-security's detect-object-injection to flag — the same
 * convention `packages/observability/src/queueMetrics.ts` follows, and for the same reason: the
 * disable comment is easier to write than the restructure and worse to read afterwards.
 */
function requiredAnnotationsOf(annotations: Record<string, string> | undefined) {
  const { summary, description, runbook_url: runbookUrl } = annotations ?? {};
  return [
    // What broke, in one line. This is the notification's title at the on-call provider.
    ["summary", summary],
    // Why this fired, with the numbers. Read second, on a phone, at 3am.
    ["description", description],
    // What to do about it. The point of the whole exercise.
    ["runbook_url", runbookUrl],
  ] as const;
}

interface PromRule {
  alert?: string;
  record?: string;
  labels?: Record<string, string>;
  annotations?: Record<string, string>;
}

const failures: string[] = [];

function fail(where: string, message: string): void {
  failures.push(`${where}: ${message}`);
}

/**
 * GitHub's heading-anchor rule, restricted to what this repo's alert headings actually use.
 *
 * Every catalog heading is a single CamelCase alert name, so lowercasing is the whole transform —
 * but spaces and punctuation are handled too, so that a heading someone later writes as
 * `### Api Availability Fast Burn` is matched rather than silently reported as an orphan.
 */
function anchorOf(heading: string): string {
  return heading
    .trim()
    .toLowerCase()
    .replace(/[^\w\- ]/g, "")
    .replace(/ /g, "-");
}

// --- The runbook catalog -------------------------------------------------------------------------

const catalogText = await Bun.file(CATALOG_FILE).text();

// `### AlertName` sections only. The catalog's `##` headings are its structure (severity matrix,
// noisy-alert review, the test-fire drill); its `###` headings are the runbooks themselves, one per
// alert, which is what makes "does this alert have a runbook" a mechanical question.
const catalogAnchors = new Map<string, string>();
for (const match of catalogText.matchAll(/^### (.+)$/gm)) {
  const heading = match[1]!.trim();
  const anchor = anchorOf(heading);
  if (catalogAnchors.has(anchor)) {
    fail(CATALOG_FILE, `two '### ${heading}' sections collide on the anchor '#${anchor}'`);
  }
  catalogAnchors.set(anchor, heading);
}

/** Anchors actually linked to, so an orphaned runbook section can be reported afterwards. */
const referencedAnchors = new Set<string>();

function checkRunbookLink(where: string, url: string): void {
  const hashIndex = url.indexOf("#");
  if (hashIndex === -1) {
    fail(where, `runbook_url '${url}' has no '#anchor' — it must link to a specific alert section`);
    return;
  }

  const path = url.slice(0, hashIndex);
  if (!path.endsWith(CATALOG_FILE)) {
    fail(where, `runbook_url '${url}' does not point at ${CATALOG_FILE}`);
    return;
  }

  const anchor = url.slice(hashIndex + 1);
  referencedAnchors.add(anchor);
  if (!catalogAnchors.has(anchor)) {
    fail(
      where,
      `runbook_url '${url}' points at '#${anchor}', which is not a section in ${CATALOG_FILE}`,
    );
  }
}

// --- Prometheus rules ----------------------------------------------------------------------------

const seenAlertNames = new Map<string, string>();

const ruleFiles = (await readdir(RULES_DIR)).filter((name) => name.endsWith(".yml")).sort();
if (ruleFiles.length === 0) {
  fail(
    RULES_DIR,
    "no rule files found — the glob in prometheus.yml's rule_files would load nothing",
  );
}

for (const fileName of ruleFiles) {
  const path = join(RULES_DIR, fileName);
  const parsed = Bun.YAML.parse(await Bun.file(path).text()) as {
    groups?: { name?: string; rules?: PromRule[] }[];
  };

  for (const group of parsed.groups ?? []) {
    for (const rule of group.rules ?? []) {
      // Recording rules carry no severity and page nobody; they exist to be read by the alerts.
      if (rule.alert === undefined) continue;

      const where = `${path} (${rule.alert})`;

      const previous = seenAlertNames.get(rule.alert);
      if (previous !== undefined) {
        // Two alerts sharing a name are one alert to Alertmanager's grouping and one section in
        // the catalog — so a silence or an inhibition aimed at either hits both.
        fail(where, `alert name is already used in ${previous}`);
      }
      seenAlertNames.set(rule.alert, path);

      const severity = rule.labels?.severity;
      if (severity === undefined) {
        fail(where, "has no severity label, so Alertmanager cannot route it");
      } else if (!SEVERITIES.has(severity)) {
        fail(where, `severity '${severity}' is not one of ${[...SEVERITIES].join("/")}`);
      }

      for (const [annotation, value] of requiredAnnotationsOf(rule.annotations)) {
        if (value === undefined || value.trim() === "") {
          fail(where, `has no '${annotation}' annotation`);
        }
      }

      const runbookUrl = rule.annotations?.runbook_url;
      if (runbookUrl !== undefined && runbookUrl.trim() !== "") {
        checkRunbookLink(where, runbookUrl);
      }
    }
  }
}

// --- CloudWatch alarms ---------------------------------------------------------------------------

const alarmsHcl = await Bun.file(ALARMS_FILE).text();

// The alarms' runbook URLs are not written in the HCL: the bridge Lambda derives each one from
// RUNBOOK_BASE_URL plus the lowercased alertname (see lambda/cloudwatch-alert-bridge/index.mjs).
// So this reconstructs the same anchor the bridge will produce, and checks *that* — which is the
// link an on-call engineer will actually be handed.
for (const match of alarmsHcl.matchAll(/(?<![\w.])alertname\s*=\s*"([^"]+)"/g)) {
  const alertName = match[1]!;
  const anchor = alertName.toLowerCase();
  referencedAnchors.add(anchor);
  if (!catalogAnchors.has(anchor)) {
    fail(
      `${ALARMS_FILE} (${alertName})`,
      `the bridge will link '#${anchor}', which is not a section in ${CATALOG_FILE}`,
    );
  }
}

for (const match of alarmsHcl.matchAll(/(?<![\w.])severity\s*=\s*"([^"]+)"/g)) {
  const severity = match[1]!;
  if (!SEVERITIES.has(severity)) {
    fail(ALARMS_FILE, `severity '${severity}' is not one of ${[...SEVERITIES].join("/")}`);
  }
}

// --- Orphaned runbooks ---------------------------------------------------------------------------
//
// The check in the other direction. A runbook section nothing links to is either a rule that was
// deleted without its documentation, or a documented alert that was never actually defined — and
// the second is the dangerous one, because reading the catalog would tell you that you are covered.
for (const [anchor, heading] of catalogAnchors) {
  if (!referencedAnchors.has(anchor)) {
    fail(CATALOG_FILE, `'### ${heading}' is linked by no alert rule or CloudWatch alarm`);
  }
}

// --- Result --------------------------------------------------------------------------------------

if (failures.length > 0) {
  const prefix = process.env.GITHUB_ACTIONS === "true" ? "::error::" : "";
  for (const failure of failures) {
    console.error(`${prefix}${failure}`);
  }
  console.error(`\n${failures.length} alerting invariant(s) violated.`);
  process.exit(1);
}

console.log(
  `Checked ${seenAlertNames.size} Prometheus alert(s) and ${catalogAnchors.size} runbook section(s): ` +
    `every alert has a routable severity and a runbook that exists.`,
);
