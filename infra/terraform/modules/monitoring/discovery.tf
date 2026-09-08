# --- Scrape-target discovery (ST-259) -------------------------------------------------------
#
# Prometheus on Fargate has no host to run a sidecar-based ECS-API discovery agent against, and
# ECS Service Connect resolves its client alias to *one* healthy replica per lookup (it exists for
# service-to-service calls, not for a scraper that must reach every replica) — neither fits a
# scraper that needs every task's own address. A Cloud Map *private DNS* namespace does: each
# `aws_service_discovery_service` below gets one A record per registered ECS task (MULTIVALUE
# routing, up to 8), so Prometheus's native `dns_sd_configs` (no plugin, no AWS IAM permissions
# needed at all) resolves the whole fleet on every scrape. Registration itself happens where each
# service is actually created:
#   - api/realtime/workers: infra/deploy/ecs/*/service.json.tpl's `serviceRegistries` (populated
#     from this module's outputs via infra/deploy/scripts/populate-env.sh) — those services are
#     deploy.sh-owned, not Terraform-owned (infra/deploy/README.md), so Terraform can only create
#     the Cloud Map *service* (the registration target), not the registration itself.
#   - prometheus/grafana/the exporters: this module's own aws_ecs_service resources below, via
#     `service_registries` directly, since those are Terraform-owned.
#
# Every registration in this namespace is unconditional (cheap — an empty record set costs
# nothing) even where the thing that would register into it is environment-conditional
# (mysqld-exporter, ERPNext-plane-only): a `count`/`for_each` on the Cloud Map service itself would
# only complicate the one place (mysqld_exporter's own aws_ecs_service) that actually needs the
# conditional, for no benefit.

resource "aws_service_discovery_private_dns_namespace" "metrics" {
  # Fixed, not "${var.name_prefix}-metrics.internal": a Cloud Map private DNS namespace is a
  # Route 53 private hosted zone scoped to the one VPC it's associated with (var.vpc_id), and
  # dev/staging/prod are three separate, unpeered VPCs (infra/terraform/README.md's non-overlapping
  # CIDRs). The same zone name in three different VPCs cannot collide — nothing outside a VPC can
  # resolve into it — so this name never needs to vary per environment. That in turn is what lets
  # infra/docker/prometheus/prometheus.yml and infra/docker/grafana/provisioning/**'s datasource
  # URL be static, baked into the image at build time, rather than templated at container start
  # from a value only known at `terraform apply` time. Revisit if dev/staging/prod are ever VPC
  # peered — cross-VPC private-namespace resolution has its own rules this decision doesn't cover.
  name        = "metrics.internal"
  description = "Scrape-target discovery for the Prometheus metrics stack (ST-259): one A record per task, MULTIVALUE routing."
  vpc         = var.vpc_id
}

locals {
  # One `aws_service_discovery_service` per DNS name Prometheus's prometheus.yml (infra/docker/
  # prometheus/prometheus.yml) resolves via dns_sd_configs. Named to match that file exactly.
  discovery_service_names = toset([
    "api",
    "realtime",
    "workers",
    "prometheus",
    "grafana",
    "postgres-exporter",
    "mysqld-exporter",
    # Tracing pipeline (ST-260): apps/*'s OTEL_EXPORTER_OTLP_ENDPOINT resolves "otel-collector.
    # metrics.internal" (see tracing.tf), and the collector itself forwards to "tempo.metrics.
    # internal" (infra/docker/otel-collector/config.yaml) — both Terraform-owned here, same as
    # prometheus/grafana above.
    "otel-collector",
    "tempo",
  ])
}

resource "aws_service_discovery_service" "this" {
  for_each = local.discovery_service_names

  name = each.value

  dns_config {
    namespace_id   = aws_service_discovery_private_dns_namespace.metrics.id
    routing_policy = "MULTIVALUE"

    dns_records {
      type = "A"
      ttl  = 10
    }
  }

  # ECS manages registration/deregistration directly via each aws_ecs_service's
  # service_registries block — there is no separate Route 53 health check to configure here.
  # (failure_threshold is a required-by-schema but AWS-deprecated field: it accepts no value other
  # than the default 1 and AWS ignores it entirely — set only to satisfy the provider's schema.)
  health_check_custom_config {}
}
