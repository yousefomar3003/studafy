# Grafana Tempo, with this repo's own single-binary storage config baked in (ST-260).
#
# Build from the repo root, same convention as every other Dockerfile in this directory
# (infra/docker/README.md's "Why the build context is the repo root"):
#   docker build -f infra/docker/tempo.Dockerfile -t studafy/tempo .
#
# The upstream image's own binary, user and default CMD are all left alone; this only replaces the
# config file at its default path, the same "no custom build/runtime split" shape as
# prometheus.Dockerfile/otel-collector.Dockerfile.

ARG TEMPO_VERSION=2.9.0

FROM grafana/tempo:${TEMPO_VERSION}

COPY --chmod=644 infra/docker/tempo/tempo.yaml /etc/tempo.yaml
