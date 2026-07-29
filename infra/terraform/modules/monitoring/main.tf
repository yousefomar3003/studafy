locals {
  ecs_services = toset(["api", "realtime", "workers"])
  rds_instances = merge(
    {
      postgres      = var.postgres_instance_id
      postgres_read = var.postgres_read_replica_instance_id
    },
    var.mariadb_instance_id == null ? {} : { mariadb = var.mariadb_instance_id },
  )
}

resource "aws_cloudwatch_metric_alarm" "rds_cpu" {
  for_each = local.rds_instances

  alarm_name          = "${var.name_prefix}-${each.key}-cpu-high"
  alarm_description   = "${each.key} CPU has exceeded 80 percent for 10 minutes."
  namespace           = "AWS/RDS"
  metric_name         = "CPUUtilization"
  statistic           = "Average"
  period              = 300
  evaluation_periods  = 2
  threshold           = 80
  comparison_operator = "GreaterThanThreshold"
  treat_missing_data  = "missing"
  alarm_actions       = []
  ok_actions          = []

  dimensions = { DBInstanceIdentifier = each.value }
}

resource "aws_cloudwatch_metric_alarm" "postgres_replica_lag" {
  alarm_name          = "${var.name_prefix}-postgres-replica-lag-high"
  alarm_description   = "PostgreSQL reporting replica lag has exceeded 60 seconds for 10 minutes."
  namespace           = "AWS/RDS"
  metric_name         = "ReplicaLag"
  statistic           = "Average"
  period              = 300
  evaluation_periods  = 2
  threshold           = 60
  comparison_operator = "GreaterThanThreshold"
  treat_missing_data  = "breaching"
  alarm_actions       = []
  ok_actions          = []

  dimensions = { DBInstanceIdentifier = var.postgres_read_replica_instance_id }
}

resource "aws_cloudwatch_metric_alarm" "postgres_storage" {
  alarm_name          = "${var.name_prefix}-postgres-storage-low"
  alarm_description   = "PostgreSQL free storage is below 10 GiB."
  namespace           = "AWS/RDS"
  metric_name         = "FreeStorageSpace"
  statistic           = "Average"
  period              = 300
  evaluation_periods  = 2
  threshold           = 10737418240
  comparison_operator = "LessThanThreshold"
  treat_missing_data  = "missing"
  alarm_actions       = []
  ok_actions          = []

  dimensions = { DBInstanceIdentifier = var.postgres_instance_id }
}

resource "aws_cloudwatch_metric_alarm" "redis_cpu" {
  alarm_name          = "${var.name_prefix}-redis-engine-cpu-high"
  alarm_description   = "Redis engine CPU has exceeded 75 percent for 10 minutes."
  namespace           = "AWS/ElastiCache"
  metric_name         = "EngineCPUUtilization"
  statistic           = "Average"
  period              = 300
  evaluation_periods  = 2
  threshold           = 75
  comparison_operator = "GreaterThanThreshold"
  treat_missing_data  = "missing"
  alarm_actions       = []
  ok_actions          = []

  dimensions = { ReplicationGroupId = var.redis_replication_group_id }
}

resource "aws_cloudwatch_metric_alarm" "ecs_cpu" {
  for_each = local.ecs_services

  alarm_name          = "${var.name_prefix}-${each.key}-ecs-cpu-high"
  alarm_description   = "${each.key} ECS CPU has exceeded 80 percent for 10 minutes."
  namespace           = "AWS/ECS"
  metric_name         = "CPUUtilization"
  statistic           = "Average"
  period              = 300
  evaluation_periods  = 2
  threshold           = 80
  comparison_operator = "GreaterThanThreshold"
  treat_missing_data  = "missing"
  alarm_actions       = []
  ok_actions          = []

  dimensions = {
    ClusterName = var.ecs_cluster_name
    ServiceName = "${var.name_prefix}-${each.key}"
  }
}

resource "aws_cloudwatch_dashboard" "operations" {
  dashboard_name = "${var.name_prefix}-operations"
  dashboard_body = jsonencode({
    widgets = [
      {
        type   = "metric"
        x      = 0
        y      = 0
        width  = 12
        height = 6
        properties = {
          title  = "RDS CPU"
          region = var.aws_region
          stat   = "Average"
          period = 300
          metrics = [for name, id in local.rds_instances : [
            "AWS/RDS", "CPUUtilization", "DBInstanceIdentifier", id, { label = name }
          ]]
        }
      },
      {
        type   = "metric"
        x      = 12
        y      = 0
        width  = 12
        height = 6
        properties = {
          title  = "Redis health"
          region = var.aws_region
          stat   = "Average"
          period = 300
          metrics = [
            ["AWS/ElastiCache", "EngineCPUUtilization", "ReplicationGroupId", var.redis_replication_group_id],
            [".", "CurrConnections", ".", "."],
            [".", "Evictions", ".", "."],
          ]
        }
      },
      {
        type   = "metric"
        x      = 0
        y      = 6
        width  = 24
        height = 6
        properties = {
          title  = "ECS services"
          region = var.aws_region
          stat   = "Average"
          period = 300
          metrics = flatten([for service in local.ecs_services : [
            ["AWS/ECS", "CPUUtilization", "ClusterName", var.ecs_cluster_name, "ServiceName", "${var.name_prefix}-${service}", { label = "${service} CPU" }],
            [".", "MemoryUtilization", ".", ".", ".", ".", { label = "${service} memory" }],
          ]])
        }
      },
      {
        type   = "metric"
        x      = 0
        y      = 12
        width  = 12
        height = 6
        properties = {
          title  = "PostgreSQL replica lag"
          region = var.aws_region
          stat   = "Average"
          period = 300
          metrics = [
            ["AWS/RDS", "ReplicaLag", "DBInstanceIdentifier", var.postgres_read_replica_instance_id],
          ]
        }
      },
    ]
  })
}
