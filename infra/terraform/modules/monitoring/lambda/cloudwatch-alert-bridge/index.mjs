/**
 * CloudWatch alarm -> Alertmanager bridge (ST-262).
 *
 * ## Why this exists
 *
 * Some of what has to be alerted on is visible only to CloudWatch and can never reach Prometheus:
 * RDS replica lag and free storage, ElastiCache engine CPU, ECS task CPU/memory (there is no host
 * to run node_exporter against on Fargate), ACM certificate expiry, and the ST-149 synthetic
 * realtime probe. Without this bridge those would need their own notification stack — their own
 * receivers, their own severity vocabulary, their own silence mechanism, their own noisy-alert
 * review — and the two stacks would be kept in agreement by hand until they were not.
 *
 * So CloudWatch alarms publish to SNS, SNS invokes this, and this translates each alarm state
 * change into an Alertmanager alert. One routing surface, one severity matrix, one place to silence
 * something at 3am.
 *
 * ## Zero npm dependencies
 *
 * `fetch` is a Node built-in on nodejs22.x and there is nothing else to import — the same posture
 * as the realtime probe next door (`lambda/realtime-probe/index.mjs`), and the reason neither needs
 * a build step or a lockfile.
 *
 * ## State mapping
 *
 *   ALARM             -> fire
 *   OK                -> resolve
 *   INSUFFICIENT_DATA -> logged and ignored, deliberately
 *
 * INSUFFICIENT_DATA is not a third opinion about the system, it is the absence of one. Treating it
 * as a resolve would close a page because a datapoint went missing; treating it as a fire would
 * page for a metric that simply has no traffic. Alarms where missing data genuinely *is* the signal
 * set `treat_missing_data = "breaching"` instead (the probe alarm does), which CloudWatch reports
 * as ALARM and this handles as one.
 */

const ALERTMANAGER_URL = process.env.ALERTMANAGER_URL;
const RUNBOOK_BASE_URL = process.env.RUNBOOK_BASE_URL;
const CATALOG = JSON.parse(process.env.ALARM_CATALOG ?? "{}");
const POST_TIMEOUT_MS = Number(process.env.POST_TIMEOUT_MS ?? "5000");

/**
 * How far ahead a firing alert's `endsAt` is set.
 *
 * This is the one genuinely non-obvious part of the translation. Prometheus re-sends every firing
 * alert on every evaluation cycle, so Alertmanager can expire anything it stops hearing about.
 * CloudWatch does the opposite: it notifies once, on the state *change*, and then says nothing for
 * as long as the alarm stays in ALARM. An alert pushed with no `endsAt` is expired by Alertmanager
 * after its `resolve_timeout` (5m), which would close the page while the alarm is still ringing.
 *
 * So a firing alert is pushed with an explicit far-future `endsAt` and is resolved only by the
 * matching OK notification. The horizon is the blast radius of a *lost* OK notification: 24h is
 * long enough that no real incident outlives it, and short enough that a stuck alert clears itself
 * within a day rather than needing a manual silence forever.
 */
const FIRING_HORIZON_MS = 24 * 60 * 60 * 1000;

/**
 * Alertmanager's own label-name grammar: `[a-zA-Z_][a-zA-Z0-9_]*`. CloudWatch alarm names are
 * kebab-case, so they are only ever used as a label *value* here, never as a name — but the state
 * reason and the alarm name both reach the payload verbatim, so nothing here builds a label name
 * from input at all. Kept as an assertion rather than a sanitiser: every label name below is a
 * literal in this file.
 */
