{
  "family": "${NAME_PREFIX}-api",
  "networkMode": "awsvpc",
  "requiresCompatibilities": ["FARGATE"],
  "cpu": "${API_CPU}",
  "memory": "${API_MEMORY}",
  "executionRoleArn": "${ECS_EXECUTION_ROLE_ARN}",
  "taskRoleArn": "${API_TASK_ROLE_ARN}",
  "containerDefinitions": [
    {
      "name": "api",
      "image": "${API_IMAGE}",
      "essential": true,
      "portMappings": [{ "containerPort": 3000, "protocol": "tcp" }],
      "environment": [
        { "name": "NODE_ENV", "value": "production" },
        { "name": "PORT", "value": "3000" },
        { "name": "HOST", "value": "0.0.0.0" },
        { "name": "LOG_LEVEL", "value": "info" },
        { "name": "SERVICE_NAME", "value": "api" },
        { "name": "RELEASE_VERSION", "value": "${IMAGE_TAG}" },
        { "name": "DATABASE_HOST", "value": "${PGBOUNCER_HOST}" },
        { "name": "DATABASE_PORT", "value": "6432" },
        { "name": "DATABASE_NAME", "value": "api" },
        { "name": "READ_DATABASE_HOST", "value": "${PGBOUNCER_HOST}" },
        { "name": "READ_DATABASE_PORT", "value": "6432" },
        { "name": "READ_DATABASE_NAME", "value": "api_read" },
        { "name": "S3_REGION", "value": "${AWS_REGION}" },
        { "name": "S3_APP_FILES_BUCKET", "value": "${S3_APP_FILES_BUCKET}" },
        { "name": "S3_PRESIGN_TTL_SECONDS", "value": "900" }
      ],
      "secrets": [
        { "name": "DATABASE_USER", "valueFrom": "${PGBOUNCER_SECRET_ARN}:api_username::" },
        { "name": "DATABASE_PASSWORD", "valueFrom": "${PGBOUNCER_SECRET_ARN}:api_password::" },
        { "name": "DATABASE_CA_CERT", "valueFrom": "${PGBOUNCER_SECRET_ARN}:ca_cert_pem::" },
        { "name": "REDIS_URL", "valueFrom": "${REDIS_SECRET_ARN}:queue_url::" }
      ],
      "healthCheck": {
        "command": [
          "CMD-SHELL",
          "bun -e \"fetch('http://127.0.0.1:3000/readyz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))\""
        ],
        "interval": 30,
        "timeout": 3,
        "retries": 3,
        "startPeriod": 10
      },
      "stopTimeout": 30,
      "logConfiguration": {
        "logDriver": "awslogs",
        "options": {
          "awslogs-group": "/${NAME_PREFIX}/ecs/api",
          "awslogs-region": "${AWS_REGION}",
          "awslogs-stream-prefix": "api"
        }
      }
    }
  ]
}
