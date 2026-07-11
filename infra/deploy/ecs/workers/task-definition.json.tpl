{
  "family": "${NAME_PREFIX}-workers",
  "networkMode": "awsvpc",
  "requiresCompatibilities": ["FARGATE"],
  "cpu": "${WORKERS_CPU}",
  "memory": "${WORKERS_MEMORY}",
  "executionRoleArn": "${ECS_EXECUTION_ROLE_ARN}",
  "containerDefinitions": [
    {
      "name": "workers",
      "image": "${WORKERS_IMAGE}",
      "essential": true,
      "environment": [{ "name": "NODE_ENV", "value": "production" }],
      "secrets": [
        { "name": "REDIS_URL", "valueFrom": "${REDIS_SECRET_ARN}:queue_url::" }
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
