# OpenTelemetry Collector, with this repo's own tail-sampling pipeline baked in (ST-260).
#
# Build from the repo root, same convention as every other Dockerfile in this directory
# (infra/docker/README.md's "Why the build context is the repo root"):
#   docker build -f infra/docker/otel-collector.Dockerfile -t studafy/otel-collector .
#
# -contrib, not the core distribution: the tail_sampling processor config.yaml relies on
# (infra/docker/otel-collector/config.yaml) only ships in -contrib. config.yaml is static, not
# templated at container start — see its own header comment for why.
#
# The upstream image's own binary, non-root user and default CMD (`--config=/etc/otelcol-contrib/
# config.yaml`) are all left alone; this only replaces that one file, the same "no custom build/
# runtime split, the base image already is the runtime" shape as prometheus.Dockerfile.

ARG OTEL_COLLECTOR_VERSION=0.139.0

FROM otel/opentelemetry-collector-contrib:${OTEL_COLLECTOR_VERSION}

COPY --chmod=644 infra/docker/otel-collector/config.yaml /etc/otelcol-contrib/config.yaml
