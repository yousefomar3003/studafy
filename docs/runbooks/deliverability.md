# Email deliverability (R-08)

Source: [`infra/terraform/modules/dns`](../../infra/terraform/modules/dns). This doc is the
conventions and acceptance-criteria verification steps that don't fit in the module's own
`README.md` — read that first for inputs/outputs and the auth-record table.

## Why a dedicated sending subdomain

Transactional email (invitations, password resets, notifications) is sent from `send.studafy.com`
(`dns_ses_domain` in `prod.tfvars`), never from `studafy.com` itself. Sending reputation is
per-domain: if the transactional stream ever gets flagged as spam (a compromised sender, a bad
send loop, a scraped mailing list), only `send.studafy.com`'s reputation takes the hit —
`api.studafy.com`, `app.studafy.com`, and the apex stay unaffected. The bare apex additionally
publishes `v=spf1 -all` and a `p=reject` DMARC record (when `dns_manage_zone` and
`dns_protect_apex_from_spoofing` are both true) declaring it sends nothing at all — closing off
apex spoofing without any risk of quarantining real mail, since there is no real mail from the
apex to quarantine.

## What "authenticated" actually requires

Three independent mechanisms, all three checked by Gmail and Outlook before a message lands in
the inbox instead of spam:

| Mechanism | What it proves                                                                       | Where it lives                                                 |
| --------- | ------------------------------------------------------------------------------------ | -------------------------------------------------------------- |
| SPF       | The sending server is authorized to send for the envelope-from domain.               | TXT on `bounce.send.studafy.com` (the custom MAIL FROM domain) |
| DKIM      | The message wasn't altered in transit; signed by a key the domain published.         | 3× CNAME on `<token>._domainkey.send.studafy.com` (Easy DKIM)  |
| DMARC     | Ties SPF/DKIM to the visible From address and tells receivers what to do on failure. | TXT on `_dmarc.send.studafy.com`                               |

SPF alone is not enough — it's checked against the envelope-from (`Return-Path`) domain, which a
forwarded or spoofed message can set to anything. DKIM alone is not enough either — a message can
carry a valid signature from an unrelated domain. DMARC is what makes the other two mean
something: it requires the domain that actually signed (DKIM) or actually sent (SPF) to match —
under DMARC's default _relaxed_ alignment — the organizational domain in the visible `From:`
header. That's why the custom MAIL FROM domain (`bounce.send.studafy.com`) is a subdomain of
`send.studafy.com` rather than SES's own `amazonses.com`: relaxed alignment checks the
organizational domain (`studafy.com`), and `bounce.send.studafy.com` shares it with
`send.studafy.com`; `amazonses.com` does not.

## `p=quarantine`, not `p=reject`

This is the first DMARC policy `send.studafy.com` has ever had. `quarantine` tells receivers to
route a failing message to spam instead of accepting it outright — but not to drop it silently the
way `reject` does. That distinction matters here specifically because `reject` failures are often
invisible to the sender (no bounce, no report you'd notice quickly), while `quarantine` failures
still generate aggregate reports and land in a mailbox a human can eventually find. Tightening to
`reject` is a deliberate follow-up once `dmarc_rua` reports show clean alignment across real
traffic, not a default to reach for immediately.

## Verifying "test invitation email passes Gmail/Outlook auth checks"

No application code sends transactional email yet (see `modules/dns/README.md`'s "What this
module does not do" — `apps/workers`' `notifications` queue is not wired to a sender). Until it
is, verify the DNS side directly with a manual send through SES:

```bash
# One-time, if ses_domain isn't out of the SES sandbox yet: sandbox accounts can only send to
# addresses that are themselves verified identities. Request production access first, or verify
# the destination Gmail/Outlook address as a second SES identity for testing.
aws ses send-email \
  --from "no-reply@send.studafy.com" \
  --destination "ToAddresses=your-test-address@gmail.com" \
  --message "Subject={Data=Deliverability test},Body={Text={Data=test}}"
```

Then, in the received message:

- **Gmail**: open the message → ⋮ → "Show original". Look for `SPF: PASS`, `DKIM: 'PASS'`,
  `DMARC: 'PASS'` in the header block Gmail renders at the top.
- **Outlook**: open the message → "View" → "View message details" (or the "..." menu →
  "Message details" in Outlook on the web). Look for `spf=pass`, `dkim=pass`, `dmarc=pass` in the
  `Authentication-Results` header.

A `dkim=pass` with a mismatched `d=` domain, or an `spf=pass` that isn't followed by `dmarc=pass`,
means alignment is broken even though the individual mechanisms technically passed — re-check that
the `From:` address is actually `@send.studafy.com` and not a different domain routed through the
same sender.

## Verifying "DMARC reports received"

Aggregate reports (`rua`) are sent by receivers roughly once a day per receiver, not per message —
don't expect one immediately after a single test send. Point `dns_dmarc_rua` at a real inbox (or a
DMARC report analyzer's ingestion address; this module provisions neither) and check it a few days
after the first real send volume, not right after `terraform apply`.

## How sending is wired

- **Sender:** apps/workers (`queues/notifications/email/sender.ts`) sends as `"Studafy"
<no-reply@send.studafy.com>` through SES in `SES_REGION`, using the configuration set in
  `SES_CONFIGURATION_SET`. Per tier in `infra/deploy/environments/<tier>.env`; the configuration set
  comes from Terraform output via `render.sh`.
- **Never silent:** a production-mode worker refuses to boot without `SES_REGION` unless
  `EMAIL_DRY_RUN=true` says on purpose that the tier only records emails (dev, staging — no
  verified sending domain there).
- **Permission:** `modules/email` grants the workers task role `ses:SendEmail`/`ses:SendRawEmail`
  on exactly this identity and configuration set, and only from `*@send.studafy.com`.
- **Bounces and complaints:** the configuration set publishes `BOUNCE` and `COMPLAINT` events to the
  `<prefix>-email-events` SNS topic, subscribed to the API's `/email/webhooks/sns`, which verifies
  the signature against `EMAIL_EVENTS_SNS_TOPIC_ARN`, confirms the subscription itself on first
  deploy, and suppresses the address. SES's account-level suppression list is on as a backstop.

## Known gaps

- **No mail-receiving infrastructure.** `dns_dmarc_rua` in `prod.tfvars` is currently a
  placeholder address (`dmarc-reports@studafy.com`) with no MX record or inbox behind it anywhere
  in this repo. DMARC reports will bounce, undetected, until that's wired to something real.
- **SES sandbox.** A newly-verified SES identity starts in the sandbox (send only to other
  verified identities, low rate limit). Request production access before the invitation-email
  acceptance test needs to reach a real, unverified inbox at scale.
