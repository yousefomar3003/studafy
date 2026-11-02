# Redis failover

The Redis 7 HA pair (`infra/terraform/modules/redis`, one ElastiCache replication group, 2 cache
clusters, `automatic_failover_enabled = true`, `multi_az_enabled = true`) has promoted its replica,
or needs one promoted deliberately. The pair is shared by four workloads on three logical DBs:
BullMQ queues (DB 1, `apps/workers`), pub/sub (DB 0 connection, `apps/realtime`), API rate-limit
state + entitlements cache (DB 0, `apps/api` — fails open), and the ERPNext plane's own RQ
queue/cache (DBs 2–3). Usage conventions: `docs/runbooks/redis-conventions.md`. Instance
provisioning: `infra/terraform/modules/redis/README.md`.

## Detection

- **The `redis-engine-cpu-high` CloudWatch alarm** (`{name_prefix}-redis-engine-cpu-high`,
  `EngineCPUUtilization` > 75% for 10 min) is the standing signal but is _not_ a failover detector
  — it fires on a hot instance, not on promotion. Promotion is detected by:
- **Client-visible drop**: workers/realtime connection errors, BullMQ stalled jobs
  (`bullmq_queue_jobs{state="stalled"}`), RQ `Worker ... attempting to reconnect` lines — a
  primary failure terminates the primary's connections and the clients reconnect through the
  replication group's DNS.
- **`OOM command not allowed` errors** (`noeviction` applies instance-wide — the dangerous
  variant, because `noeviction` is the one correct policy for queue DBs and the whole instance
  shares it). This is a page-worthy `DatabaseMemoryUsagePercentage` condition
  (`redis-conventions.md`), not something the cache absorbs gracefully.
- **The replication group's own state**: `aws elasticache describe-replication-groups` showing the
  group or a node group not `available`.

## Decision points

1. **Automatic failover or manual?** Automatic (a node failure, AZ disruption, or the primary
   becoming unreachable) is the case where the pair _should_ heal itself. Manual is the drill
   (`aws elasticache test-failover`) and the deliberate case — do not run `test-failover`
   mid-incident; it _forces_ a promotion you may not want while the pair is already recovering.
2. **Failover or outage?** If `describe-replication-groups` shows the group stuck non-`available`
   or both nodes `unavailable`, this is an ElastiCache/AWS problem, not a failover — the
   replication-group DNS endpoint won't reconnect to a node that isn't there. Escalate to AWS
   support rather than treating it as a passive disconnect. Same test as DR README's
   decision 1: confirm scope before acting.
3. **Is the blast radius the pair or a consumer?** A single workload misbehaving (only BullMQ
   stalling, only `apps/realtime` dropping) with a healthy pair is a client bug (bad
   `REDIS_URL`/DB index, wrong subscription prefix), not a failover. The pair fails over as one
   unit — every consumer reconnects together; asymmetric symptoms point at the client.

## Procedure

**1. Confirm the pair's state and endpoints.**

```bash
REPL_GROUP="$(terraform -chdir=infra/terraform output -raw redis_replication_group_id)"
aws elasticache describe-replication-groups --replication-group-id "$REPL_GROUP" \
  --query 'ReplicationGroups[0].{status:Status,nodeGroups:NodeGroups[0].{id:NodeGroupId,status:Status,nodes:NodeGroupMembers[].{id:CacheClusterId,role:PreferredAvailabilityZone-ish}} }'
```

`Status: available` (group) and `Status: available` (node group) is a healthy pair regardless of
which node is primary. Read `PrimaryEndpoint`/`ReaderEndpoint` (the module's own outputs
`redis_primary_endpoint` / `redis_reader_endpoint` are the stable handles — never hardcode a node
IP, the identifiers change on promotion).

**2. Identify the new primary / confirm failover actually took place.**

