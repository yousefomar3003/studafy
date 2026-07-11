{
  "family": "${NAME_PREFIX}-migrations",
  "networkMode": "awsvpc",
  "requiresCompatibilities": ["FARGATE"],
  "cpu": "256",
  "memory": "512",
  "executionRoleArn": "${MIGRATIONS_EXECUTION_ROLE_ARN}",
  "containerDefinitions": [
    {
      "name": "migrations",
      "image": "${MIGRATIONS_IMAGE}",
      "essential": true,
      "environment": [
        { "name": "NODE_ENV", "value": "production" },
        { "name": "DATABASE_SSL_MODE", "value": "require" },
        { "name": "MIGRATIONS_DIR", "value": "/app/db/migrations" }
      ],
      "secrets": [
        { "name": "DATABASE_HOST", "valueFrom": "${POSTGRES_SECRET_ARN}:host::" },
        { "name": "DATABASE_PORT", "valueFrom": "${POSTGRES_SECRET_ARN}:port::" },
        { "name": "DATABASE_NAME", "valueFrom": "${POSTGRES_SECRET_ARN}:dbname::" },
        { "name": "DATABASE_USER", "valueFrom": "${POSTGRES_SECRET_ARN}:username::" },
        { "name": "DATABASE_PASSWORD", "valueFrom": "${POSTGRES_SECRET_ARN}:password::" }
      ],
      "logConfiguration": {
        "logDriver": "awslogs",
        "options": {
          "awslogs-group": "/${NAME_PREFIX}/ecs/migrations",
          "awslogs-region": "${AWS_REGION}",
          "awslogs-stream-prefix": "migrations"
        }
      }
    }
  ]
}
