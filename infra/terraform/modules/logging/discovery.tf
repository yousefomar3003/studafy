# --- Loki service discovery ------------------------------------------------------------------
#
# Same shape and same reasoning as modules/monitoring/discovery.tf's `metrics.internal`: a Cloud
# Map private DNS namespace is a Route 53 private hosted zone scoped to its one associated VPC, and
# dev/staging/prod are separate, unpeered VPCs, so a fixed name cannot collide across environments.
# That fixed name is what lets both consumers of Loki's address be static rather than templated at
# container start:
#   - Vector's `loki` sink endpoint (infra/docker/vector/vector.yaml)
#   - Grafana's Loki datasource URL (infra/docker/grafana/provisioning/datasources/datasources.yml.tpl)
#
# Only Loki is registered. Vector has no inbound listener anyone resolves — it pulls from SQS/S3.
# Revisit the fixed-name assumption if the VPCs are ever peered.

resource "aws_service_discovery_private_dns_namespace" "logging" {
  name        = "logging.internal"
  description = "Service discovery for the log-aggregation plane: one A record per Loki task, MULTIVALUE routing."
  vpc         = var.vpc_id
}

resource "aws_service_discovery_service" "loki" {
  name = "loki"

  dns_config {
    namespace_id   = aws_service_discovery_private_dns_namespace.logging.id
    routing_policy = "MULTIVALUE"

    dns_records {
      type = "A"
      ttl  = 10
    }
  }

  # ECS manages registration/deregistration through the service's service_registries block
  # (loki.tf); there is no Route 53 health check to configure here. failure_threshold is a
  # required-by-schema field AWS has deprecated and ignores — set only to satisfy the provider.
  health_check_custom_config {}
}
