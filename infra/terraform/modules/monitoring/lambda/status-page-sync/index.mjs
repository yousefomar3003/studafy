// eslint-disable-next-line import-x/no-unresolved -- AWS SDK v3 is bundled with the Lambda runtime, not a repo dependency
import { CloudWatchClient, DescribeAlarmsCommand } from "@aws-sdk/client-cloudwatch";
// eslint-disable-next-line import-x/no-unresolved -- AWS SDK v3 is bundled with the Lambda runtime, not a repo dependency
import { PutObjectCommand, S3Client } from "@aws-sdk/client-s3";

/*
 * Public status page sync (ST-264). Runs every minute via EventBridge, same shape as the two
 * probes next door (lambda/realtime-probe, lambda/synthetics-probe): read the current state of
 * the CloudWatch alarms ../../status_page.tf maps to each public component, and write the result
 * as `components.json` in this repo's own status-page site bucket — the static page
 * (status-page-site/app.js) fetches it same-origin through CloudFront. No third-party account, no
 * credential to read: this Lambda only ever talks to its own bucket and CloudWatch.
 *
 * `ai` maps to the `ai-health` synthetic check (synthetics.tf, ST-264) — a cheap route check
 * against apps/api's `/api/ai/health`, not a real Anthropic call. See status_page.tf's header for
 * why that is the honest signal to use rather than nothing.
 *
 * Runtime: nodejs22.x. Zero npm dependencies beyond the bundled AWS SDK v3 clients
 * (@aws-sdk/client-cloudwatch, @aws-sdk/client-s3) — same posture as every other Lambda in this
 * module.
 */

// AWS_REGION is a Lambda-reserved environment variable (Terraform is not permitted to set it
// itself — see status_page.tf), always populated with the function's own deployment region.
const PRIMARY_REGION = process.env.AWS_REGION;
const DR_REGION = process.env.SYNTHETICS_DR_REGION || null;
const BUCKET_NAME = process.env.BUCKET_NAME;
// { <component>: { primary: [alarmName, ...], dr: [alarmName, ...] }, ... } — built once, in
// Terraform, from the same alarm-naming convention alerts.tf itself uses ("${name_prefix}-${key}"),
// so the mapping cannot drift from the alarms it describes.
const COMPONENT_ALARM_NAMES = JSON.parse(process.env.COMPONENT_ALARM_NAMES ?? "{}");

const cloudwatchPrimary = new CloudWatchClient({ region: PRIMARY_REGION });
// Only instantiated when there is a dr region to describe alarms in — status_page.tf leaves
// SYNTHETICS_DR_REGION empty wherever synthetics_enabled is false, and every component's `dr`
// list is empty in that case too, so cloudwatchDr is simply never called.
const cloudwatchDr = DR_REGION ? new CloudWatchClient({ region: DR_REGION }) : null;
const s3 = new S3Client({ region: PRIMARY_REGION });

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

  const statuses = {};
  for (const [component, alarms] of components) {
    const names = [...(alarms.primary ?? []), ...(alarms.dr ?? [])];
    const states = names.map((name) => alarmStates[name]);

    // Missing/INSUFFICIENT_DATA alarms are not treated as failing — the same "absence of an
    // opinion, not a third one" reasoning the alert bridge (lambda/cloudwatch-alert-bridge) already
    // applies to CloudWatch's own INSUFFICIENT_DATA state. A component this run couldn't get a
    // clean read on keeps its last known status client-side (app.js simply doesn't repaint it) —
    // this Lambda still writes a definite value each run, never "unknown", so the page has no
    // three-state badge to design for.
    const anyFailing = states.some((state) => state === "ALARM");
    statuses[component] = anyFailing ? "major_outage" : "operational";
  }

  const payload = { generatedAt: new Date().toISOString(), components: statuses };

  await s3.send(
    new PutObjectCommand({
      Bucket: BUCKET_NAME,
      Key: "components.json",
      Body: JSON.stringify(payload),
      ContentType: "application/json",
      CacheControl: "no-cache",
    }),
  );

  console.log(JSON.stringify({ msg: "status page sync run", statuses }));

  return { statusCode: 200, body: JSON.stringify(payload) };
};
