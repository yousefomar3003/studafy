# --- Cost monitoring and budgets (ST-293) -----------------------------------------------------
#
# The `<prefix>-cost` dashboard: three CloudWatch metric widgets (AI spend, Stripe fees, AWS
# infrastructure spend) plus one Logs Insights widget reading the monthly cost report
# apps/workers' cost-report sweep writes. A dedicated dashboard, separate from
# `aws_cloudwatch_dashboard.operations` (main.tf) and `aws_cloudwatch_dashboard.availability_slo`
# (synthetics.tf) for the same reason those two are already split from each other: this answers
# "what are we spending, and are we within budget", a finance question, not an infrastructure- or
# user-facing-SLO one.
#
# Native CloudWatch, not Grafana, for the same reason `operations`/`availability_slo` are: the
# Logs Insights widget below needs `var.workers_log_group_name` — a Terraform-time value — and this
# repo's Grafana dashboards are deliberately static, environment-agnostic JSON
# (`infra/docker/grafana/provisioning/dashboards/dashboards.yml`'s own comment). Splitting the three
# metric widgets into Grafana and leaving only the log widget here would mean two dashboards for one
# question; keeping cost entirely in one native dashboard does not.
#
# Unconditional (no `count`), like `operations`: apps/workers' cost-report sweep runs in every
# environment (it is not gated behind `monitoring_enabled` — see cost-report-scheduler.ts), so the
# dashboard that reads its output should exist everywhere too.

locals {
  cost_widgets = [
    {
      type   = "metric"
      x      = 0
      y      = 0
      width  = 8
      height = 6
      properties = {
        title  = "AI estimated spend (SLO budget ${var.ai_monthly_spend_budget_usd})"
        region = var.aws_region
        stat   = "Maximum"
        period = 86400
        metrics = [
          [var.cost_metric_namespace, "AiEstimatedSpendUsd", { label = "AI spend (USD)" }],
          [{ expression = "ANNOTATION_LINE(${var.ai_monthly_spend_budget_usd}, 'Budget')", label = "Budget" }],
        ]
      }
    },
    {
      type   = "metric"
      x      = 8
      y      = 0
      width  = 8
      height = 6
      properties = {
        title  = "Stripe processing fees (month to date)"
        region = var.aws_region
        stat   = "Maximum"
        period = 86400
        metrics = [
          [var.cost_metric_namespace, "StripeFeesUsd", { label = "Stripe fees (USD)" }],
        ]
      }
    },
    {
      type   = "metric"
      x      = 16
      y      = 0
      width  = 8
      height = 6
      properties = {
        title  = "AWS estimated charges (budget ${var.aws_monthly_budget_usd})"
        # AWS/Billing's EstimatedCharges is a us-east-1-only metric regardless of var.aws_region —
        # same quirk alerts.tf's billing_alarms_us_east_1 documents. A dashboard widget's own
        # `region` property overrides the dashboard-level default per-widget, so this is the one
        # widget on this dashboard that does not read from var.aws_region.
        region = "us-east-1"
        stat   = "Maximum"
        period = 21600
        metrics = [
          ["AWS/Billing", "EstimatedCharges", "Currency", "USD", { label = "AWS spend (USD)" }],
          [{ expression = "ANNOTATION_LINE(${var.aws_monthly_budget_usd}, 'Budget')", label = "Budget" }],
        ]
      }
    },
    {
      # The "monthly report automated" acceptance criterion, made readable: apps/workers' 1st-of-
      # month cost-report run logs one structured line (schools, tokens, AI cost/revenue/margin,
      # Stripe fees, budget verdict) into its own ECS service log group alongside every other
      # workers log line. Same "Logs Insights table, not a metric" reasoning as main.tf's "Recent
      # deploys" widget — a discrete once-a-month report has no meaningful line chart.
      type   = "log"
      x      = 0
      y      = 6
      width  = 24
      height = 6
      properties = {
        title  = "Monthly cost reports"
        region = var.aws_region
        view   = "table"
        query  = "SOURCE '${var.workers_log_group_name}' | filter msg = 'cost-report: monthly cost report' | fields @timestamp, schoolsWithActiveAiSubscriptions, subscribedStudents, totalTokens, aiEstimatedCostUsd, aiRevenueUsd, aiMarginPercent, stripeFeesUsd, budgetBreached, budgetOverageUsd | sort @timestamp desc | limit 12"
      }
    },
  ]
}

resource "aws_cloudwatch_dashboard" "cost" {
  dashboard_name = "${var.name_prefix}-cost"
  dashboard_body = jsonencode({
    widgets = local.cost_widgets
  })
}
