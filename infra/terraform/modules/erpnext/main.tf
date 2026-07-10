# ERPNext + Frappe Education plane: EFS-backed bench, five ECS Fargate services, and an internal
# (VPC-only) ALB apps/api reaches as the plane's sole external caller — the "integration gateway"
# restriction is enforced by the erpnext security group's ingress rule (module.network), not by
# this ALB being internal; an internal ALB is still reachable from anything in the VPC that the
# security group allows, which is exactly and only the app tier.
#
# Design note on internal reachability: ECS Service Connect (Cloud Map) was the first design
# considered for apps/api -> erpnext-frontend, but it requires *every* caller to also join the
# Service Connect namespace — including apps/api's own ECS service, which is created by
# infra/deploy/scripts/deploy.sh from infra/deploy/ecs/api/service.json.tpl, not by this module or
# even this ticket's Terraform. That would mean editing a different ticket's already-closed deploy
# manifest just to resolve a hostname. An internal ALB needs none of that: any task in the VPC that
# the security group allows can reach it by its ordinary AWS-assigned DNS name, with zero changes
# to apps/api's service definition. Service Connect is still used, but scoped entirely inside this
# module — frontend's nginx role needs to reach backend/websocket, and all three are Terraform-
# owned here, so there is no cross-ticket ripple for that internal hop.

# --- EFS: the shared Frappe `sites` directory every bench role must mount identically -----------

resource "aws_efs_file_system" "sites" {
  creation_token = "${var.name_prefix}-erpnext-sites"
  encrypted      = true

  tags = { Name = "${var.name_prefix}-erpnext-sites" }
}

resource "aws_efs_mount_target" "sites" {
  for_each = toset(var.private_app_subnet_ids)

  file_system_id  = aws_efs_file_system.sites.id
  subnet_id       = each.value
  security_groups = [var.security_group_id]
}

# uid/gid 1000 matches frappe_docker's documented container user (`frappe`) — a mismatch here is
# the single most common frappe_docker deployment failure (bench refuses to write into a directory
# it doesn't own).
resource "aws_efs_access_point" "sites" {
  file_system_id = aws_efs_file_system.sites.id

  posix_user {
    uid = 1000
    gid = 1000
  }

  root_directory {
    path = "/sites"

    creation_info {
      owner_uid   = 1000
      owner_gid   = 1000
      permissions = "0755"
    }
  }

  tags = { Name = "${var.name_prefix}-erpnext-sites" }
}

# --- Service Connect namespace: internal-only, frontend -> backend/websocket --------------------

resource "aws_service_discovery_http_namespace" "internal" {
  name        = "${var.name_prefix}-erpnext.internal"
  description = "ECS Service Connect namespace for east-west traffic inside the ERPNext plane only (frontend -> backend/websocket). apps/api does not join this namespace — see main.tf's design note."
}

# --- Log groups: one per role, explicit retention like every other log group in this repo -------

resource "aws_cloudwatch_log_group" "role" {
  for_each = toset(["backend", "websocket", "queue", "scheduler", "frontend", "site-setup"])

  name              = "/${var.name_prefix}/ecs/erpnext-${each.key}"
  retention_in_days = var.log_retention_days
}

