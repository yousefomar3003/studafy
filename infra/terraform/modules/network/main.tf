# Three subnet tiers per AZ:
#   public        - ALB, NAT gateways, bastion. Routes to the internet gateway.
#   private-app   - future compute behind the ALB. Routes outbound through NAT only.
#   private-data  - DB/Redis. No route out of the VPC at all (not even via NAT):
#                   unreachable from the internet is enforced by routing, not just
#                   security groups.
#
# Subnet CIDRs are derived from vpc_cidr with cidrsubnet() instead of listed by hand,
# so the split stays correct for any vpc_cidr/az_count combination.

data "aws_availability_zones" "available" {
  state = "available"
}

locals {
  azs = slice(data.aws_availability_zones.available.names, 0, var.az_count)

  nat_gateway_count = var.single_nat_gateway ? 1 : length(local.azs)
}

resource "aws_vpc" "this" {
  cidr_block           = var.vpc_cidr
  enable_dns_support   = true
  enable_dns_hostnames = true

  tags = { Name = var.name_prefix }
}

resource "aws_internet_gateway" "this" {
  vpc_id = aws_vpc.this.id

  tags = { Name = "${var.name_prefix}-igw" }
}

resource "aws_subnet" "public" {
  count                   = length(local.azs)
  vpc_id                  = aws_vpc.this.id
  availability_zone       = local.azs[count.index]
  cidr_block              = cidrsubnet(var.vpc_cidr, 4, count.index)
  map_public_ip_on_launch = true

  tags = { Name = "${var.name_prefix}-public-${local.azs[count.index]}" }
}

resource "aws_subnet" "private_app" {
  count             = length(local.azs)
  vpc_id            = aws_vpc.this.id
  availability_zone = local.azs[count.index]
  cidr_block        = cidrsubnet(var.vpc_cidr, 4, 4 + count.index)

  tags = { Name = "${var.name_prefix}-private-app-${local.azs[count.index]}" }
}

resource "aws_subnet" "private_data" {
  count             = length(local.azs)
  vpc_id            = aws_vpc.this.id
  availability_zone = local.azs[count.index]
  cidr_block        = cidrsubnet(var.vpc_cidr, 4, 8 + count.index)

  tags = { Name = "${var.name_prefix}-private-data-${local.azs[count.index]}" }
}

# --- Public tier: routes to the internet gateway -----------------------------------

resource "aws_route_table" "public" {
  vpc_id = aws_vpc.this.id

  tags = { Name = "${var.name_prefix}-public" }
}

resource "aws_route" "public_internet" {
  route_table_id         = aws_route_table.public.id
  destination_cidr_block = "0.0.0.0/0"
  gateway_id             = aws_internet_gateway.this.id
}

resource "aws_route_table_association" "public" {
  count          = length(local.azs)
  subnet_id      = aws_subnet.public[count.index].id
  route_table_id = aws_route_table.public.id
}

# --- Private-app tier: routes outbound through NAT ----------------------------------

resource "aws_eip" "nat" {
  count  = local.nat_gateway_count
  domain = "vpc"

  tags = { Name = "${var.name_prefix}-nat-${count.index}" }
}

resource "aws_nat_gateway" "this" {
  count         = local.nat_gateway_count
  allocation_id = aws_eip.nat[count.index].id
  subnet_id     = aws_subnet.public[count.index].id

  tags       = { Name = "${var.name_prefix}-nat-${count.index}" }
  depends_on = [aws_internet_gateway.this]
}

resource "aws_route_table" "private_app" {
  count  = length(local.azs)
  vpc_id = aws_vpc.this.id

  tags = { Name = "${var.name_prefix}-private-app-${local.azs[count.index]}" }
}

resource "aws_route" "private_app_nat" {
  count                  = length(local.azs)
  route_table_id         = aws_route_table.private_app[count.index].id
  destination_cidr_block = "0.0.0.0/0"
  nat_gateway_id         = aws_nat_gateway.this[var.single_nat_gateway ? 0 : count.index].id
}

resource "aws_route_table_association" "private_app" {
  count          = length(local.azs)
  subnet_id      = aws_subnet.private_app[count.index].id
  route_table_id = aws_route_table.private_app[count.index].id
}

# --- Private-data tier: local VPC routing only, no route to the internet -----------

resource "aws_route_table" "private_data" {
  vpc_id = aws_vpc.this.id

  tags = { Name = "${var.name_prefix}-private-data" }
}

resource "aws_route_table_association" "private_data" {
  count          = length(local.azs)
  subnet_id      = aws_subnet.private_data[count.index].id
  route_table_id = aws_route_table.private_data.id
}

# --- Subnet groups so a future DB/Redis module needs no subnet wiring of its own ---

resource "aws_db_subnet_group" "this" {
  name       = "${var.name_prefix}-db"
  subnet_ids = aws_subnet.private_data[*].id

  tags = { Name = "${var.name_prefix}-db" }
}

resource "aws_elasticache_subnet_group" "this" {
  name       = "${var.name_prefix}-redis"
  subnet_ids = aws_subnet.private_data[*].id
}
