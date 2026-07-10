# Public Route 53 hosted zone for every app domain (module.edge's ALB aliases already write
# into it by name) and, optionally, the dedicated email-sending subdomain this module also
# manages. Exactly one environment sets manage_zone = true and owns aws_route53_zone.this; the
# rest do a read-only data lookup — the same "one owner, others just reference it" pattern
# module.edge already uses for route53_zone_name. Two owners of the same public zone name would
# each believe they're authoritative, and only one can ever match what the domain registrar
# actually delegates to.
#
# IMPORTANT — first apply with manage_zone = true against a domain that's already live: if
# zone_name already resolves today (i.e. someone created this hosted zone by hand in the AWS
# console, which is the exact situation this ticket exists to end — see the acceptance
# criterion "DNS managed only via Terraform"), do NOT let a plain `terraform apply` create a
# brand-new zone. A fresh zone is assigned a fresh, different set of NS servers than whatever is
# live at the registrar, and every record depending on the old zone — MX, module.edge's app
# aliases, everything — goes dark until the registrar is manually repointed. Import the existing
# zone instead, so Terraform adopts the live zone_id rather than competing with it:
#
#   terraform import 'module.dns.aws_route53_zone.this[0]' <existing-zone-id>
#
# Only after that import succeeds does `apply` produce a no-op (or additive) diff instead of a
# second, competing zone.
resource "aws_route53_zone" "this" {
  count = var.manage_zone ? 1 : 0

  name    = var.zone_name
  comment = "Managed by Terraform (${var.name_prefix}). See infra/terraform/modules/dns/README.md before importing or recreating."

  tags = { Name = var.zone_name }
}

data "aws_route53_zone" "this" {
  count = var.manage_zone ? 0 : 1

  name         = var.zone_name
  private_zone = false
}

locals {
  zone_id = var.manage_zone ? aws_route53_zone.this[0].zone_id : data.aws_route53_zone.this[0].zone_id
}

# The apex never sends mail — email is sent from ses_domain below, never zone_name itself — so
# say that plainly instead of leaving the bare domain free for anyone to spoof. Gated on
# manage_zone: writing apex-wide policy into a zone this environment doesn't own would let a
# non-owning environment (dev/staging) fight the owner over the same record.
resource "aws_route53_record" "apex_spf" {
  count = var.manage_zone && var.protect_apex_from_spoofing ? 1 : 0

  zone_id = local.zone_id
  name    = var.zone_name
  type    = "TXT"
  ttl     = 300
  records = ["v=spf1 -all"]
}

resource "aws_route53_record" "apex_dmarc" {
  count = var.manage_zone && var.protect_apex_from_spoofing ? 1 : 0

  zone_id = local.zone_id
  name    = "_dmarc.${var.zone_name}"
  type    = "TXT"
  ttl     = 300
  # p=reject here (unlike the p=quarantine required on ses_domain below) because nothing
  # legitimate ever originates from the bare apex — there's no risk of quarantining real mail,
  # only of leaving a wide-open spoofing target if this record is missing.
  records = ["v=DMARC1; p=reject"]
}
