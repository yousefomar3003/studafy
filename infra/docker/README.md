# Image build doc: apps/api, apps/workers, apps/realtime, apps/web

Four Dockerfiles, one per deployable, plus a `.dockerignore` at the repo root (Docker only reads
`.dockerignore` from the build context root, and all four images build with the repo root as
context — see "Why the build context is the repo root" below).

| Service         | Dockerfile                         | Runtime base             | Listens on | Measured size\* |
| --------------- | ---------------------------------- | ------------------------ | ---------- | --------------- |
| `apps/api`      | `infra/docker/api.Dockerfile`      | `oven/bun:1.3.14-alpine` | 3000       | 147MB           |
| `apps/workers`  | `infra/docker/workers.Dockerfile`  | `oven/bun:1.3.14-alpine` | —          | 148MB           |
| `apps/realtime` | `infra/docker/realtime.Dockerfile` | `oven/bun:1.3.14-alpine` | 3001       | 147MB           |
| `apps/web`      | `infra/docker/web.Dockerfile`      | `nginx:1.27-alpine`      | 8080       | 93MB            |

\* `docker images` size on this machine, x86_64, with the base images current as of 2026-07-10.
Expect a few MB of drift as upstream Alpine/nginx/Bun patch releases land — see "Image size" below
for why that drift matters more here than it would for a typical image.

## Build

Every image is built **from the repo root**, not from the app's own directory:

```bash
docker build -f infra/docker/api.Dockerfile      -t studafy/api      .
docker build -f infra/docker/workers.Dockerfile  -t studafy/workers  .
docker build -f infra/docker/realtime.Dockerfile -t studafy/realtime .
docker build -f infra/docker/web.Dockerfile      -t studafy/web      .
```

### Why the build context is the repo root

`docs/runbooks/supply-chain-security.md`'s CI example currently shows
`docker build -t "$DIGEST_TAG" apps/api` — a per-app build context. That works for `apps/api`
alone, which has zero workspace runtime dependencies, but not for `apps/workers` or
`apps/realtime` (both depend on `@studafy/constants`) or `apps/web` (depends on `@studafy/ui`):
none of those workspace packages exist inside `apps/<name>/` for a context scoped that narrowly.
All four Dockerfiles need `bun.lock` and the `packages/*` workspace members to run
`bun install --frozen-lockfile` and `turbo run build`, so the context has to be the repo root for
every one of them, and the four `docker build` invocations above are what CI should actually run —
this doc corrects that example; see "Known gaps" for the actual line changed.

## How each image is built

All three Bun services follow the same two-stage shape:

1. **`build`** (`oven/bun:1.3.14-alpine`): `bun install --frozen-lockfile --ignore-scripts`, then
   `bunx turbo run build --filter=@studafy/<name>`. Turbo's task graph
   (`turbo.json`: `dependsOn: ["^build"]`) builds a service's workspace dependencies before the
   service itself — `@studafy/constants` for workers/realtime, `@studafy/ui` for web — so the
   Dockerfile never hand-orders package builds itself.
2. **`runtime`** (fresh `oven/bun:1.3.14-alpine`): copies only `apps/<name>/dist` from the build
   stage. `bun build --target bun` fully bundles the app, its workspace dependencies, and its npm
   dependencies into one `dist/index.js` — the runtime stage never installs `node_modules` at all,
   which is what keeps these images close to "the Bun binary plus a few hundred KB," not "the Bun
   binary plus a whole dependency tree."

`apps/web` differs: its `build` stage is the same Bun/turbo shape, but its `runtime` stage is
`nginx:1.27-alpine` serving the static `vite build` output — there is no Bun runtime, and nothing
server-side, in the final `apps/web` image.

**`--ignore-scripts`** on every `bun install`: the root `package.json`'s `"prepare"` script runs
`lefthook install`, which needs a `.git` directory. `.dockerignore` excludes `.git` from the build
context (a container has no use for git hooks), so `prepare` would fail the install without this
flag. Verified separately that no dependency in this workspace needs a postinstall script to
become usable — `vite`'s `esbuild` resolves its platform binary through `optionalDependencies`,
not `postinstall`.

## Non-root

Every image creates a fixed-uid/gid user (`app`, `10001:10001`) rather than relying on whatever
non-root user (if any) the upstream base image happens to ship, and switches to it before `CMD`/
`ENTRYPOINT` runs. `docker exec <container> whoami` returns `app` for all four; verified locally.

