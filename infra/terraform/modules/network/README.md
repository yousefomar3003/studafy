# `network`

VPC, subnets, routing, security groups and a bastion host for one environment. Diagram and
CIDR/AZ reference: [`docs/runbooks/network-diagram.md`](../../../../docs/runbooks/network-diagram.md).

## Topology

Three subnet tiers, one of each per AZ:

| Tier           | Routes to                   | Holds                                  |
| -------------- | --------------------------- | -------------------------------------- |
| `public`       | Internet gateway            | ALB, NAT gateway(s), bastion           |
| `private-app`  | NAT gateway (outbound only) | Future app-tier compute behind the ALB |
| `private-data` | Nothing outside the VPC     | DB, Redis                              |

`private-data` has no default route at all — not even through NAT. DB/Redis unreachability from
the internet is enforced by routing, not only by security groups, so a scan finding one broken
without the other is a config bug, not "defense in depth working as intended."

Subnet CIDRs are derived from `vpc_cidr` with `cidrsubnet()`, not listed by hand — see the module
source if you need the exact math.

## Security groups

The ALB is the **only** group with ingress from the public internet. Everything else only
accepts traffic from a specific other security group in this module:

```
internet ──► alb ──► app ──► db
                       └────► redis
bastion ───────────────────► db
                       └────► redis
```

`db` and `redis` have no egress rules at all — Terraform revokes AWS's default
allow-all-outbound rule on creation, and this module never adds one back for those two groups.

`app`'s egress is restricted to 443 (`app_egress_cidr_blocks`), the DB/Redis ports, and DNS to
the VPC resolver — nothing else leaves the app tier. Security groups filter by IP, not by domain
name; narrowing `app_egress_cidr_blocks` to specific provider ranges is as far as this module
goes; true FQDN-level egress filtering needs a proxy or AWS Network Firewall, deliberately out of
scope here.

## Bastion

A single EC2 instance in the first public subnet, reachable by SSH only from
`bastion_allowed_ssh_cidrs` (required, `0.0.0.0/0` is rejected by validation). Its sshd auth log
(`/var/log/secure`) is shipped by the CloudWatch agent to a dedicated log group
(`bastion_ssh_log_group_name`) — every login attempt is captured off-box. The instance role can
only write to that one log group. IMDSv2 is enforced and the root volume is encrypted.

The AMI is resolved at plan time from the public `/aws/service/ami-amazon-linux-latest/...` SSM
parameter, not pinned to an ID — it always deploys current Amazon Linux 2023.

Terraform does not create the SSH key pair; create one out of band first
(`aws ec2 create-key-pair` or `import-key-pair`) and pass its name as `bastion_key_name`. Private
keys never belong in Terraform state.

## Usage

```hcl
module "network" {
  source = "./modules/network"

  name_prefix               = module.naming.name_prefix
  vpc_cidr                  = "10.0.0.0/16"
  az_count                  = 2
  bastion_allowed_ssh_cidrs = ["203.0.113.4/32"]
  bastion_key_name          = "studafy-dev-bastion"
}
```

## Inputs

| Name                        | Type           | Default         | Description                                                            |
| --------------------------- | -------------- | --------------- | ---------------------------------------------------------------------- |
| `name_prefix`               | `string`       | —               | Resource name prefix, from `module.naming.name_prefix`.                |
| `vpc_cidr`                  | `string`       | `10.0.0.0/16`   | VPC CIDR, `/20` or larger.                                             |
| `az_count`                  | `number`       | `2`             | `2` or `3` — AWS requires DB/ElastiCache subnet groups to span ≥2 AZs. |
| `single_nat_gateway`        | `bool`         | `true`          | `true`: one shared NAT gateway. `false`: one per AZ.                   |
| `app_ports`                 | `list(number)` | `[3000, 3001]`  | Ports the ALB forwards to the app tier.                                |
| `alb_ingress_cidrs`         | `list(string)` | `["0.0.0.0/0"]` | CIDRs allowed to reach the ALB on 80/443.                              |
| `app_egress_cidr_blocks`    | `list(string)` | `["0.0.0.0/0"]` | CIDRs the app tier may reach on 443.                                   |
| `db_port`                   | `number`       | `5432`          | Placeholder (Postgres); no engine is chosen yet.                       |
| `redis_port`                | `number`       | `6379`          | Matches the `ioredis` default used by `apps/workers`/`apps/realtime`.  |
| `bastion_allowed_ssh_cidrs` | `list(string)` | —               | Required. CIDRs allowed to SSH into the bastion. `0.0.0.0/0` rejected. |
| `bastion_key_name`          | `string`       | —               | Required. Name of an existing EC2 key pair.                            |
| `bastion_instance_type`     | `string`       | `t3.micro`      | Bastion EC2 instance type.                                             |
| `enable_flow_logs`          | `bool`         | `true`          | Ship VPC flow logs to CloudWatch Logs.                                 |
| `flow_log_retention_days`   | `number`       | `90`            | Retention for VPC flow logs.                                           |
| `ssh_log_retention_days`    | `number`       | `90`            | Retention for the bastion's shipped SSH audit log.                     |

## Outputs

| Name                                       | Description                                                    |
| ------------------------------------------ | -------------------------------------------------------------- |
| `vpc_id`, `vpc_cidr`                       | The VPC.                                                       |
| `public_subnet_ids`                        | One per AZ.                                                    |
| `private_app_subnet_ids`                   | One per AZ.                                                    |
| `private_data_subnet_ids`                  | One per AZ.                                                    |
| `db_subnet_group_name`                     | For a future RDS module.                                       |
| `elasticache_subnet_group_name`            | For a future ElastiCache module.                               |
| `nat_gateway_public_ips`                   | App-tier outbound traffic always originates from one of these. |
| `alb_security_group_id`                    | Attach to the load balancer.                                   |
| `app_security_group_id`                    | Attach to app-tier compute.                                    |
| `db_security_group_id`                     | Attach to the database.                                        |
| `redis_security_group_id`                  | Attach to Redis.                                               |
| `bastion_security_group_id`                | The bastion's own group.                                       |
| `bastion_instance_id`, `bastion_public_ip` | The bastion instance.                                          |
| `bastion_ssh_log_group_name`               | Where the SSH audit log lands.                                 |
