{
  "family": "${NAME_PREFIX}-workers",
  "networkMode": "awsvpc",
  "requiresCompatibilities": ["FARGATE"],
  "cpu": "${WORKERS_CPU}",
  "memory": "${WORKERS_MEMORY}",
  "executionRoleArn": "${ECS_EXECUTION_ROLE_ARN}",
  "taskRoleArn": "${WORKERS_TASK_ROLE_ARN}",
  "containerDefinitions": [
    {
      "name": "workers",
      "image": "${WORKERS_IMAGE}",
      "essential": true,
      "portMappings": [{ "containerPort": 9464, "protocol": "tcp", "name": "metrics" }],
      "environment": [
        { "name": "NODE_ENV", "value": "production" },
        { "name": "SERVICE_NAME", "value": "workers" },
        { "name": "METRICS_PORT", "value": "9464" },
        { "name": "OTEL_EXPORTER_OTLP_ENDPOINT", "value": "${OTEL_COLLECTOR_ENDPOINT}" },
        { "name": "DATABASE_HOST", "value": "${PGBOUNCER_HOST}" },
        { "name": "DATABASE_PORT", "value": "6432" },
        { "name": "DATABASE_NAME", "value": "api" },
        { "name": "READ_DATABASE_HOST", "value": "${PGBOUNCER_HOST}" },
        { "name": "READ_DATABASE_PORT", "value": "6432" },
        { "name": "READ_DATABASE_NAME", "value": "workers_read" },
        { "name": "S3_REGION", "value": "${AWS_REGION}" },
        { "name": "S3_APP_FILES_BUCKET", "value": "${S3_APP_FILES_BUCKET}" },
        { "name": "AWS_REGION", "value": "${AWS_REGION}" },
        { "name": "FRONTEND_URL", "value": "${WEB_ORIGIN}" },
        { "name": "CLAMAV_HOST", "value": "127.0.0.1" },
        { "name": "AI_LLM_PROVIDER", "value": "${AI_LLM_PROVIDER}" },
        { "name": "AI_LLM_BASE_URL", "value": "${AI_LLM_BASE_URL}" },
        { "name": "ERPNEXT_API_URL", "value": "${ERPNEXT_API_URL}" }
      ],
      "dependsOn": [{ "containerName": "clamav", "condition": "HEALTHY" }],
      "secrets": [
        { "name": "REDIS_URL", "valueFrom": "${REDIS_SECRET_ARN}:queue_url::" },
        { "name": "DATABASE_USER", "valueFrom": "${PGBOUNCER_SECRET_ARN}:api_username::" },
        { "name": "DATABASE_PASSWORD", "valueFrom": "${PGBOUNCER_SECRET_ARN}:api_password::" },
        { "name": "DATABASE_CA_CERT", "valueFrom": "${PGBOUNCER_SECRET_ARN}:ca_cert_pem::" },
        { "name": "STRIPE_SECRET_KEY", "valueFrom": "${WORKERS_APP_SECRETS_ARN}:STRIPE_SECRET_KEY::" },
        { "name": "TAP_SECRET_KEY", "valueFrom": "${WORKERS_APP_SECRETS_ARN}:TAP_SECRET_KEY::" },
        { "name": "TAP_WEBHOOK_URL", "valueFrom": "${WORKERS_APP_SECRETS_ARN}:TAP_WEBHOOK_URL::" },
        { "name": "AI_LLM_API_KEY", "valueFrom": "${WORKERS_APP_SECRETS_ARN}:AI_LLM_API_KEY::" },
        { "name": "ERPNEXT_API_KEY", "valueFrom": "${WORKERS_APP_SECRETS_ARN}:ERPNEXT_API_KEY::" }
      ],
      "healthCheck": {
        "command": ["CMD-SHELL", "bun healthcheck.ts"],
        "interval": 30,
        "timeout": 3,
        "retries": 3,
        "startPeriod": 10
      },
      "stopTimeout": 30,
      "logConfiguration": {
        "logDriver": "awslogs",
        "options": {
          "awslogs-group": "/${NAME_PREFIX}/ecs/workers",
          "awslogs-region": "${AWS_REGION}",
          "awslogs-stream-prefix": "workers"
        }
      }
    },
    {
      "name": "clamav",
      "image": "${CLAMAV_IMAGE}",
      "essential": true,
      "memoryReservation": 1536,
      "healthCheck": {
        "command": ["CMD-SHELL", "studafy-clamdcheck.sh"],
        "interval": 30,
        "timeout": 10,
        "retries": 3,
        "startPeriod": 300
      },
      "stopTimeout": 30,
      "logConfiguration": {
        "logDriver": "awslogs",
        "options": {
          "awslogs-group": "/${NAME_PREFIX}/ecs/workers",
          "awslogs-region": "${AWS_REGION}",
          "awslogs-stream-prefix": "clamav"
        }
      }
    }
  ]
}
