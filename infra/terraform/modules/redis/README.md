# `redis`

Redis 7 HA pair (ElastiCache replication group, one primary + one automatic-failover replica)
plus its AUTH token and connection info in Secrets Manager. Usage conventions for the two
logical DBs it provisions: [`docs/runbooks/redis-conventions.md`](../../../../docs/runbooks/redis-conventions.md).

## What this module does not do

- **It does not create a network or security group.** Pass `subnet_group_name` and
  `security_group_ids` from `module.network` (`elasticache_subnet_group_name`,
  `redis_security_group_id`) — same division of responsibility as every other module here.
- **It does not give the cache DB a different eviction policy than the queue DB.** Redis'
  `maxmemory-policy` is a server-wide setting; there is no per-logical-DB override. This module
  sets it to `noeviction` for the whole instance because that is a hard requirement for the
  queue workload (evicted BullMQ job data corrupts queue state) — see the linked runbook for
  what that means for callers using DB 0 as a cache.
- **It does not provision compute to connect to Redis.** No ECS/EC2 exists yet
  (`infra/terraform/README.md`), so "apps connect over TLS" can only be verified today with a
  manual client against the dev endpoint, not through a deployed `apps/api`/`apps/workers`.

## Topology

One `aws_elasticache_replication_group`, fixed at 2 cache clusters (`num_cache_clusters = 2`,
`automatic_failover_enabled = true`, `multi_az_enabled = true`) — a "pair" is what's provisioned,
not a configurable default. `transit_encryption_mode = "required"` rejects plaintext connections
outright; there's no existing plaintext consumer to migrate, so there's no reason to allow one.

| Logical DB | Purpose | Eviction                                |
| ---------- | ------- | --------------------------------------- |
| 0          | Cache   | noeviction (instance-wide; see runbook) |
| 1          | Queues  | noeviction (mandatory for BullMQ)       |

## Usage

```hcl
module "redis" {
  source = "./modules/redis"

  name_prefix         = module.naming.name_prefix
  subnet_group_name   = module.network.elasticache_subnet_group_name
  security_group_ids  = [module.network.redis_security_group_id]
  port                = var.redis_port
}
```

### Running the dev failover drill

```bash
aws elasticache describe-replication-groups \
  --replication-group-id "$(terraform output -raw redis_replication_group_id)" \
  --query 'ReplicationGroups[0].NodeGroups[0].NodeGroupId' --output text

aws elasticache test-failover \
  --replication-group-id "$(terraform output -raw redis_replication_group_id)" \
  --node-group-id <NodeGroupId from above>

# Poll until the replication group's node group status returns to "available",
# then confirm the previous replica is now PRIMARY:
aws elasticache describe-replication-groups \
  --replication-group-id "$(terraform output -raw redis_replication_group_id)"
```

ioredis (used by `apps/workers`/`apps/realtime`) reconnects to the new primary automatically —
it resolves the replication group's DNS endpoint, not a fixed node IP.

## Inputs

| Name                         | Type           | Default               | Description                                                             |
| ---------------------------- | -------------- | --------------------- | ----------------------------------------------------------------------- |
| `name_prefix`                | `string`       | —                     | Resource name prefix, from `module.naming.name_prefix`.                 |
| `subnet_group_name`          | `string`       | —                     | `module.network.elasticache_subnet_group_name`.                         |
| `security_group_ids`         | `list(string)` | —                     | `[module.network.redis_security_group_id]`.                             |
| `port`                       | `number`       | `6379`                | Must match the network module's `redis_port`.                           |
| `engine_version`             | `string`       | `7.1`                 | Must be a `7.x` release (parameter group family is hardcoded `redis7`). |
| `node_type`                  | `string`       | `cache.t4g.micro`     | Dev-appropriate default only — no researched staging/prod sizing yet.   |
| `snapshot_retention_limit`   | `number`       | `1`                   | Days of automatic snapshots retained (0-35).                            |
| `snapshot_window`            | `string`       | `03:00-05:00`         | Daily UTC snapshot window.                                              |
| `maintenance_window`         | `string`       | `sun:05:00-sun:07:00` | Weekly UTC patching window.                                             |
| `auto_minor_version_upgrade` | `bool`         | `true`                | Apply engine minor-version patches automatically.                       |
| `apply_immediately`          | `bool`         | `false`               | `false` in staging/prod — some changes trigger a failover.              |

## Outputs

| Name                       | Description                                                                                                                        |
| -------------------------- | ---------------------------------------------------------------------------------------------------------------------------------- |
| `replication_group_id`     | For the failover drill CLI command above.                                                                                          |
| `primary_endpoint_address` | Write endpoint (host only, not sensitive on its own).                                                                              |
| `reader_endpoint_address`  | Read-replica endpoint.                                                                                                             |
| `port`                     | Echoes `var.port`.                                                                                                                 |
| `auth_secret_arn`          | Secrets Manager ARN holding the AUTH token + connection JSON. Grant IAM read access; the token itself is never a Terraform output. |
| `cache_db_index`           | `0`. Namespace isolation only — see the runbook.                                                                                   |
| `queue_db_index`           | `1`.                                                                                                                               |
