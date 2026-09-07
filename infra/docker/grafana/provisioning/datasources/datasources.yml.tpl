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
    access: proxy
    url: http://prometheus.metrics.internal:9090
    isDefault: true
    jsonData:
      timeInterval: 30s

  # Node/infra-level metrics: ECS Container Insights (CPU/memory/network per service), RDS, and
  # ElastiCache — signals Fargate's own boundary makes impossible to get any other way (no host to
  # run node_exporter against — see this module's README's "What this module does not do").
  - name: CloudWatch
    type: cloudwatch
    access: proxy
    jsonData:
      authType: default
      defaultRegion: ${AWS_REGION}