One non-obvious finding from getting this working: Bun's `--target bun` bundle output writes to
its **current working directory** on startup — confirmed empirically, a plain `bun dist/index.js`
with a root-owned `WORKDIR` fails immediately with `bun is unable to write files: AccessDenied`,
before any of the app's own code runs. `apps/api` and `apps/realtime` didn't surface this in a
quick smoke test (whatever they do at startup doesn't happen to need it), but `apps/workers` did.
All three now `chown` the `WORKDIR` itself, not just the `dist/` copied into it, so this doesn't
resurface if a future dependency starts needing it too.

`apps/web`'s nginx runs entirely as the non-root user from PID 1 (never starts as root and drops
privilege) — it listens on 8080, not 80, so it never needs `CAP_NET_BIND_SERVICE`. This required
two changes to the stock `nginx:1.27-alpine` config beyond the non-root user itself:
the compiled-in default pidfile path (`/run/nginx.pid`) isn't writable by a non-root process, so
`infra/docker/web.Dockerfile` `sed`s the existing `pid` directive's _value_ to `/tmp/nginx.pid`
in place (an `nginx -g "pid ...;"` override on the CMD line was tried first and rejected by nginx
as a duplicate directive against the one already in `nginx.conf` — the value has to be edited in
place, not overridden a second way) — and `client_body_temp_path` is redirected to `/tmp/client_temp`
for the same reason.

## Healthcheck instructions

- **`apps/api`, `apps/realtime`**: `HEALTHCHECK` calls the app's own `/healthz` using Bun's `fetch`
  (no `curl`/`wget` dependency needed — `bun` is already in the image). Liveness only, matching
  `/healthz`'s own contract (`apps/api/src/health.ts`, `apps/realtime/src/health.ts`) — it does
  not assert readiness (`/readyz`).
- **`apps/web`**: `HEALTHCHECK` calls nginx's `/healthz` (`infra/docker/web/nginx.conf`) via
  `wget --spider` (BusyBox `wget` ships in the nginx Alpine base already).
- **`apps/workers`**: has no HTTP or IPC surface at all — it's a BullMQ queue consumer, not a
  service (`apps/workers/src/index.ts`). There is nothing to call that would prove more than "the
  container is still running," which Docker already tracks without a `HEALTHCHECK`. Instead,
  `infra/docker/workers/healthcheck.ts` independently opens a raw TCP connection to `REDIS_URL`
  and exits 0/1 on whether that succeeds within 2 seconds — a real check of the one thing that
  actually threatens this process (Redis reachability), not a check that trivially always passes.
  It does **not** reuse the worker's own `ioredis` connection object, so a `healthy` status proves
  "Redis is reachable from this container right now," not "the worker's specific existing
  connection is fine" — verified locally: killing Redis reachability flips the container to
  `unhealthy` within `retries × interval`, unkilling it recovers.

## Image size

The acceptance criterion is `api <150MB`. Measured today: **147MB**. That's a pass, but the margin
is misleadingly thin, and worth understanding why before treating 147MB as a comfortable number:

`oven/bun:1.3.14-alpine` **by itself**, with no application code at all, is **146MB** — almost
entirely one 88.6MB statically-linked `bun` binary (it bundles JavaScriptCore) plus Alpine and
`libgcc`/`libstdc++`. `apps/api/dist/index.js` is 456KB. Swapping the runtime base for bare
`alpine:3.20` plus a `COPY --from=` of just the `bun` binary was tried and measured at 140MB with
_no_ application code yet — so the ~146MB base isn't padded with removable extras; it's
essentially the floor for "a container that can execute a Bun-bundled script," using this Bun
version. `apps/workers` (148MB) and `apps/realtime` (147MB) tell the same story: their `dist/`
bundles are 1.6MB and 0.8MB respectively, i.e. noise against the base.

Practically: there is currently 2-3MB of headroom before `apps/api` crosses 150MB, and no lever
inside this repo closes that gap further without dropping the Bun runtime image entirely (e.g.
`bun build --compile` to a native executable — which embeds the same JS engine, so it does not
shrink the total). If the budget is meant to hold as dependencies are added, either the budget or
the base image choice needs revisiting — this doc is not the place to make that call, it's the
place to say plainly that "147 < 150" today is not the same as "there is room to grow."

`apps/workers` and `apps/realtime` have no stated budget in the ticket; their sizes are reported
above for visibility, not because either failed a criterion.

## SBOM generation

Not baked into the Dockerfiles (an SBOM describes a specific built image; generating one is a
build-time CI step, not something the image itself does). With BuildKit:

