{
  "cluster": "${ECS_CLUSTER}",
  "serviceName": "${NAME_PREFIX}-api",
  "taskDefinition": "${NAME_PREFIX}-api",
  "launchType": "FARGATE",
  "platformVersion": "LATEST",
  "schedulingStrategy": "REPLICA",
  "desiredCount": ${API_DESIRED_COUNT},
  "deploymentController": { "type": "ECS" },
  "deploymentConfiguration": {
    "maximumPercent": ${API_MAX_PERCENT},
    "minimumHealthyPercent": ${API_MIN_HEALTHY_PERCENT},
    "deploymentCircuitBreaker": { "enable": true, "rollback": true }
  },
  "networkConfiguration": {
    "awsvpcConfiguration": {
      "subnets": [${PRIVATE_APP_SUBNET_IDS}],
      "securityGroups": ["${APP_SECURITY_GROUP_ID}"],
      "assignPublicIp": "DISABLED"
    }
  },
  "loadBalancers": [
    {
      "targetGroupArn": "${API_TARGET_GROUP_ARN}",
      "containerName": "api",
      "containerPort": 3000
    }
  ],
  "healthCheckGracePeriodSeconds": 30,
  "enableExecuteCommand": true
}
