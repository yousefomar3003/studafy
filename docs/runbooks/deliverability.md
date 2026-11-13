# Email deliverability (R-08)

Transactional email is sent through Resend. DNS for studafy.com is hosted by Vercel
(`infra/fly/README.md`'s "Domains"); the sending domain's authentication records are the ones
Resend's dashboard lists for that domain, created in Vercel DNS. This doc is the conventions and
verification steps around them.

## Why a dedicated sending subdomain

Transactional email (invitations, password resets, notifications) is sent from `send.studafy.com`
(the workers' `EMAIL_FROM_ADDRESS` default, `no-reply@send.studafy.com`), never from `studafy.com`
itself. Sending reputation is
per-domain: if the transactional stream ever gets flagged as spam (a compromised sender, a bad
send loop, a scraped mailing list), only `send.studafy.com`'s reputation takes the hit —
`api.studafy.com`, `app.studafy.com`, and the apex stay unaffected. The apex's own mail is Zoho,
whose MX/SPF records in Vercel DNS must be left alone.

## What "authenticated" actually requires

Three independent mechanisms, all three checked by Gmail and Outlook before a message lands in
the inbox instead of spam:

| Mechanism | What it proves                                                                       | Where it lives                                           |
| --------- | ------------------------------------------------------------------------------------ | -------------------------------------------------------- |
| SPF       | The sending server is authorized to send for the envelope-from domain.               | The SPF record Resend lists for the domain               |
| DKIM      | The message wasn't altered in transit; signed by a key the domain published.         | The DKIM record Resend lists for the domain              |
| DMARC     | Ties SPF/DKIM to the visible From address and tells receivers what to do on failure. | TXT on `_dmarc.send.studafy.com` (not managed by Resend) |

SPF alone is not enough — it's checked against the envelope-from (`Return-Path`) domain, which a
forwarded or spoofed message can set to anything. DKIM alone is not enough either — a message can
carry a valid signature from an unrelated domain. DMARC is what makes the other two mean
something: it requires the domain that actually signed (DKIM) or actually sent (SPF) to match —
under DMARC's default _relaxed_ alignment — the organizational domain in the visible `From:`
header. That's why the envelope-from (return-path) domain must be a subdomain of `studafy.com`
rather than the provider's own domain: relaxed alignment checks the organizational domain
(`studafy.com`), and a provider domain does not share it.

## `p=quarantine`, not `p=reject`

`quarantine` tells receivers to
route a failing message to spam instead of accepting it outright — but not to drop it silently the
way `reject` does. That distinction matters here specifically because `reject` failures are often
invisible to the sender (no bounce, no report you'd notice quickly), while `quarantine` failures
still generate aggregate reports and land in a mailbox a human can eventually find. Tightening to
`reject` is a deliberate follow-up once aggregate (`rua`) reports show clean alignment across
real traffic, not a default to reach for immediately. The DMARC record itself is not defined in
this repository; check what Vercel DNS actually publishes before relying on this section.

## Verifying "test invitation email passes Gmail/Outlook auth checks"

Send a real invitation (or a password reset) from production to a Gmail and an Outlook address.
Resend's dashboard (Emails) shows each message and whether it was delivered.

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
don't expect one immediately after a single test send. Point the DMARC record's `rua` at a real inbox (or a
DMARC report analyzer's ingestion address) and check it a few days after the first real send
volume.

## How sending is wired

- **Sender:** apps/workers (`queues/notifications/email/sender.ts`) sends through Resend as
  `EMAIL_FROM_NAME` <`EMAIL_FROM_ADDRESS`> (defaults `"Studafy"` <no-reply@send.studafy.com>,
  `apps/workers/src/env.ts`). The address must be on a domain verified in Resend. `RESEND_API_KEY`
  is a `prod` secret copied to the workers app (`infra/fly/README.md`).
- **Never silent:** a production-mode worker refuses to boot without `RESEND_API_KEY` unless
  `EMAIL_DRY_RUN=true` says on purpose that it only records emails (renders, dedups and records
  deliveries without calling Resend).
- **Bounces and complaints:** Resend posts events to the API's `/email/webhooks/resend`
  (`apps/api/src/email/webhook.ts`), which verifies Resend's Svix signature with
  `RESEND_WEBHOOK_SECRET` before parsing, records each event once in `app.email_events`, and adds
  hard-bounce and complaint addresses to `app.email_suppressions`, which the dispatcher checks
  before every send.

## Known gaps

- **DMARC reports.** No inbox for aggregate reports is defined in this repository. Until the
  `rua` address in the published DMARC record reaches a real mailbox, reports go unread.
