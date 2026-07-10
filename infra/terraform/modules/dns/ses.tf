# SES domain identity for the dedicated transactional-sending subdomain. Never zone_name
# itself (see ses_domain's description in variables.tf) — isolating the sending domain means a
# deliverability problem with transactional mail can't drag down the apex or the app domains
# module.edge serves.
resource "aws_ses_domain_identity" "this" {
  count = var.create_email_records ? 1 : 0

  domain = var.ses_domain
}

resource "aws_route53_record" "ses_verification" {
  count = var.create_email_records ? 1 : 0

  zone_id = local.zone_id
  name    = "_amazonses.${var.ses_domain}"
  type    = "TXT"
  ttl     = 300
  records = [aws_ses_domain_identity.this[0].verification_token]
}

# Blocks until SES observes the TXT record above and marks the identity Verified. DKIM and
# custom MAIL FROM below are meaningless — SES silently won't send through them — against a
# still-pending identity, so nothing downstream is created until this resolves.
resource "aws_ses_domain_identity_verification" "this" {
  count = var.create_email_records ? 1 : 0

  domain     = aws_ses_domain_identity.this[0].id
  depends_on = [aws_route53_record.ses_verification]
}

# Easy DKIM: SES generates a 1024-bit key pair per token and rotates the private half behind
# the scenes. Publishing all three CNAMEs is what lets a receiving mail server verify the
# DKIM-Signature header on outbound transactional mail — the DKIM half of this ticket's
# acceptance criteria.
resource "aws_ses_domain_dkim" "this" {
  count = var.create_email_records ? 1 : 0

  domain = aws_ses_domain_identity.this[0].domain
}

resource "aws_route53_record" "dkim" {
  count = var.create_email_records ? 3 : 0

  zone_id = local.zone_id
  name    = "${aws_ses_domain_dkim.this[0].dkim_tokens[count.index]}._domainkey.${var.ses_domain}"
  type    = "CNAME"
  ttl     = 300
  records = ["${aws_ses_domain_dkim.this[0].dkim_tokens[count.index]}.dkim.amazonses.com"]
}

# Custom MAIL FROM: without this, SES's bounce/Return-Path domain is amazonses.com, which fails
# SPF alignment for DMARC purposes — the envelope-from domain wouldn't share an organizational
# domain with ses_domain. Pointing MAIL FROM at a subdomain of ses_domain makes the two align,
# which is what DMARC's default relaxed SPF alignment mode checks for.
resource "aws_ses_domain_mail_from" "this" {
  count = var.create_email_records ? 1 : 0

  domain           = aws_ses_domain_identity.this[0].domain
  mail_from_domain = "${var.mail_from_subdomain}.${var.ses_domain}"
}

resource "aws_route53_record" "mail_from_mx" {
  count = var.create_email_records ? 1 : 0

  zone_id = local.zone_id
  name    = aws_ses_domain_mail_from.this[0].mail_from_domain
  type    = "MX"
  ttl     = 300
  records = ["10 feedback-smtp.${var.aws_region}.amazonses.com"]
}

resource "aws_route53_record" "mail_from_spf" {
  count = var.create_email_records ? 1 : 0

  zone_id = local.zone_id
  name    = aws_ses_domain_mail_from.this[0].mail_from_domain
  type    = "TXT"
  ttl     = 300
  records = ["v=spf1 include:amazonses.com ~all"]
}

# DMARC, p=quarantine per the acceptance criteria — not p=none (no enforcement, reports only)
# and not p=reject (this is the first real policy ses_domain has ever had; jumping straight to
# reject risks silently dropping legitimate mail if SPF/DKIM alignment has an edge case rua=
# hasn't surfaced yet). fo=1 asks receivers to also send a failure report on any SPF/DKIM
# misalignment, not only when both fail.
resource "aws_route53_record" "dmarc" {
  count = var.create_email_records ? 1 : 0

  zone_id = local.zone_id
  name    = "_dmarc.${var.ses_domain}"
  type    = "TXT"
  ttl     = 300
  records = [join("; ", compact([
    "v=DMARC1",
    "p=${var.dmarc_policy}",
    "rua=${var.dmarc_rua}",
    var.dmarc_ruf != null ? "ruf=${var.dmarc_ruf}" : null,
    "fo=1",
  ]))]
}
