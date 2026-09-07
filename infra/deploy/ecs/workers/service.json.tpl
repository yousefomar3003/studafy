{
  "cluster": "${ECS_CLUSTER}",
  "serviceName": "${NAME_PREFIX}-workers",
  "taskDefinition": "${NAME_PREFIX}-workers",
  "launchType": "FARGATE",
  "platformVersion": "LATEST",
  "schedulingStrategy": "REPLICA",
  "desiredCount": ${WORKERS_DESIRED_COUNT},
  "deploymentController": { "type": "ECS" },
  "deploymentConfiguration": {
    "maximumPercent": ${WORKERS_MAX_PERCENT},
    "minimumHealthyPercent": ${WORKERS_MIN_HEALTHY_PERCENT},
    "deploymentCircuitBreaker": { "enable": true, "rollback": true }
  },
  "networkConfiguration": {
    "awsvpcConfiguration": {
      "subnets": [${PRIVATE_APP_SUBNET_IDS}],
      "securityGroups": ["${APP_SECURITY_GROUP_ID}"],
      "assignPublicIp": "DISABLED"
    }
  },
  "serviceRegistries": [
    {
      "registryArn": "${WORKERS_METRICS_SD_ARN}",
      "containerName": "workers",
      "containerPort": 9464
    }
  ],
  "enableExecuteCommand": true
}
