# Vector, with this repo's own pipeline config baked in (ST-261: log aggregation pipeline).
#
# Build from the repo root, same convention as every other Dockerfile in this directory
# (infra/docker/README.md's "Why the build context is the repo root"):
#   docker build -f infra/docker/vector.Dockerfile -t studafy/vector .
#
# No entrypoint script, unlike infra/docker/loki.Dockerfile / grafana.Dockerfile: Vector
# interpolates ${VAR} / ${VAR:-default} straight from the process environment when it loads its
# config, so the per-environment values (queue URL, Loki endpoint, buckets — see
# infra/terraform/modules/logging/vector.tf) need no envsubst pass. The upstream image's own
# `vector` entrypoint is kept; only the default config path is overridden.

ARG VECTOR_VERSION=0.52.0

FROM timberio/vector:${VECTOR_VERSION}-alpine

COPY --chmod=644 infra/docker/vector/vector.yaml /etc/vector/vector.yaml

CMD ["--config", "/etc/vector/vector.yaml"]