```bash
aws elasticache describe-replication-groups --replication-group-id "$REPL_GROUP" \
  --query 'ReplicationGroups[0].NodeGroups[0].NodeGroupMembers[].{role:MetricName?,ok:'"'"'n/a'"'"'}' 2>/dev/null \
  ; aws elasticache describe-cache-clusters --show-cache-node-info \
  --query 'CacheClusters[].CacheNodes[].{id:CacheClusterId,endpoint:Endpoint.Address,isPrimary:no}'
```

`test-failover` posts the drill result to the group's CloudWatch metrics (PrimaryNodeId /
`redis-engine-cpu` per node) — for a real incident, the promotion also shows in the client
reconnects. The authoritative check the module's own README uses for the drill is
`describe-replication-groups` and confirming the previous replica is now PRIMARY.

**3. Confirm every consumer reconnected.** The replication group's DNS endpoint repoints to the new
primary automatically; `ioredis` resolves it per connection, so no client restart is expected:

- Wait — the OTel/Prometheus stack stops reporting a `redis-engine-cpu` datapoint from the old
  primary; fresh datapoints from the new node is the "the pair is being scraped again" signal.
- BullMQ: queue depth/history flow resumes (Workers dashboard `bullmq_*`), no new stalls.
- `apps/workers`/`apps/realtime`: connection logs show a successful reconnect, no `ECONNREFUSED`
  to the old node IP (a client _pinned_ to a node IP is a bug — connection URLs must use the
  `rediss://:<token>@<primary_endpoint>:<port>/<db>` form from `redis-conventions.md`).
- `apps/api`: rate-limiter `rl:` keys re-established (fails open by design, so no intentional
  interruption — but confirm `OOM command not allowed` stopped).

**4. Wait out the group's own convergence.** ElastiCache promotes ASYNC; the replication group
keeps a brief read-only period during failover and the old primary rejoins as replica. Expect
seconds-to-low-minutes. A legitimate failover with `noeviction` means a brief **write pause** on
DB 1 (queues) — BullMQ retries/backs off; that is the designed behavior, not an emergency.

**5. Manual failover only when asked for it — the drill.** See
`infra/terraform/modules/redis/README.md`'s "Running the dev failover drill" for the exact
`aws elasticache test-failover` sequence (fetch `NodeGroupId`, `test-failover`, poll until
`available`). Never run this against staging/prod without a change window; `test-failover` is not
zero-impact even though the client reconnects.

**6. If the pair is actually down (outage shape), decide on data not yet in RDS.** BullMQ job
state lives only in Redis; snapshot restore (`snapshot_retention_limit` defaults to 1 day) is the
recovery mechanism and restores to a _point in time_, losing jobs failed after the snapshot. This
is why ingestion/delivery are designed to be re-drivable from durable sources (billing rows, outbox
events, `notification_dead_letters`) — treat a lost-job drain as the `webhook-dlq-drain.md`
procedure, not a "restore and forget."

## Rollback / abort criteria

- If the group is non-`available` and stuck, stop waiting and escalate (decision 2) — this is not
  a convergence-to-wait-out issue.
- If a manual `test-failover` was started and the pair is mid-recovery, do **not** start a second
  one to "undo" it. One promotion at a time.
- If clients are pinned to a node IP (step 3), fix the connection string through the deploy path
  (`deploy-rollback.md`), not by pointing the failed client at the other node by hand.

## Known gaps

- **No compute tier connects today** — the "consumers reconnected" step is currently only
  exercisable with a manual `redis-cli`/script from the bastion
  (`redis-conventions.md`'s Known gaps). This runbook is written for the moment one does.
- **No alarm specifically for failover or for the replication group going unavailable** — the
  alarm set surface is `redis-engine-cpu-high` (hot, not down) plus dashboard widgets
  (`CurrConnections`, `Evictions`). A `Status`-based or `EngineCPUUtilization`-zero alarm is a
  natural follow-up, and is what "a failover pages someone" will need once notification ownership
  exists (see `modules/monitoring/README.md`).
