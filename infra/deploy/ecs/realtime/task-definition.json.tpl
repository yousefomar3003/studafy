{
  "family": "${NAME_PREFIX}-realtime",
  "networkMode": "awsvpc",
  "requiresCompatibilities": ["FARGATE"],
  "cpu": "${REALTIME_CPU}",
  "memory": "${REALTIME_MEMORY}",
  "executionRoleArn": "${ECS_EXECUTION_ROLE_ARN}",
  "containerDefinitions": [
    {
      "name": "realtime",
      "image": "${REALTIME_IMAGE}",
      "essential": true,
      "portMappings": [{ "containerPort": 3001, "protocol": "tcp" }],
      "environment": [
        { "name": "NODE_ENV", "value": "production" },
        { "name": "PORT", "value": "3001" },
        { "name": "HOST", "value": "0.0.0.0" }
      ],
      "secrets": [
        {
          "name": "WS_JWT_SECRET",
          "valueFrom": "${REALTIME_APP_SECRETS_ARN}:WS_JWT_SECRET::"
        }
      ],
      "healthCheck": {
        "command": [
          "CMD-SHELL",
          "bun -e \"fetch('http://127.0.0.1:3001/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))\""
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
          "awslogs-group": "/${NAME_PREFIX}/ecs/realtime",
          "awslogs-region": "${AWS_REGION}",
          "awslogs-stream-prefix": "realtime"
        }
      }
    }
  ]
}