locals {
  # Environment shared by every bench role (this repo's own erpnext image) — DB_HOST/PORT and the
  # Redis URLs are not sensitive (host/port only), so they're plain environment entries, not
  # secrets. Exact variable names follow frappe_docker's documented container contract as of the
  # version this module pins (infra/docker/erpnext.Dockerfile) — verify against the pinned image's
  # own docs before a real build, same "not exercised against a live account" caveat every other
  # module in this repo carries.
  bench_environment = [
    { name = "DB_HOST", value = var.mariadb_address },
    { name = "DB_PORT", value = tostring(var.mariadb_port) },
    { name = "REDIS_CACHE", value = "redis://${var.redis_primary_endpoint_address}:${var.redis_port}/${var.redis_cache_db}" },
    { name = "REDIS_QUEUE", value = "redis://${var.redis_primary_endpoint_address}:${var.redis_port}/${var.redis_queue_db}" },
    { name = "SOCKETIO_PORT", value = "9000" },
  ]

  bench_secrets = [
    { name = "DB_PASSWORD", valueFrom = "${var.mariadb_connection_secret_arn}:password::" },
    { name = "REDIS_PASSWORD", valueFrom = "${var.redis_auth_secret_arn}:auth_token::" },
    { name = "ADMIN_PASSWORD", valueFrom = "${var.erpnext_secret_arn}:ADMIN_PASSWORD::" },
    { name = "ENCRYPTION_KEY", valueFrom = "${var.erpnext_secret_arn}:ENCRYPTION_KEY::" },
  ]

  # backend/websocket/queue/scheduler: same image (this repo's erpnext.Dockerfile, ERPNext +
  # Education on one bench), differ only in the process they run. frontend is deliberately not
  # here — separate image, separate task definition below (main.tf's header comment).
  bench_roles = {
    backend = {
      command         = ["gunicorn", "--bind=0.0.0.0:8000", "--workers=2", "--timeout=120", "--preload", "frappe.app:application"]
      container_port  = 8000
      cpu             = var.backend_cpu
      memory          = var.backend_memory
      desired_count   = var.backend_desired_count
      service_connect = true # discoverable, as erpnext-backend, for frontend's nginx upstream
    }
    websocket = {
      command         = ["node", "apps/frappe/socketio.js"]
      container_port  = 9000
      cpu             = var.websocket_cpu
      memory          = var.websocket_memory
      desired_count   = var.websocket_desired_count
      service_connect = true # discoverable, as erpnext-websocket
    }
    queue = {
      # One combined worker across all three RQ priority queues, not three separate ECS services
      # (frappe_docker's own canonical layout splits queue-short/queue-default/queue-long). A
      # low-traffic staging seed tenant doesn't need queue-priority isolation — KISS.
      command         = ["bench", "worker", "--queue", "short,default,long"]
      container_port  = null
      cpu             = var.queue_cpu
      memory          = var.queue_memory
      desired_count   = var.queue_desired_count
      service_connect = false # never receives inbound calls — connects straight to MariaDB/Redis
    }
    scheduler = {
      command         = ["bench", "schedule"]
      container_port  = null
      cpu             = var.scheduler_cpu
      memory          = var.scheduler_memory
      desired_count   = 1 # fixed, not a variable: bench schedule must never run concurrently
      service_connect = false
    }
  }
}

resource "aws_ecs_task_definition" "bench" {
  for_each = local.bench_roles

  family                   = "${var.name_prefix}-erpnext-${each.key}"
  network_mode             = "awsvpc"
  requires_compatibilities = ["FARGATE"]
  cpu                      = tostring(each.value.cpu)
  memory                   = tostring(each.value.memory)
  execution_role_arn       = var.execution_role_arn

  volume {
    name = "sites"

    efs_volume_configuration {
      file_system_id     = aws_efs_file_system.sites.id
      transit_encryption = "ENABLED"

      authorization_config {
        access_point_id = aws_efs_access_point.sites.id
        # POSIX permissions (uid/gid 1000, above) plus the erpnext security group are the actual
        # access control here — IAM-per-mount is left DISABLED so this stays consistent with
        # every other service in this repo, none of which has a task role yet
        # (infra/deploy/README.md's "Known gaps" #4).
        iam = "DISABLED"
      }
    }
  }

  container_definitions = jsonencode([
    {
      name        = each.key
      image       = "${var.image_repository_url}:${var.image_tag}"
      essential   = true
      command     = each.value.command
      environment = local.bench_environment
      secrets     = local.bench_secrets
      portMappings = each.value.container_port == null ? [] : [
        {
          containerPort = each.value.container_port
          protocol      = "tcp"
          name          = each.key
        }
      ]
      mountPoints = [
        { sourceVolume = "sites", containerPath = "/home/frappe/frappe-bench/sites", readOnly = false }
      ]
      logConfiguration = {
        logDriver = "awslogs"
        options = {
          "awslogs-group"         = aws_cloudwatch_log_group.role[each.key].name
          "awslogs-region"        = var.aws_region
          "awslogs-stream-prefix" = each.key
        }
      }
    }
  ])

  tags = { Name = "${var.name_prefix}-erpnext-${each.key}" }
}

