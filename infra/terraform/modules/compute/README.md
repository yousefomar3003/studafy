# `compute`

The ECS Fargate baseline `infra/terraform/README.md` and `infra/deploy/README.md` both described as
"future compute-tier module": a cluster, one shared task-execution role, and the ALB target
groups/listener rules `modules/edge`'s HTTPS listener was always designed to accept
(`modules/edge/main.tf`'s header comment). Closes `infra/deploy/README.md`'s "Known gaps" #1-3.

## What this module does not do

- **It does not create the `api`/`realtime`/`workers` ECS services or task definitions.** That is
  `infra/deploy/scripts/deploy.sh`'s job — it already renders
  `infra/deploy/ecs/<service>/{task-definition,service}.json.tpl` and calls `aws ecs
create-service`/`update-service` directly, written against exactly this baseline. Terraform
  owning the service resource _and_ a deploy script imperatively updating it would fight over the
  same resource on every deploy; this module deliberately stops one layer short.
- **It creates no task role.** None of `api`/`realtime`/`workers`/`erpnext` calls an AWS SDK from
  application code today — see `infra/deploy/README.md`'s "Known gaps" #4. The execution role this
  module does create is a different IAM principal: Fargate's own control plane assumes it to pull
  the image and resolve `secrets` entries at task launch, not application code at runtime.
- **It does not touch `modules/edge`.** The HTTPS listener's `default_action` (fixed 404) is left
  exactly as `modules/edge` created it — `aws_lb_listener_rule` resources with a lower priority
  number always win, so the `/*` catch-all rule below makes that default action unreachable without
  editing it.

## Topology

| Resource                           | Count | Purpose                                                                                                                      |
| ---------------------------------- | ----- | ---------------------------------------------------------------------------------------------------------------------------- |
| `aws_ecs_cluster`                  | 1     | Container Insights enabled.                                                                                                  |
| `aws_cloudwatch_log_group`         | 3     | `/${name_prefix}/ecs/{api,realtime,workers}` — the exact names the task-definition templates already reference.              |
| `aws_iam_role.execution`           | 1     | Shared task-execution role. `AmazonECSTaskExecutionRolePolicy` + one attachment per `secrets_service_iam_policy_arns` entry. |
| `aws_lb_target_group.api`          | 1     | `target_type = "ip"` (Fargate `awsvpc`), health check `/readyz`, port 3000.                                                  |
| `aws_lb_target_group.realtime`     | 1     | Same shape, port 3001, longer `deregistration_delay` (draining an open WebSocket takes longer than an HTTP request).         |
| `aws_lb_listener_rule.realtime_ws` | 1     | Priority 10, path `/ws` (the real handshake route in `apps/realtime/src/app.ts`) -> realtime target group.                   |
| `aws_lb_listener_rule.api_default` | 1     | Priority 20, path `/*` -> api target group. Catches everything `/ws` didn't.                                                 |

`workers` gets no target group — it is never behind the ALB (`infra/deploy/README.md`: "no HTTP or
IPC surface at all").

## Usage

```hcl
module "compute" {
  source = "./modules/compute"

  name_prefix         = module.naming.name_prefix
  vpc_id              = module.network.vpc_id
  https_listener_arn  = module.edge.https_listener_arn

  secrets_service_iam_policy_arns = module.secrets.service_iam_policy_arns
}
```

Then, once applied:

```bash
infra/deploy/scripts/populate-env.sh staging   # fills ECS_CLUSTER etc. into environments/staging.env
infra/deploy/scripts/deploy.sh api staging <image-tag>
```

## Inputs

| Name                              | Type          | Default   | Description                                                                |
| --------------------------------- | ------------- | --------- | -------------------------------------------------------------------------- |
| `name_prefix`                     | `string`      | —         | Resource name prefix, from `module.naming.name_prefix`.                    |
| `vpc_id`                          | `string`      | —         | `module.network.vpc_id`.                                                   |
| `https_listener_arn`              | `string`      | —         | `module.edge.https_listener_arn`.                                          |
| `api_container_port`              | `number`      | `3000`    | Must match `infra/deploy/ecs/api/task-definition.json.tpl`.                |
| `realtime_container_port`         | `number`      | `3001`    | Must match `infra/deploy/ecs/realtime/task-definition.json.tpl`.           |
| `health_check_path`               | `string`      | `/readyz` | Shared readiness contract (`apps/api`, `apps/realtime`).                   |
| `log_retention_days`              | `number`      | `30`      | Retention for the three pre-created log groups.                            |
| `secrets_service_iam_policy_arns` | `map(string)` | `{}`      | `module.secrets.service_iam_policy_arns` — attached to the execution role. |

## Outputs

| Name                          | Description                                                                                        |
| ----------------------------- | -------------------------------------------------------------------------------------------------- |
| `cluster_name`, `cluster_arn` | The ECS cluster.                                                                                   |
| `execution_role_arn`          | Add to `module.registry`'s `additional_pull_role_arns`; pass to `deploy.sh` via `populate-env.sh`. |
| `api_target_group_arn`        | Pass as `API_TARGET_GROUP_ARN`.                                                                    |
| `realtime_target_group_arn`   | Pass as `REALTIME_TARGET_GROUP_ARN`.                                                               |
| `log_group_names`             | Map of service -> log group name.                                                                  |

## Known gaps

- **Not exercised against a live AWS account** — same caveat every other module in this repo
  carries (`modules/pgbouncer/README.md`, `modules/registry/README.md`): validated with `terraform
validate` and an offline `plan`, not a real `apply`.
- **No autoscaling.** `desiredCount` is fixed per `infra/deploy/environments/<env>.env`
  (`API_DESIRED_COUNT` etc.), set by `deploy.sh`, not this module. Revisit with
  `aws_appautoscaling_target`/`policy` once real staging traffic gives a signal to scale on.
- **No WAF-level distinction between `/ws` and everything else.** `module.edge`'s WAF rate limits
  (`/auth`, `/schools/register`) were authored before either target group existed; nothing here
  changes that.
