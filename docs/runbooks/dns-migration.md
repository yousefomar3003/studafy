# DNS migration: registrar DNS to Route 53

The current public zone serves a Vercel waiting list and Private Email. Nameservers must not be
changed until the bootstrap Route 53 zone contains every registrar record and direct-server
queries prove parity.

## Confirmed live records

| Host                   | Type  | Value                                                |
| ---------------------- | ----- | ---------------------------------------------------- |
| `studafy.com`          | A     | `216.198.79.1`                                       |
| `www`                  | CNAME | `69a855717b020d6c.vercel-dns-017.com`                |
| `studafy.com`          | MX    | `10 mx1.privateemail.com`, `10 mx2.privateemail.com` |
| `studafy.com`          | TXT   | Private Email SPF and existing Google verification   |
| `mail`, `autodiscover` | CNAME | `privateemail.com`                                   |

The table is not an export. Before apply, compare `infra/terraform/bootstrap/main.tf` with every
record in the registrar's Advanced DNS page, including dormant DKIM, CAA, and verification data.

## Cutover gates

1. Apply the bootstrap stack without changing registrar nameservers.
2. Query each Route 53 nameserver directly for apex A/TXT/MX, `www`, `mail`, and `autodiscover`.
3. Confirm the Vercel project recognizes both apex and `www` and that Private Email can send and
   receive through a test mailbox.
4. Add any missing registrar-export records to Terraform and repeat parity checks.
5. Change nameservers at the registrar only after the checks pass. Keep the old zone unchanged
   for at least 72 hours.
6. Verify public DNS, HTTPS, Vercel, inbound/outbound mail, SPF, and Google ownership after the
   change. Restore the old nameservers if any critical check fails.

## Transactional email

`mail.studafy.com` remains Private Email. SES uses `send.studafy.com`, the custom MAIL FROM domain
is `bounce.send.studafy.com`, and aggregate DMARC reports go to the independently provisioned
`dmarc-reports@studafy.com` mailbox.
