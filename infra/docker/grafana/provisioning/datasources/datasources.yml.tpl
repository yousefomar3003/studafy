# Baked into infra/docker/grafana.Dockerfile, expanded by docker-entrypoint.sh at container start.
#
# The Prometheus URL is static — "prometheus.metrics.internal" never varies per environment, for
# the same reason infra/docker/prometheus/prometheus.yml's scrape targets don't (see
# infra/terraform/modules/monitoring/discovery.tf). ${AWS_REGION} is the one genuinely
# per-environment value here (module.monitoring's aws_region input), so this file is a template,
# not a static file — envsubst fills it in at container start from the container's own environment.

apiVersion: 1

datasources:
  # App-level metrics: RED per route (apps/api, apps/realtime), queue metrics (apps/workers), and
  # DB internals (postgres_exporter/mysqld_exporter) — everything @studafy/observability and the
  # exporters emit. See docs/runbooks/metrics-dashboard-catalog.md for which dashboard panel reads
  # which metric.
  - name: Prometheus
    type: prometheus
    uid: prometheus
    access: proxy
    url: http://prometheus.metrics.internal:9090
    isDefault: true
    jsonData:
      timeInterval: 30s

  # Node/infra-level metrics: ECS Container Insights (CPU/memory/network per service), RDS, and
  # ElastiCache — signals Fargate's own boundary makes impossible to get any other way (no host to
  # run node_exporter against — see this module's README's "What this module does not do"). Also
  # Tempo's "trace to logs" target below: CloudWatch Logs Insights is this repo's actual log store
  # (apps/*'s own NDJSON stdout, see docs/architecture/SAD_28_logging_conventions.md), and Grafana's
  # CloudWatch datasource can query Logs Insights directly — no separate Loki needed.
  - name: CloudWatch
    uid: cloudwatch
    type: cloudwatch
    access: proxy
    jsonData:
      authType: default
      defaultRegion: ${AWS_REGION}

  # Distributed tracing (ST-260): the OTel collector's tail-sampled output. "Trace links from logs"
  # is bidirectional — requestId.ts/activeTraceFields() put trace_id/span_id on every log line
  # (that's the logs -> trace direction), and tracesToLogsV2 below is the trace -> logs direction:
  # a span in the Tempo UI links straight to a Logs Insights query filtered to its own trace_id,
  # across every service's log group at once.
  - name: Tempo
    uid: tempo
    type: tempo
    access: proxy
    url: http://tempo.metrics.internal:3200
    jsonData:
      tracesToLogsV2:
        datasourceUid: cloudwatch
        filterByTraceID: true
        query: 'fields @timestamp, @message | filter trace_id = "$${__trace.traceId}"'