resource "aws_ecs_service" "bench" {
  for_each = local.bench_roles

  name             = "${var.name_prefix}-erpnext-${each.key}"
  cluster          = var.cluster_arn
  task_definition  = aws_ecs_task_definition.bench[each.key].arn
  desired_count    = each.value.desired_count
  launch_type      = "FARGATE"
  platform_version = "LATEST" # Service Connect needs >= 1.4.0

  network_configuration {
    subnets          = var.private_app_subnet_ids
    security_groups  = [var.security_group_id]
    assign_public_ip = false
  }

  dynamic "service_connect_configuration" {
    for_each = each.value.service_connect ? [1] : []

    content {
      enabled   = true
      namespace = aws_service_discovery_http_namespace.internal.arn

      service {
        port_name      = each.key
        discovery_name = "erpnext-${each.key}"

        client_alias {
          port     = each.value.container_port
          dns_name = "erpnext-${each.key}"
        }
      }
    }
  }

  tags = { Name = "${var.name_prefix}-erpnext-${each.key}" }
}

# --- Frontend: the one role apps/api can reach, via the internal ALB below ----------------------

resource "aws_ecs_task_definition" "frontend" {
  family                   = "${var.name_prefix}-erpnext-frontend"
  network_mode             = "awsvpc"
  requires_compatibilities = ["FARGATE"]
  cpu                      = tostring(var.frontend_cpu)
  memory                   = tostring(var.frontend_memory)
  execution_role_arn       = var.execution_role_arn

  volume {
    name = "sites"

    efs_volume_configuration {
      file_system_id     = aws_efs_file_system.sites.id
      transit_encryption = "ENABLED"

      authorization_config {
        access_point_id = aws_efs_access_point.sites.id
        iam             = "DISABLED"
      }
    }
  }

  container_definitions = jsonencode([
    {
      name      = "frontend"
      image     = var.frontend_image
      essential = true
      environment = [
        # frappe_docker's nginx role resolves its upstreams from these two env vars. Both are
        # Service Connect short names, resolvable because this service joins the same namespace
        # below (with no client_alias of its own — it's a consumer here, not discoverable).
        { name = "BACKEND", value = "erpnext-backend:8000" },
        { name = "SOCKETIO", value = "erpnext-websocket:9000" },
        # Literal "$host", not a specific site name: this is what makes site-per-school actually
        # work at the frontend — nginx passes through whichever Host header the caller sent as the
        # X-Frappe-Site-Name header, and bench resolves the matching site from sites/<host>/ on
        # every request. Hardcoding one site's hostname here would defeat multi-tenancy: only the
        # one bench command that creates a site (infra/deploy/scripts/erpnext-new-site.sh) needs
        # to name a specific hostname — the frontend never should.
        { name = "FRAPPE_SITE_NAME_HEADER", value = "$host" },
      ]
      portMappings = [
        { containerPort = var.frontend_port, protocol = "tcp", name = "frontend" }
      ]
      mountPoints = [
        { sourceVolume = "sites", containerPath = "/home/frappe/frappe-bench/sites", readOnly = true }
      ]
      logConfiguration = {
        logDriver = "awslogs"
        options = {
          "awslogs-group"         = aws_cloudwatch_log_group.role["frontend"].name
          "awslogs-region"        = var.aws_region
          "awslogs-stream-prefix" = "frontend"
        }
      }
    }
  ])

  tags = { Name = "${var.name_prefix}-erpnext-frontend" }
}

resource "aws_ecs_service" "frontend" {
  name             = "${var.name_prefix}-erpnext-frontend"
  cluster          = var.cluster_arn
  task_definition  = aws_ecs_task_definition.frontend.arn
  desired_count    = var.frontend_desired_count
  launch_type      = "FARGATE"
  platform_version = "LATEST"

  network_configuration {
    subnets          = var.private_app_subnet_ids
    security_groups  = [var.security_group_id]
    assign_public_ip = false
  }

  load_balancer {
    target_group_arn = aws_lb_target_group.frontend.arn
    container_name   = "frontend"
    container_port   = var.frontend_port
  }

  # Joins the namespace as a client only (no `service` block, so it registers no discovery name of
  # its own) — this is what lets its nginx config resolve erpnext-backend/erpnext-websocket.
  service_connect_configuration {
    enabled   = true
    namespace = aws_service_discovery_http_namespace.internal.arn
  }

  tags = { Name = "${var.name_prefix}-erpnext-frontend" }
}