```bash
docker buildx build -f infra/docker/api.Dockerfile -t "$DIGEST_TAG" --sbom=true --push .
```

`--sbom=true` attaches an SPDX-format SBOM as a build attestation on the pushed manifest, pullable
with `docker buildx imagetools inspect "$DIGEST_TAG" --format '{{ json .SBOM }}'`. No extra tool
install needed in CI beyond a `docker/setup-buildx-action`-provisioned builder — this is a BuildKit
feature, not a wrapper around a separate SBOM generator like `syft` bolted on afterward.

## Vulnerability scanning (trivy)

```bash
trivy image --severity CRITICAL --exit-code 1 studafy/api
```

Run against all four during this ticket's verification: `apps/api`, `apps/workers`, and
`apps/realtime` (all `oven/bun:1.3.14-alpine`, Alpine 3.22.4) came back clean. `apps/web`
(`nginx:1.27-alpine`, Alpine 3.21.3) did not — `CVE-2026-31789`, a CRITICAL heap-overflow in
`libcrypto3`/`libssl3`, present in the pinned tag's OpenSSL packages. Fixed by adding
`RUN apk upgrade --no-cache` as the first line of `apps/web`'s runtime stage (pulls whatever
patched package versions Alpine's 3.21 branch has published since the base image was last
rebuilt) — re-scanned clean (0 findings at CRITICAL and HIGH) after. This is exactly the gap `trivy
scan has no critical CVEs` as a CI gate exists to catch: the pinned tag drifts out of date against
new advisories even when nothing in this repo changes, so CI needs to run this on every build, not
just at Dockerfile-authoring time.

## Signing (cosign)

Once CI builds these images and pushes to the ECR repositories `infra/terraform/modules/registry`
provisions, `docs/runbooks/supply-chain-security.md` documents the `cosign sign`/`cosign verify`
flow against those repositories' KMS signing key. That doc is updated alongside this one — see
"Known gaps" below for exactly what changed.

## Known gaps

- **`apps/web` has no ECR repository.** `infra/terraform/modules/registry`'s
  `image_repository_names` default is `["api", "realtime", "workers"]`, with an explicit comment
  that `apps/web` "builds to a static bundle... so neither gets a repository here" — written
  before this ticket, when no Dockerfile for `apps/web` existed yet. That reasoning assumed static
  hosting (consistent with the CDN module `infra/terraform/modules/cdn` already provisions for web
  assets), not a containerized nginx deploy. This ticket's acceptance criteria explicitly ask for
  an `apps/web` Dockerfile ("web (static build → nginx)"), so it exists now — but there are two
  live, uncommitted-to deployment shapes for `apps/web` in this repo (CDN-hosted static bundle vs.
  containerized nginx), and only one has a registry repository to push to. This doc doesn't
  resolve that; it's a real decision the registry module's `image_repository_names` will need once
  it's made, not something a Dockerfile can decide on its own.
- **No `.github/workflows` exists yet** to actually run any of the commands in this doc — same
  status `docs/runbooks/supply-chain-security.md` already notes for the registry module itself.
- **`docs/runbooks/supply-chain-security.md`'s build example was corrected**: its
  `docker build -t "$DIGEST_TAG" apps/api` used a per-app build context, which — as explained
  above — only happens to work for `apps/api`. Updated to
  `docker build -f infra/docker/api.Dockerfile -t "$DIGEST_TAG" .` (repo-root context), and its
  "Known gaps" no longer lists "no Dockerfile exists yet" for these three services.
- **`apps/workers`' healthcheck proves Redis reachability, not job-processing health.** A worker
  that's connected to Redis but wedged on a specific job (stuck lock, infinite loop in a handler)
  reports `healthy` — see "Healthcheck instructions" above. Closing that gap needs an
  application-level signal (e.g. a last-processed-job timestamp), which is outside this ticket's
  scope (Dockerfiles, not application code).
- **Fixed a pre-existing bug in `apps/workers/package.json`** while building its Dockerfile:
  `"build": "bun build ./src/index.ts --outdir dist"` was missing `--target bun` (present on the
  otherwise-identical `apps/realtime` script), so `bun run build` crashed on the Node builtins
  `ioredis`/`bullmq` pull in (`tls`, `dns`, `child_process`, `worker_threads`) with "Browser build
  cannot require() Node.js builtin." Not something a Dockerfile could route around — the build
  script itself was broken regardless of where it ran.
