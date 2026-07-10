# `dns`

The public Route 53 hosted zone every app domain lives in, plus the auth records (SPF, DKIM,
DMARC) for a dedicated transactional-email-sending subdomain via SES. Deliverability runbook:
[`docs/runbooks/deliverability.md`](../../../../docs/runbooks/deliverability.md).

## What this module does not do

- **It does not manage app-specific records.** The ALB alias for each environment's
  `edge_domain_name` (`api.studafy.com`, `staging-api.studafy.com`, `dev-api.studafy.com`) is
  created by `module.edge` (`modules/edge/dns.tf`), not here — one module, one owner, per record.
  This module owns only the zone itself and the email-auth records below.
- **It does not create a hosted zone in every environment.** `manage_zone` is `true` in exactly
  one environment's tfvars (see `variables.tf`). The other environments do a read-only
  `data.aws_route53_zone` lookup — the same pattern `module.edge` already used for
  `route53_zone_name` before this module existed. Two owners of the same public zone name would
  each believe they're authoritative, and only one can ever match the registrar's actual NS
  delegation.
- **It does not provision a mailbox to receive DMARC aggregate reports.** `dmarc_rua` must point
  at a real inbox (or a third-party DMARC report analyzer's ingestion address) that exists
  independently of this repo. Without one, "DMARC reports received" (this ticket's acceptance
  criterion) cannot be verified — it isn't something Terraform can create.
- **It does not send email.** No application code in this repo sends transactional email yet
  (see `apps/workers/docs/queue-catalog.md`'s `notifications` queue, which is not yet wired to
  SES). This module only makes `ses_domain` authorized and authenticated to send, and grants
  nobody permission to actually call `ses:SendEmail` — that IAM role is a compute-tier concern
  for whichever service ends up sending.

## First apply against a domain that already resolves

If `zone_name` is already live (a hosted zone created by hand in the AWS console — the exact
situation this ticket exists to end), setting `manage_zone = true` and running a plain
`terraform apply` creates a **second, competing** hosted zone with a different NS delegation.
Every record depending on the zone the registrar actually points at — MX, `module.edge`'s app
aliases, everything — goes dark until someone notices and manually repoints the registrar.

Import the existing zone instead, so Terraform adopts the live `zone_id`:

```bash
terraform import 'module.dns.aws_route53_zone.this[0]' <existing-zone-id>
terraform plan -var-file=environments/prod/prod.tfvars   # should show a small/no diff, not a create
```

## Email auth records

| Record                                 | Type  | Purpose                                                                                                                |
| -------------------------------------- | ----- | ---------------------------------------------------------------------------------------------------------------------- |
| `_amazonses.<ses_domain>`              | TXT   | SES domain identity verification token.                                                                                |
| `<token>._domainkey.<ses_domain>` (×3) | CNAME | Easy DKIM — publishes SES's rotating public keys.                                                                      |
| `<mail_from_subdomain>.<ses_domain>`   | MX    | Custom MAIL FROM — `10 feedback-smtp.<region>.amazonses.com`, SES's bounce handler.                                    |
| `<mail_from_subdomain>.<ses_domain>`   | TXT   | SPF for the MAIL FROM (envelope-from) domain: `v=spf1 include:amazonses.com ~all`.                                     |
| `_dmarc.<ses_domain>`                  | TXT   | `v=DMARC1; p=<dmarc_policy>; rua=<dmarc_rua>; ...` — `p=quarantine` by default, per this ticket's acceptance criteria. |

`ses_domain` is deliberately a subdomain (e.g. `mail.studafy.com`), never `zone_name` itself —
sending reputation is isolated from the apex and from `module.edge`'s app domains. When
`manage_zone` and `protect_apex_from_spoofing` are both true, the apex additionally gets
`v=spf1 -all` and `_dmarc.<zone_name> = v=DMARC1; p=reject` — nothing legitimate ever originates
from the bare apex, so there's no real mail to quarantine, only a spoofing target to close.

`dmarc_policy` defaults to `quarantine`, not `reject`: this is the first enforcement policy
`ses_domain` has ever had, and jumping straight to `reject` risks silently dropping legitimate
mail if some SPF/DKIM alignment edge case hasn't shown up in `dmarc_rua` reports yet.

## Usage

```hcl
module "dns" {
  source = "./modules/dns"

  name_prefix = module.naming.name_prefix
  aws_region  = var.aws_region
  zone_name   = var.route53_zone_name

  manage_zone           = var.dns_manage_zone            # true in prod.tfvars only
  create_email_records  = var.dns_create_email_records    # true in prod.tfvars only
  ses_domain            = var.dns_ses_domain               # e.g. "mail.studafy.com"
  dmarc_rua              = var.dns_dmarc_rua                 # "mailto:dmarc-reports@studafy.com"
}
```

## Verifying the acceptance criteria

```bash
# DNS managed only via Terraform: plan should be empty against live state.
terraform plan -var-file=environments/prod/prod.tfvars

# SES identity verified, DKIM enabled:
aws ses get-identity-verification-attributes --identities mail.studafy.com
aws ses get-identity-dkim-attributes --identities mail.studafy.com

# SPF/DKIM/DMARC as seen by the outside world:
dig TXT mail.studafy.com +short                 # (none expected here — SPF lives on the MAIL FROM subdomain)
dig TXT bounce.mail.studafy.com +short           # v=spf1 include:amazonses.com ~all
dig TXT _dmarc.mail.studafy.com +short           # v=DMARC1; p=quarantine; rua=...

# Test invitation email passes Gmail/Outlook auth checks: send a real message through SES from
# ses_domain to a Gmail and an Outlook mailbox, then inspect "Show original" (Gmail) / message
# source (Outlook) for `spf=pass`, `dkim=pass`, `dmarc=pass`. See docs/runbooks/deliverability.md.

# DMARC reports received: check the inbox/analyzer behind dmarc_rua a few days after the first
# real send — aggregate reports arrive roughly daily, not immediately.
```
