# Loki config for the log-aggregation pipeline (ST-261). Baked into infra/docker/loki.Dockerfile;
# docker-entrypoint.sh runs envsubst over it at container start.
#
# Only four values genuinely vary per environment, and all four come from
# infra/terraform/modules/logging/loki.tf's container `environment` block:
#   ${LOKI_PORT}            HTTP API port (module var loki_port / module.network loki_port)
#   ${LOKI_CHUNKS_BUCKET}   the loki-chunks S3 bucket (module.logging.chunks_bucket_id)
#   ${AWS_REGION}           region for the S3 client
#   ${LOKI_RETENTION}       compactor retention window = the HOT tier (module var loki_retention)
#
# Everything else is static: single binary (-target=all), single replica, in-memory ring, chunks
# and TSDB index in S3. There is no persistent volume — /loki holds only working scratch that a
# task replacement can rebuild from S3. See infra/terraform/modules/logging/README.md.

auth_enabled: false

server:
  http_listen_port: ${LOKI_PORT}
  grpc_listen_port: 9095
  log_level: info

common:
  path_prefix: /loki
  replication_factor: 1
  ring:
    kvstore:
      store: inmemory
  storage:
    s3:
      bucketnames: ${LOKI_CHUNKS_BUCKET}
      region: ${AWS_REGION}
      # Credentials come from the task role (infra/terraform/modules/logging/loki.tf) via the
      # default AWS provider chain — never set here.

schema_config:
  configs:
    - from: 2024-01-01
      store: tsdb
      object_store: s3
      schema: v13
      index:
        prefix: index_
        period: 24h

limits_config:
  # The HOT window. Lines older than this are removed from the chunks bucket by the compactor
  # below; their copy in the archive bucket (the COLD tier) is a separate store and is untouched.
  retention_period: ${LOKI_RETENTION}
  max_query_lookback: ${LOKI_RETENTION}
  reject_old_samples: true
  reject_old_samples_max_age: 168h
  ingestion_rate_mb: 16
  ingestion_burst_size_mb: 32
  max_label_names_per_series: 20
  # request_id is queried as a structured field (`| json | request_id="..."`), never promoted to a
  # label — it is unbounded-cardinality by construction (one value per request). volume_enabled
  # powers Grafana's log-volume histogram.
  volume_enabled: true

compactor:
  working_directory: /loki/compactor
  compaction_interval: 10m
  retention_enabled: true
  retention_delete_delay: 2h
  delete_request_store: s3

query_range:
  align_queries_with_step: true
  cache_results: true

pattern_ingester:
  enabled: false

analytics:
  reporting_enabled: false