function alertFor(alarm, catalogEntry, nowMs) {
  const firing = alarm.NewStateValue === "ALARM";
  const startedAt = Date.parse(alarm.StateChangeTime);
  // A malformed StateChangeTime must not produce an Invalid Date in the payload, which Alertmanager
  // rejects for the whole batch — losing a page over a timestamp format.
  const startsAt = Number.isNaN(startedAt) ? nowMs : startedAt;

  return {
    labels: {
      alertname: catalogEntry.alertname,
      severity: catalogEntry.severity,
      service: catalogEntry.service,
      // The two labels that say where this came from. `source` is what lets an operator tell a
      // bridged alarm from a Prometheus rule at a glance in the Alertmanager UI, and `alarm_name`
      // is the handle for `aws cloudwatch describe-alarms` / the console.
      source: "cloudwatch",
      alarm_name: alarm.AlarmName,
    },
    annotations: {
      // The alarm's own description, not a copy of it kept here. `alarm_description` in
      // modules/monitoring/alerts.tf is the single place that sentence is written, and CloudWatch
      // carries it in the notification — so there is nothing to keep in sync.
      summary: alarm.AlarmDescription ?? alarm.AlarmName,
      // Why CloudWatch decided this: the threshold, the datapoints and the period it evaluated.
      description: alarm.NewStateReason ?? "",
      // Derived rather than carried in the catalog, for the same reason the summary is not
      // duplicated: the anchor is mechanically `alertname` lowercased (GitHub's own heading-anchor
      // rule for the `### AlertName` headings in the catalog), and Lambda environment variables
      // share a 4KB budget that 14 full URLs would eat into for no benefit.
      // scripts/check-alert-rules.ts checks these anchors resolve, exactly as it does for the
      // runbook_url annotations in the Prometheus rules.
      runbook_url: `${RUNBOOK_BASE_URL}#${catalogEntry.alertname.toLowerCase()}`,
    },
    generatorURL: `https://${alarm.Region ?? "eu-central-1"}.console.aws.amazon.com/cloudwatch/home#alarmsV2:alarm/${encodeURIComponent(alarm.AlarmName)}`,
    startsAt: new Date(startsAt).toISOString(),
    endsAt: new Date(firing ? nowMs + FIRING_HORIZON_MS : nowMs).toISOString(),
  };
}

export async function handler(event) {
  const nowMs = Date.now();
  const alerts = [];

  for (const record of event.Records ?? []) {
    let alarm;
    try {
      alarm = JSON.parse(record.Sns.Message);
    } catch {
      // Not a CloudWatch alarm notification. Nothing else is subscribed to these topics, so this
      // means someone published to one by hand — log it and keep going rather than failing the
      // whole batch and taking any real alarms in it down with this one.
      console.error(
        JSON.stringify({ event: "alert_bridge_unparseable_message", subject: record.Sns?.Subject }),
      );
      continue;
    }

    const catalogEntry = CATALOG[alarm.AlarmName];
    if (catalogEntry === undefined) {
      // An alarm exists that this module's catalog does not know about — someone created one
      // outside `local.cloudwatch_alarms` and pointed it here. It cannot be routed (no severity),
      // so it is logged loudly rather than paged at a guessed severity.
      console.error(
        JSON.stringify({ event: "alert_bridge_unknown_alarm", alarm_name: alarm.AlarmName }),
      );
      continue;
    }

    if (alarm.NewStateValue !== "ALARM" && alarm.NewStateValue !== "OK") {
      console.warn(
        JSON.stringify({
          event: "alert_bridge_state_ignored",
          alarm_name: alarm.AlarmName,
          state: alarm.NewStateValue,
        }),
      );
      continue;
    }

    alerts.push(alertFor(alarm, catalogEntry, nowMs));
  }

  if (alerts.length === 0) return { forwarded: 0 };

  const response = await fetch(`${ALERTMANAGER_URL}/api/v2/alerts`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(alerts),
    signal: AbortSignal.timeout(POST_TIMEOUT_MS),
  });

  if (!response.ok) {
    // Throwing is load-bearing, not laziness: SNS retries a failed Lambda invocation (twice, with
    // backoff) and then sends it to the configured dead-letter destination or drops it. Swallowing
    // the error would turn "Alertmanager was restarting" into a page that was never delivered and
    // never retried, with a successful invocation in the logs to prove nothing was wrong.
    throw new Error(
      `alertmanager rejected ${alerts.length} alert(s): ${response.status} ${await response.text()}`,
    );
  }

  return { forwarded: alerts.length };
}
