# Certificate rotation

Rotate or repair the TLS certificates at the two public edges — `infra/terraform/modules/edge`
(ACM cert on the ALB's HTTPS listener) and `infra/terraform/modules/cdn` (us-east-1 ACM cert on the
CloudFront viewer). This runbook exists because "what does a human do" has exactly one honest
answer here in the normal case — _nothing_ — and a specific, short procedure for the two real
failure shapes. Both stacks are ACM + DNS validation; ACM renews DNS-validated certificates
automatically as long as the validation CNAME record stays in place
(`docs/runbooks/edge-security.md`'s "Certificate auto-renewal, concretely").

Provisioning source:
[`infra/terraform/modules/edge/dns.tf`](../../infra/terraform/modules/edge/dns.tf),
[`infra/terraform/modules/cdn/dns.tf`](../../infra/terraform/modules/cdn/dns.tf). Per-subdomain
distribution: `docs/runbooks/environment-matrix.md` (dev/staging/prod each get their own certs —
`dev-api`/`dev`, `staging-api`/`staging`, `api`/`app`).

## Detection

- **Expiry, via the ACM API.** There is no CloudWatch alarm on cert expiry in this repo today —
  the standing check is manual: `aws acm describe-certificate` and watch `NotAfter`, or AWS's own
  expiry reminder emails on the account. ACM auto-renews DNS-validated certs ~30 days before
  expiry; **a cert past 30 days-to-expiry that hasn't rotated is the detection event**.
- **The browser/curl signal.** A client-facing `SEC_ERROR_EXPIRED_CERTIFICATE` /
  `CERT_HAS_EXPIRED` on `https://<edge_domain>` means the cert _expired_ — the automatic renewal
  failed. That is the emergency case (step 3).
- **Terraform drift.** `terraform plan` showing a change to `aws_acm_certificate.this` for
  edge/cdn — a new certificate is in flight because the module was told to reissue
  (input change) or a validation record went missing and the apply re-created it.

## Decision points

1. **Not-yet-expired renewal missed → repair the validation record, don't reissue.** Every
   not-yet-expired problem is a CNAME problem: `aws_route53_record.cert_validation` was deleted,
   the zone record was overwritten, or the record's owner isn't updating via DNS. Restore the
   record (step 2) and ACM completes the renewal it was already scheduled for. Reissuing for a
   schooner that's still valid just creates a second cert to track.
2. **Expired → emergency reissue (step 3).** Once expired, ACM will not "finish" the old cert;
   the local `certificate_arn` is dead to new handshakes. The edges will return to service only
   once a new validated cert is bound — the fresh cert is issued by re-running apply with a
   `domain_validation_options` re-creation, and validated via the same CNAME mechanism.
3. **Deliberate rotation (a "rotate because we decided to" event)** — new domain added (wildcard
   consolidation, apex move) or crypto policy change — is a planned change, not an incident: new
   cert → validate → repoint → verify, in sequence (step 4).

## Procedure

**1. Inventory what's where.**

```bash
# Edge (region cert, ALB). Each environment's module instance; e.g. prod:
terraform -chdir=infra/terraform output -raw edge_certificate_arn    # or: cdn_certificate_arn (us-east-1)
aws acm list-certificates --region <edge-cf-region> \
  --query 'CertificateSummaryList[].[DomainName, CertificateArn]'
aws acm describe-certificate --certificate-arn <arn> \
  --query 'Certificate.{status:Status,renewalEligibility:RenewalEligibility,notAfter:NotAfter,validation:DomainValidationOptions}'
```

The relevant state fields: `Status: ISSUED` (fine), `NotAfter` within 30 days with
`RenewalEligibility: ELIGIBLE` but no rotation (step 2), `Status: FAILED` (validation broke —
step 3). Note the CloudFront cert lives in **us-east-1**, the ALB cert in the deployment region —
two different API calls.

**2. Restore the validation record (the 95% case).**

ACM re-checks the validation CNAME on every renewal/scheduling pass. The record is
`module.edge`/`module.cdn`'s `aws_route53_record.cert_validation`, name
`_<domain-validation-token>.<domain>.` → `<token>.<acm-validations.aws>.`

```bash
aws route53 list-resource-record-sets --hosted-zone-id <zone_id> \
  --query 'ResourceRecordSets[?Type==`CNAME` && starts_with(Name, `_`)]'   # confirm the record's there & correct
# If it's missing or stale: restore it into the zone -- the token/name/value pair comes from
# `aws acm describe-certificate`'s DomainValidationOptions (ResourceRecord), the same pair the
# module originally wrote. `terraform apply` on the module re-creates what its own state says it
# owns and is the normal repair path here, since the record is module-owned.
```

After the record resolves, ACM's next renewal pass turns the cert `ISSUED` with a fresh `NotAfter`.
No apply + no new binding needed for an _unexpired_ cert — the same ARN now carries the renewed
certificate.

**3. Emergency: expired cert. Reissue through the module and rebind.**

```bash
# In the module's directory, ensure the cert resource is set to be recreated and re-validated.
# For edge: the https listener already binds `aws_acm_certificate_validation.this.certificate_arn`,
# so reissuing + validating through apply is what rebinds it:
terraform -chdir=infra/terraform plan   # expect: aws_acm_certificate.this (+ validation) recreated
terraform -chdir=infra/terraform apply  # with a human, in the change window

# Confirm validation completed (AWS applies it when the record resolves to the new token):
aws acm describe-certificate --certificate-arn <new-arn> \
  --query 'Certificate.{status:Status,notAfter:NotAfter}'

# For CloudFront: the distribution also needs the new-arn bound. The module's
# viewer_certificate.acm_certificate_arn follows aws_acm_certificate_validation.this.certificate_arn,
# so a reissue via apply updates it. Front the change with a CloudFront invalidation only if
# cache staleness (not the cert itself) is the user-visible symptom.
```

The redeploy gate here is **DNS propagation of the new validation record**, not the apply itself.
If validation stalls `PENDING_VALIDATION`, check the new token's record in Route 53 and its
resolvability (`dig +short <token>.<domain> CNAME` from the bastion) before waiting.

**4. Deliberate rotation / new domain.** Add or change the `domain_name` / SANs in the module's
variables, plan the new cert, validate, apply, then verify both edges (below). There is no "two
certs at once" -- ACM certs are independent resources; the listener/distribution binding is what
moves traffic to the new one.

## Verifying the edges

```bash
edge_domain="$(terraform -chdir=infra/terraform output -raw edge_domain_name)"   # e.g. api.studafy.com
curl -sv https://"$edge_domain"/healthz -o /dev/null 2>&1 | grep -E 'SSL connection using|subject:|expire date:|issuer:'
# Same idea against the CDN domain; SSL Labs / testssl.sh per environment
# (docs/runbooks/environment-matrix.md's healthz check as the baseline).
```

`subject` must be the environment's own subdomain and `expire date` in the future. For prod: do
NOT treat "the ALB fixed-404 answers" as success beyond TLS — 404 is the current default action's
expected response (no target group yet), the TLS handshake succeeding is the criterion.

## Rollback / abort criteria

- An _unexpired_ cert repair (step 2) should never reach the apply-with-internet-facing change
  window — if it did, stop and revert the module change before it partially binds.
- If acceptance on the new cert fails at step 4 (listener/distribution binds the new ARN but the
  handshake shows the stale subject), the _old_ ARN is still in the state/runbook-observed history:
  reverting to it is possible via the same apply path. But do not hand-flip
  `aws_lb_listener_rule`/`viewer_certificate` bindings outside Terraform — that creates drift that
  the next plan will "fix" and is how a rotation becomes a multi-hour incident.

## Known gaps

- **No expiry alarm and no automation-checked renewal.** "Cert expires in <N> days" in
  CloudWatch (or ACM expiry reminders wired to a channel) plus a scheduled
  `aws acm list-certificates` check is future work. The runbook's detection is manual today.
- **No mandatory dry-run for the reissue path** — `terraform plan` + a domain-validation token
  check are each cheap and each prevent the surprise; neither is enforced by a script yet.
- **CloudFront's us-east-1 provider alias** (`aws.us_east_1` in the cdn module) is easy to operate
  on the wrong region; keep the two inventory commands in step 1 region-correct.
