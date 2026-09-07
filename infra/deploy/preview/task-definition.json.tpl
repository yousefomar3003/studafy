{
  "family": "${PREVIEW_FAMILY}",
  "networkMode": "awsvpc",
  "requiresCompatibilities": ["FARGATE"],
  "cpu": "${PREVIEW_CPU}",
  "memory": "${PREVIEW_MEMORY}",
  "executionRoleArn": "${PREVIEW_EXECUTION_ROLE_ARN}",
  "containerDefinitions": [
    {
      "name": "api",
      "image": "${PREVIEW_API_IMAGE}",
      "essential": true,
      "environment": [
        { "name": "NODE_ENV", "value": "development" },
        { "name": "APP_ENV", "value": "development" },
        { "name": "PORT", "value": "3000" },
        { "name": "HOST", "value": "127.0.0.1" },
        { "name": "LOG_LEVEL", "value": "info" },
        { "name": "SERVICE_NAME", "value": "api" },
        { "name": "RELEASE_VERSION", "value": "${PREVIEW_IMAGE_TAG}" },
        { "name": "DATABASE_HOST", "value": "${PREVIEW_DB_HOST}" },
        { "name": "DATABASE_PORT", "value": "${PREVIEW_DB_PORT}" },
        { "name": "DATABASE_NAME", "value": "${PREVIEW_DB_NAME}" },
        { "name": "DATABASE_SSL_MODE", "value": "disable" }
      ],
      "secrets": [
        { "name": "DATABASE_USER", "valueFrom": "${PREVIEW_DB_SECRET_ARN}:username::" },
        { "name": "DATABASE_PASSWORD", "valueFrom": "${PREVIEW_DB_SECRET_ARN}:password::" }
      ],
      "healthCheck": {
        "command": [
          "CMD-SHELL",
          "bun -e \"fetch('http://127.0.0.1:3000/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))\""
        ],
        "interval": 15,
        "timeout": 3,
        "retries": 5,
        "startPeriod": 20
      },
      "stopTimeout": 15,
      "logConfiguration": {
        "logDriver": "awslogs",
        "options": {
          "awslogs-group": "${PREVIEW_LOG_GROUP}",
          "awslogs-region": "${AWS_REGION}",
          "awslogs-stream-prefix": "api",
          "awslogs-create-group": "true"
        }
      }
    },
    {
      "name": "web",
      "image": "${PREVIEW_WEB_IMAGE}",
      "essential": true,
      "dependsOn": [{ "containerName": "api", "condition": "HEALTHY" }],
      "portMappings": [{ "containerPort": 8080, "protocol": "tcp" }],
      "healthCheck": {
        "command": ["CMD-SHELL", "wget -q --spider http://127.0.0.1:8080/healthz || exit 1"],
        "interval": 15,
        "timeout": 3,
        "retries": 5,
        "startPeriod": 10
      },
      "stopTimeout": 15,
      "logConfiguration": {
        "logDriver": "awslogs",
        "options": {
          "awslogs-group": "${PREVIEW_LOG_GROUP}",
          "awslogs-region": "${AWS_REGION}",
          "awslogs-stream-prefix": "web",
          "awslogs-create-group": "true"
        }
      }
    }
  ]
}
