// eslint-disable-next-line import-x/no-unresolved -- AWS SDK v3 is bundled with the Lambda runtime, not a repo dependency
import { CloudWatchClient, DescribeAlarmsCommand } from "@aws-sdk/client-cloudwatch";
// eslint-disable-next-line import-x/no-unresolved -- AWS SDK v3 is bundled with the Lambda runtime, not a repo dependency
import { GetSecretValueCommand, SecretsManagerClient } from "@aws-sdk/client-secrets-manager";

/*
 * Public status page sync (ST-264). Runs every minute via EventBridge, same shape as the two
 * probes next door (lambda/realtime-probe, lambda/synthetics-probe): read the current state of
 * the CloudWatch alarms ../../status_page.tf maps to each public component, and PATCH that
 * component's status on the status-page provider account this repo does not own or provision —
 * see status_page.tf's header for why a provider, and why polling rather than the SNS alert
 * bridge next door (lambda/cloudwatch-alert-bridge) reacts to the same alarms.
 *
 * `ai` is deliberately not a key in COMPONENT_ALARM_NAMES — this repo has no synthetic probe
 * against the Anthropic provider today (docs/runbooks/ai-provider-outage.md's own Detection
 * section says so directly), so there is nothing honest for this Lambda to read for it. Its
 * status is set by hand, same as any AI provider outage is triaged today.
 *
 * Runtime: nodejs22.x. Zero npm dependencies beyond the bundled AWS SDK v3 clients
 * (@aws-sdk/client-cloudwatch, @aws-sdk/client-secrets-manager) and Node 22's global `fetch` —
 * same posture as every other Lambda in this module.
 */

// AWS_REGION is a Lambda-reserved environment variable (Terraform is not permitted to set it
// itself — see status_page.tf), always populated with the function's own deployment region.
const PRIMARY_REGION = process.env.AWS_REGION;
const DR_REGION = process.env.SYNTHETICS_DR_REGION || null;
const MONITORING_SECRET_ARN = process.env.MONITORING_SECRET_ARN;
// { <component>: { primary: [alarmName, ...], dr: [alarmName, ...] }, ... } — built once, in
// Terraform, from the same alarm-naming convention alerts.tf itself uses ("${name_prefix}-${key}"),
// so the mapping cannot drift from the alarms it describes.
const COMPONENT_ALARM_NAMES = JSON.parse(process.env.COMPONENT_ALARM_NAMES ?? "{}");
const TIMEOUT_MS = Number(process.env.TIMEOUT_MS || 8000);

const cloudwatchPrimary = new CloudWatchClient({ region: PRIMARY_REGION });
// Only instantiated when there is a dr region to describe alarms in — status_page.tf leaves
// SYNTHETICS_DR_REGION empty wherever synthetics_enabled is false, and every component's `dr`
// list is empty in that case too, so cloudwatchDr is simply never called.
const cloudwatchDr = DR_REGION ? new CloudWatchClient({ region: DR_REGION }) : null;
const secrets = new SecretsManagerClient({});

async function getSecretValue(arn) {
  const response = await secrets.send(new GetSecretValueCommand({ SecretId: arn }));
  return JSON.parse(response.SecretString);
}

async function fetchWithTimeout(url, options) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    return await fetch(url, { ...options, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

/** Resolves a batch of alarm names to their current StateValue, in one region. Empty input makes
 * no API call — several components (e.g. `realtime`) have no `dr` alarms at all. */
async function describeAlarmStates(client, alarmNames) {
  if (!client || alarmNames.length === 0) return {};
  const response = await client.send(new DescribeAlarmsCommand({ AlarmNames: alarmNames }));
  const states = {};
  for (const alarm of response.MetricAlarms ?? []) {
    states[alarm.AlarmName] = alarm.StateValue;
  }
  return states;
}

export const handler = async () => {
  const components = Object.entries(COMPONENT_ALARM_NAMES);

  const primaryNames = [...new Set(components.flatMap(([, alarms]) => alarms.primary ?? []))];
  const drNames = [...new Set(components.flatMap(([, alarms]) => alarms.dr ?? []))];

  const [primaryStates, drStates] = await Promise.all([
    describeAlarmStates(cloudwatchPrimary, primaryNames),
    describeAlarmStates(cloudwatchDr, drNames),
  ]);
  const alarmStates = { ...primaryStates, ...drStates };

  const credentials = await getSecretValue(MONITORING_SECRET_ARN);
  const apiKey = credentials.STATUS_PAGE_API_KEY;
  const pageId = credentials.STATUS_PAGE_PAGE_ID;

  const results = [];
  for (const [component, alarms] of components) {
    const componentIdKey = `STATUS_PAGE_COMPONENT_ID_${component.toUpperCase()}`;
    const componentId = credentials[componentIdKey];
    if (!componentId) {
      // Not an error worth failing the run over: an operator who hasn't finished wiring a
      // component's id into the monitoring secret yet should see this in the logs, not have every
      // other component's sync blocked on it.
      console.error(
        JSON.stringify({ event: "status_page_component_id_missing", component, componentIdKey }),
      );
      continue;
    }

    const names = [...(alarms.primary ?? []), ...(alarms.dr ?? [])];
    const states = names.map((name) => alarmStates[name]);

    // Missing/INSUFFICIENT_DATA alarms are not treated as failing — the same "absence of an
    // opinion, not a third one" reasoning the alert bridge (lambda/cloudwatch-alert-bridge) already
    // applies to CloudWatch's own INSUFFICIENT_DATA state. A component this run couldn't get a
    // clean read on keeps whatever status the provider already shows, rather than flipping the
    // public page to a false outage over a transient DescribeAlarms gap.
    const anyFailing = states.some((state) => state === "ALARM");
    const status = anyFailing ? "major_outage" : "operational";

    try {
      const response = await fetchWithTimeout(
        `https://api.statuspage.io/v1/pages/${pageId}/components/${componentId}`,
        {
          method: "PATCH",
          headers: { authorization: `OAuth ${apiKey}`, "content-type": "application/json" },
          body: JSON.stringify({ component: { status } }),
        },
      );
      results.push({ component, status, ok: response.ok, httpStatus: response.status });
      if (!response.ok) {
        console.error(
          JSON.stringify({
            event: "status_page_update_failed",
            component,
            httpStatus: response.status,
            body: await response.text().catch(() => ""),
          }),
        );
      }
    } catch (error) {
      results.push({
        component,
        status,
        ok: false,
        error: error instanceof Error ? error.message : String(error),
      });
      console.error(
        JSON.stringify({
          event: "status_page_update_error",
          component,
          error: error instanceof Error ? error.message : String(error),
        }),
      );
    }
  }

  console.log(JSON.stringify({ msg: "status page sync run", results }));

  const failed = results.filter((result) => !result.ok);
  // Same "no consumer but useful for a manual invoke" reasoning as the synthetics probe's return
  // value — EventBridge ignores it, `aws lambda invoke` doesn't.
  return { statusCode: failed.length === 0 ? 200 : 500, body: JSON.stringify({ results }) };
};
