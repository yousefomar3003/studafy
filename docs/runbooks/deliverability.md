# Email deliverability (R-08)

Transactional email (invitations, school email verification, account deletion, purchase
confirmations, billing notices, sales and school-application mail) is sent through
[Resend](https://resend.com) from `no-reply@send.studafy.com`.

**Studafy sends no notification email.** Notifications go to the in-app inbox and to phone push
only. The notification dispatcher has no email channel (the catalog in
`packages/notification-templates` is typed in_app/push), the preferences API neither offers nor
accepts `email`, and the daily digest emails are retired: their BullMQ schedulers are removed on
every worker boot and any `digest.sent` / `notification.digestSent` outbox row is marked dispatched
without being sent (`apps/workers/src/queues/notifications/email/retired-digests.ts`). DNS for `studafy.com` is hosted on
Vercel (`ns1/ns2.vercel-dns.com`); every record below is managed in Vercel → Domains → studafy.com →
DNS Records, not in Terraform.

## Why a dedicated sending subdomain

Mail is sent from `send.studafy.com`, never from `studafy.com` itself. Sending reputation is
per-domain: if the transactional stream ever gets flagged as spam (a compromised sender, a bad
send loop, a scraped mailing list), only `send.studafy.com`'s reputation takes the hit — the apex,
`api.studafy.com`, and the staff mailboxes on Microsoft/Google stay unaffected.

## Resend domain

| Setting      | Value                                                                     |
| ------------ | ------------------------------------------------------------------------- |
| Domain       | `send.studafy.com`                                                        |
| Region       | Ireland (`eu-west-1`) — keeps recipient data in the EU, next to Frankfurt |
| Resend Forge | Enabled (Resend's own MTA; the return path points at `*.forge.rmta.net`)  |
| Status       | Verified 2026-11-09                                                       |

A Resend domain's region cannot be changed. Moving region means deleting the domain, adding it
again, and replacing the DKIM record (the new domain gets a new key).

## What "authenticated" requires, and where it lives

| Mechanism | What it proves                                                                       | Record (Vercel name → value)                                                       |
| --------- | ------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------- |
| DKIM      | The message wasn't altered in transit; signed by a key the domain published.         | TXT `resend._domainkey.send` → `p=MIGf…` (exactly one; copy from Resend → Records) |
| SPF       | The sending server is authorized for the envelope-from (return-path) domain.         | `send.send` → CNAME to `send.forge.rmta.net` (Forge serves the SPF and bounce MX)  |
| DMARC     | Ties SPF/DKIM to the visible From address and tells receivers what to do on failure. | TXT `_dmarc` → `v=DMARC1; p=none;`                                                 |

DMARC's relaxed alignment checks the organizational domain (`studafy.com`). The DKIM `d=` is
`send.studafy.com` and the return path is `send.send.studafy.com`, both under `studafy.com`, so
both align with the `From:` address.

Only one TXT record may exist at `resend._domainkey.send`. A stale key left behind (for example
after re-creating the domain) makes DKIM fail intermittently at some receivers even while Resend
still shows the domain as Verified. Check with:

```bash
dig +short TXT resend._domainkey.send.studafy.com @ns1.vercel-dns.com   # must print one key
dig +short TXT _dmarc.studafy.com @ns1.vercel-dns.com
dig +short CNAME send.send.studafy.com @ns1.vercel-dns.com              # send.forge.rmta.net.
```

### DMARC policy

`p=none` is monitoring only: receivers apply no policy to failing mail. Add
`rua=mailto:<inbox>` to receive aggregate reports, and tighten to `p=quarantine` once a few weeks
of reports show clean alignment across real traffic. Note the record sits at the apex, so it also
covers mail the staff mailboxes send as `@studafy.com` — check those pass before tightening.

## Verifying a send passes Gmail/Outlook checks

Send from Resend → Emails → Send test (from `no-reply@send.studafy.com`) to a Gmail and an Outlook
address, then in the received message:

- **Gmail**: ⋮ → "Show original". Look for `SPF: PASS`, `DKIM: 'PASS'`, `DMARC: 'PASS'`.
- **Outlook**: "View" → "View message details". Look for `spf=pass`, `dkim=pass`, `dmarc=pass` in
  `Authentication-Results`.

A `dkim=pass` with an unrelated `d=` domain, or an `spf=pass` not followed by `dmarc=pass`, means
alignment is broken even though the individual mechanisms passed — check that the `From:` address
is actually `@send.studafy.com`.

### Licence payment emails (billing, not notifications)

Overdue school-licence instalments are emailed (owner decision, 2026-11-17, migration 000233). These
are billing mail to the school's paying contacts, like the invoice itself, so they go through this
transactional channel and the "no notification email" rule above does not apply to them:

- **When:** an instalment unpaid the day after its due date (`instalment_overdue`), 7 days before the
  AI cutoff 30 days after its due date (`ai_stop_warning`), and when the licence's AI stops for it
  (`ai_stopped`). Each once per instalment and kind: the workers' licence reminder job writes the
  `licenseInvoice.paymentEmail` outbox events in the transaction that claims the reminder in
  `app.license_reminders`.
- **To:** the school's active ORG_ADMINs and PRINCIPALs and the school's own contact address once
  verified, one outbox event (and one delivery row) per address. In the school's language
  (`school_settings.locale`, English or Arabic).
- **What:** the invoice number, which payment of how many, the amount still due, the due date, the
  cutoff date, the licence period, how to pay (bank details and payment reference, and the
  instalment's Revolut "Pay online" link when it has one) and a link to the invoice page. No student
  data.
- **Templates:** `license-instalment-overdue`, `license-ai-stop-warning`, `license-ai-stopped` in
  `app.email_deliveries`; rendered by `renderLicensePaymentEmail`
  (`apps/workers/src/queues/notifications/email/templates.ts`). Suppressions, retries and
  idempotency keys apply as for every other transactional email.

## How sending is wired

- **Sender:** apps/workers (`queues/notifications/email/sender.ts`) posts to Resend's
  `POST /emails` as `"Studafy" <no-reply@send.studafy.com>` with `RESEND_API_KEY` (a
  sending-access key restricted to `send.studafy.com`). `EMAIL_FROM_ADDRESS` / `EMAIL_FROM_NAME`
  override the defaults.
- **No duplicates on retry:** every dispatcher send carries `Idempotency-Key: outbox-event-<id>`,
  so a retry after a timeout returns the original send instead of mailing again (Resend keeps keys
  for 24 hours).
- **Retries:** 429, 5xx, timeouts, and connection errors roll the outbox row back for the next
  cycle; any other error (validation, invalid key) records a terminal `failed` delivery.
- **Pacing:** `EMAIL_MAX_RATE_PER_SECOND` (default 2, Resend's default team limit). Raise it only
  after Resend raises the account's limit.
- **Never silent:** a production-mode worker refuses to boot without `RESEND_API_KEY` unless
  `EMAIL_DRY_RUN=true` says on purpose that the tier only records emails (dev, staging).
- **Bounces and complaints:** a Resend webhook posts `email.delivered`, `email.bounced`,
  `email.complained`, and `email.delivery_delayed` to the API's `/email/webhooks/resend`. The API
  verifies the Svix signature with `RESEND_WEBHOOK_SECRET` (the endpoint's `whsec_…` signing
  secret, five-minute replay window), records each event once in `app.email_events`, suppresses
  permanent bounces and complaints in `app.email_suppressions`, and moves the delivery to
  `bounced` / `complained`. `delivery_delayed` is acknowledged and ignored. Resend's own
  suppression list also applies as a backstop.

## Secrets

| Variable                | Service | Where it comes from                                         |
| ----------------------- | ------- | ----------------------------------------------------------- |
| `RESEND_API_KEY`        | workers | Resend → API Keys (Sending access, domain send.studafy.com) |
| `RESEND_WEBHOOK_SECRET` | api     | Resend → Webhooks → the endpoint → Signing secret           |

Rotating the webhook secret: Resend keeps signing with both secrets for a while; deploy the new
value, then let the old one expire. The verifier accepts any matching `v1` entry.

## Known gaps

- **No DMARC reports yet.** The `_dmarc` record has no `rua`, so failures are invisible until one
  is added.
