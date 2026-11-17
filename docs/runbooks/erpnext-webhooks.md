# Runbook: per-site ERPNext webhook secrets (QA-034)

## Why

Every school has its own ERPNext site. All of them used to sign webhooks with one shared secret, `ERPNEXT_WEBHOOK_SECRET`, and the API took the school from the payload's `school_id`. Anyone who could read that secret on one school's site could inject invoices and payments into **another** school's records, and trigger fee notices to its guardians.

Now:

- Each site signs with **its own** secret: `HMAC-SHA256(ERPNEXT_WEBHOOK_SECRET, "erpnext-webhook-site:v1:<school id>")`, hex. The API and `infra/erpnext/seed/provision.py` derive it the same way.
- Each site sends its school in an `X-Studafy-School` header. The API picks that school's derived secret, so the header is covered by the signature.
- A payload naming a different `school_id` than the signing site gets **403**, and no row is written.
- A request without the header gets **401**, unless the rollout switch below is on.

The API still holds only the master secret, and sites hold only their own derived secret. Nothing new is stored.

## Rollout (NEEDS HUMAN, once)

1. Set `ERPNEXT_WEBHOOK_ACCEPT_SHARED_SECRET=true` on `studafy-core-api` (`fly secrets set ... --stage`), then deploy the QA-034 build. Existing sites keep working; the API logs `webhook accepted with the shared secret; re-provision this site (QA-034)` for each one still on the old scheme.
2. Re-provision each school's site. `provision.py setup` is idempotent, and it rewrites each Studafy webhook with the site secret and the header:

   ```bash
   cd sites && STUDAFY_ERPNEXT_API_KEY=... STUDAFY_ERPNEXT_WEBHOOK_SECRET=<master> \
     ../env/bin/python -m erpnext_seed.provision <site> setup --company ... --abbr ... \
     --school-id <school uuid> --api-url https://api.studafy.com
   ```

3. Wait until no new `re-provision this site` lines appear in Axiom for 24 hours.
4. Unset the switch: `fly secrets unset -a studafy-core-api ERPNEXT_WEBHOOK_ACCEPT_SHARED_SECRET`.
5. **Rotate the master secret.** It was readable on every site, so treat it as exposed. Set a new `ERPNEXT_WEBHOOK_SECRET`, deploy, then re-run step 2 for every site.