# --- Internal ALB: apps/api's only path into the plane -------------------------------------------

resource "aws_lb" "internal" {
  name               = "${var.name_prefix}-erpnext"
  internal           = true
  load_balancer_type = "application"
  security_groups    = [var.security_group_id]
  subnets            = var.private_app_subnet_ids

  tags = { Name = "${var.name_prefix}-erpnext" }
}

resource "aws_lb_target_group" "frontend" {
  name        = "${var.name_prefix}-erpnext-front"
  port        = var.frontend_port
  protocol    = "HTTP"
  vpc_id      = var.vpc_id
  target_type = "ip"

  health_check {
    # Frappe's own built-in unauthenticated liveness endpoint — returns "pong" with no site
    # context required, so it works before any school site is created.
    path                = "/api/method/ping"
    healthy_threshold   = 3
    unhealthy_threshold = 3
    interval            = 30
    timeout             = 5
    matcher             = "200"
  }

  tags = { Name = "${var.name_prefix}-erpnext-front" }
}

resource "aws_lb_listener" "internal_http" {
  load_balancer_arn = aws_lb.internal.arn
  port              = 80
  protocol          = "HTTP"

  # Plain HTTP, not HTTPS: this ALB never leaves the VPC's private-app subnets, and the erpnext
  # security group is what actually restricts who can reach it — see README.md's "Known gaps" for
  # the honest trade-off (no TLS-in-transit inside the VPC, unlike modules/pgbouncer's
  # self-signed-cert precedent).
  default_action {
    type             = "forward"
    target_group_arn = aws_lb_target_group.frontend.arn
  }
}

# --- One-off site-setup task: no aws_ecs_service, run via `aws ecs run-task` --------------------

# `bench new-site` is a one-shot operation, not a long-running process — the correct ECS primitive
# for that is a run-task invocation against a registered-but-inert task definition, not a service.
# infra/deploy/scripts/erpnext-new-site.sh overrides this task definition's command per invocation.
resource "aws_ecs_task_definition" "site_setup" {
  family                   = "${var.name_prefix}-erpnext-site-setup"
  network_mode             = "awsvpc"
  requires_compatibilities = ["FARGATE"]
  cpu                      = tostring(var.backend_cpu)
  memory                   = tostring(var.backend_memory)
  execution_role_arn       = var.execution_role_arn

  volume {
    name = "sites"

    efs_volume_configuration {
      file_system_id     = aws_efs_file_system.sites.id
      transit_encryption = "ENABLED"

      authorization_config {
        access_point_id = aws_efs_access_point.sites.id
        iam             = "DISABLED"
      }
    }
  }

  container_definitions = jsonencode([
    {
      name      = "site-setup"
      image     = "${var.image_repository_url}:${var.image_tag}"
      essential = true
      # No default command: infra/deploy/scripts/erpnext-new-site.sh always supplies one via
      # `aws ecs run-task --overrides`. A bare `bench` invocation with no subcommand exits 0
      # immediately if this task definition is ever launched without an override by mistake.
      command     = ["bench"]
      environment = local.bench_environment
      secrets     = local.bench_secrets
      mountPoints = [
        { sourceVolume = "sites", containerPath = "/home/frappe/frappe-bench/sites", readOnly = false }
      ]
      logConfiguration = {
        logDriver = "awslogs"
        options = {
          "awslogs-group"         = aws_cloudwatch_log_group.role["site-setup"].name
          "awslogs-region"        = var.aws_region
          "awslogs-stream-prefix" = "site-setup"
        }
      }
    }
  ])

  tags = { Name = "${var.name_prefix}-erpnext-site-setup" }
}
