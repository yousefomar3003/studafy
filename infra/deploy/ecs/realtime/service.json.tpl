{
  "cluster": "${ECS_CLUSTER}",
  "serviceName": "${NAME_PREFIX}-realtime",
  "taskDefinition": "${NAME_PREFIX}-realtime",
  "launchType": "FARGATE",
  "platformVersion": "LATEST",
  "schedulingStrategy": "REPLICA",
  "desiredCount": ${REALTIME_DESIRED_COUNT},
  "deploymentController": { "type": "ECS" },
  "deploymentConfiguration": {
    "maximumPercent": ${REALTIME_MAX_PERCENT},
    "minimumHealthyPercent": ${REALTIME_MIN_HEALTHY_PERCENT},
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
      "targetGroupArn": "${REALTIME_TARGET_GROUP_ARN}",
      "containerName": "realtime",
      "containerPort": 3001
    }
  ],
  "healthCheckGracePeriodSeconds": 30,
  "enableExecuteCommand": true
}
