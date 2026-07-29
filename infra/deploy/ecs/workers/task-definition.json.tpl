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
      "environment": [
        { "name": "NODE_ENV", "value": "production" },
        { "name": "DATABASE_HOST", "value": "${PGBOUNCER_HOST}" },
        { "name": "DATABASE_PORT", "value": "6432" },
        { "name": "DATABASE_NAME", "value": "api" },
        { "name": "READ_DATABASE_HOST", "value": "${PGBOUNCER_HOST}" },
        { "name": "READ_DATABASE_PORT", "value": "6432" },
        { "name": "READ_DATABASE_NAME", "value": "workers_read" },
        { "name": "S3_REGION", "value": "${AWS_REGION}" },
        { "name": "S3_APP_FILES_BUCKET", "value": "${S3_APP_FILES_BUCKET}" }
      ],
      "secrets": [
        { "name": "REDIS_URL", "valueFrom": "${REDIS_SECRET_ARN}:queue_url::" },
        { "name": "DATABASE_USER", "valueFrom": "${PGBOUNCER_SECRET_ARN}:api_username::" },
        { "name": "DATABASE_PASSWORD", "valueFrom": "${PGBOUNCER_SECRET_ARN}:api_password::" },
        { "name": "DATABASE_CA_CERT", "valueFrom": "${PGBOUNCER_SECRET_ARN}:ca_cert_pem::" }
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
    }
  ]
}
