# Runbook: ERPNext invoice idempotency field (QA-022)

**Status:** the code is done (QA-022). Each existing production ERPNext site needs one manual step **before** the workers build that contains QA-022 is deployed.

## Why

ERPNext does not deduplicate POSTs. Before QA-022, the worker retried a Sales Invoice POST that timed out or came back 5xx, and re-sent it after a crash before COMMIT. Either way the parent could receive a second invoice.

The worker now stamps every invoice with its idempotency key in the Sales Invoice custom field `custom_studafy_idempotency_key`. Before every POST, it looks the key up and adopts any invoice that already exists. The field is:

- `unique`, so a racing duplicate is refused;
- `no_copy`, so amended or duplicated invoices don't inherit the key.

If the field is missing, the lookup fails and the worker **refuses to create invoices**. This fails closed: no double billing, but no new invoices either. The job error is `INVOICE_GENERATION_FAILED`.

## Steps (per school site)

New sites get the field automatically from `provision.py setup`. For each existing site, on the hosted bench:

```bash
cd sites && ../env/bin/python - <<'PY'
import frappe
frappe.init(site="<slug>.<erpnext domain>", sites_path=".")
frappe.connect()
from erpnext_seed.provision import ensure_invoice_idempotency_field
ensure_invoice_idempotency_field()
frappe.destroy()
PY
```

Check that it worked. In the site's desk, go to **Customize Form → Sales Invoice** and confirm "Studafy Idempotency Key" is there, with Unique and No Copy ticked. Or call the REST API with the integration key:

```bash
curl -s -H "Authorization: token <key>:<secret>" -H "Host: <site>" \
  "<erpnext url>/api/resource/Sales%20Invoice?filters=%5B%5B%22custom_studafy_idempotency_key%22%2C%22%3D%22%2C%22probe%22%5D%5D&fields=%5B%22name%22%5D"
# expect: {"data":[]}   (an error here means the field is missing)
```

## Then

Deploy workers. After the first invoice batch, check that new invoices carry the key. Invoices created before the deploy have an empty key. That's expected: their `app.erpnext_id_mappings` rows still guard them.

## Rollback

You don't need to remove the field. An older workers build ignores it.
