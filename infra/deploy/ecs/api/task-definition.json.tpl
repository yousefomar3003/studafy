{
  "family": "${NAME_PREFIX}-api",
  "networkMode": "awsvpc",
  "requiresCompatibilities": ["FARGATE"],
  "cpu": "${API_CPU}",
  "memory": "${API_MEMORY}",
  "executionRoleArn": "${ECS_EXECUTION_ROLE_ARN}",
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
        { "name": "DATABASE_HOST", "value": "${PGBOUNCER_HOST}" },
        { "name": "DATABASE_PORT", "value": "6432" },
        { "name": "DATABASE_NAME", "value": "api" }
      ],
      "secrets": [
        { "name": "DATABASE_USER", "valueFrom": "${PGBOUNCER_SECRET_ARN}:api_username::" },
        { "name": "DATABASE_PASSWORD", "valueFrom": "${PGBOUNCER_SECRET_ARN}:api_password::" },
        { "name": "DATABASE_CA_CERT", "valueFrom": "${PGBOUNCER_SECRET_ARN}:ca_cert_pem::" }
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
