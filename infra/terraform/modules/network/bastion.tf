# Audited SSH: the bastion ships its sshd auth log (/var/log/secure on Amazon Linux)
# to a dedicated CloudWatch Logs group, so every login attempt — success or failure,
# source IP, user — is captured off-box. The instance role can only write to that one
# log group; it has no other AWS permissions.

data "aws_ssm_parameter" "al2023_ami" {
  name = "/aws/service/ami-amazon-linux-latest/al2023-ami-kernel-default-x86_64"
}

resource "aws_cloudwatch_log_group" "bastion_ssh" {
  name              = "/${var.name_prefix}/bastion/ssh"
  retention_in_days = var.ssh_log_retention_days

  tags = { Name = "${var.name_prefix}-bastion-ssh" }
}

resource "aws_iam_role" "bastion" {
  name_prefix = "${var.name_prefix}-bastion-"

  assume_role_policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect    = "Allow"
      Principal = { Service = "ec2.amazonaws.com" }
      Action    = "sts:AssumeRole"
    }]
  })

  tags = { Name = "${var.name_prefix}-bastion" }
}

resource "aws_iam_role_policy" "bastion_ssh_logs" {
  name_prefix = "${var.name_prefix}-bastion-ssh-logs-"
  role        = aws_iam_role.bastion.id

  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect   = "Allow"
      Action   = ["logs:CreateLogStream", "logs:PutLogEvents"]
      Resource = "${aws_cloudwatch_log_group.bastion_ssh.arn}:*"
    }]
  })
}

resource "aws_iam_instance_profile" "bastion" {
  name_prefix = "${var.name_prefix}-bastion-"
  role        = aws_iam_role.bastion.name
}

locals {
  bastion_user_data = <<-EOT
    #!/bin/bash
    set -euo pipefail

    dnf install -y amazon-cloudwatch-agent

    cat <<CONFIG > /opt/aws/amazon-cloudwatch-agent/etc/config.json
    {
      "logs": {
        "logs_collected": {
          "files": {
            "collect_list": [
              {
                "file_path": "/var/log/secure",
                "log_group_name": "${aws_cloudwatch_log_group.bastion_ssh.name}",
                "log_stream_name": "{instance_id}"
              }
            ]
          }
        }
      }
    }
    CONFIG

    /opt/aws/amazon-cloudwatch-agent/bin/amazon-cloudwatch-agent-ctl \
      -a fetch-config -m ec2 -s -c file:/opt/aws/amazon-cloudwatch-agent/etc/config.json
  EOT
}

resource "aws_instance" "bastion" {
  ami                    = data.aws_ssm_parameter.al2023_ami.value
  instance_type          = var.bastion_instance_type
  subnet_id              = aws_subnet.public[0].id
  vpc_security_group_ids = [aws_security_group.bastion.id]
  iam_instance_profile   = aws_iam_instance_profile.bastion.name
  key_name               = var.bastion_key_name
  user_data              = local.bastion_user_data

  # IMDSv2 only — closes the SSRF-to-credential-theft path that IMDSv1 allows.
  metadata_options {
    http_tokens = "required"
  }

  root_block_device {
    encrypted   = true
    volume_size = 8
  }

  tags = { Name = "${var.name_prefix}-bastion" }
}

# Stable public IP: survives stop/start, so it doesn't silently invalidate
# operators' SSH client configs or any allowlisting done on the other side.
resource "aws_eip" "bastion" {
  domain   = "vpc"
  instance = aws_instance.bastion.id

  tags = { Name = "${var.name_prefix}-bastion" }
}
