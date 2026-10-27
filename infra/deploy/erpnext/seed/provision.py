"""Per-site setup the Studafy API depends on, run with `bench --site <site> execute`.

`bench new-site` only creates an empty Frappe site. Before apps/api can use it, every school's site
also needs:

- `complete_setup` -- ERPNext's setup wizard finished: the school's Company (with its chart of
  accounts, fiscal year and currency), which every finance call and report is scoped to.
- `set_integration_key` -- the integration user apps/api authenticates as. apps/api holds ONE
  credential for every school's site (`ERPNEXT_API_KEY`, "<api_key>:<api_secret>", sent as
  `Authorization: token ...`; the Host header picks the site), so the same key and secret are set on
  each site.

Both are idempotent, so re-running a site's setup is safe. `load_finance_demo` is local-only sample
data (`bun run erpnext:site`); production sites never run it.

Run from the bench's `sites` directory as a module, not through `bench execute` (which swallows the
real exception and reports a misleading NameError instead):

    cd sites && ../env/bin/python -m erpnext_seed.provision <site> setup --company "..." ...

infra/deploy/scripts/erpnext-new-site.sh runs it in staging/prod; apps/api/scripts/
init-local-erpnext.ts runs it locally. The integration credential is read from the
STUDAFY_ERPNEXT_API_KEY environment variable ("<api_key>:<api_secret>"), never from the command
line, so it does not land in shell history or the process list.
"""

import argparse
import datetime
import os
import sys

import frappe

INTEGRATION_USER = "integration@studafy.app"
INTEGRATION_ROLES = (
    "System Manager",
    "Accounts Manager",
    "Accounts User",
    "Education Manager",
    "Academics User",
    "Purchase User",
)


def complete_setup(company_name, company_abbr, currency, country, timezone="Asia/Amman"):
    """Run ERPNext's setup wizard once, creating the school's Company. Returns the company name."""
    if frappe.is_setup_complete():
        existing = frappe.db.get_single_value("Global Defaults", "default_company")
        print(f"setup already complete (company: {existing})")
        return existing

    from frappe.desk.page.setup_wizard.setup_wizard import setup_complete

    year = datetime.date.today().year
    setup_complete(
        {
            "language": "English",
            "country": country,
            "timezone": timezone,
            "currency": currency,
            "full_name": "Studafy Administrator",
            "company_name": company_name,
            "company_abbr": company_abbr,
            "chart_of_accounts": "Standard",
            "fy_start_date": f"{year}-01-01",
            "fy_end_date": f"{year}-12-31",
            "setup_demo": 0,
        }
    )
    frappe.db.commit()
    print(f"setup complete (company: {company_name})")
    return company_name


def set_integration_key(api_key, api_secret):
    """Create or update the integration user and give it the shared Studafy API credential."""
    if frappe.db.exists("User", INTEGRATION_USER):
        user = frappe.get_doc("User", INTEGRATION_USER)
    else:
        user = frappe.get_doc(
            {
                "doctype": "User",
                "email": INTEGRATION_USER,
                "first_name": "Studafy Integration",
                "user_type": "System User",
                "send_welcome_email": 0,
            }
        )
        user.insert(ignore_permissions=True)

    present = {row.role for row in user.roles}
    for role in INTEGRATION_ROLES:
        if role not in present and frappe.db.exists("Role", role):
            user.append("roles", {"role": role})

    user.api_key = api_key
    user.api_secret = api_secret
    user.save(ignore_permissions=True)
    frappe.db.commit()
    print(f"integration key set on {INTEGRATION_USER}")


# The document events apps/api projects (ERPNEXT_DOC_EVENT_MAP in packages/constants/src/events.ts):
# `<doctype>-<action>`, where a submitted Sales Invoice that is a return is a credit note.
WEBHOOK_EVENTS = ("Sales Invoice", "Payment Entry", "Fee Schedule", "Fee Structure")

# The body apps/api's POST /erpnext/webhooks expects. The site has no notion of which Studafy school
# it belongs to, so the school id is baked into each site's template at setup and spliced in front
# of the document's own JSON. No method calls: webhooks render in Frappe's restricted Jinja sandbox,
# where `doc.as_dict()` and `dict.update()` are not callable.
WEBHOOK_TEMPLATE = (
    '{"event_id": "{{ doc.doctype }}:{{ doc.name }}:{{ doc.modified }}",'
    ' "doctype": "{{ doc.doctype }}",'
    ' "action": "{% if doc.is_return %}return{% else %}submitted{% endif %}",'
    ' "data": {"school_id": "__SCHOOL_ID__", {{ (doc | json)[1:] }}}'
)


def install_webhooks(school_id, api_url, secret):
    """One Frappe Webhook per projected doctype, posting to apps/api signed with the shared secret.

    Frappe signs each request body (base64 HMAC-SHA256 in X-Frappe-Webhook-Signature), which
    apps/api verifies with ERPNEXT_WEBHOOK_SECRET. Idempotent: an existing hook is updated in place.
    """
    url = api_url.rstrip("/") + "/erpnext/webhooks"
    template = WEBHOOK_TEMPLATE.replace("__SCHOOL_ID__", school_id)
    for doctype in WEBHOOK_EVENTS:
        if not frappe.db.exists("DocType", doctype):
            continue
        name = f"Studafy {doctype}"
        if frappe.db.exists("Webhook", name):
            hook = frappe.get_doc("Webhook", name)
        else:
            hook = frappe.new_doc("Webhook")
            hook.set("__newname", name)  # Webhook names are set by hand ("Prompt")
        hook.update(
            {
                "webhook_doctype": doctype,
                "webhook_docevent": "on_submit",
                "enabled": 1,
                "request_url": url,
                "request_method": "POST",
                "request_structure": "JSON",
                "webhook_json": template,
                "enable_security": 1,
                "webhook_secret": secret,
            }
        )
        hook.set("webhook_headers", [{"key": "Content-Type", "value": "application/json"}])
        hook.save(ignore_permissions=True)
    frappe.db.commit()
    print(f"webhooks installed -> {url}")


def ensure_scholarship_award_doctype():
    """`Scholarship Award`, which apps/api's scholarships module records awards in.

    Neither ERPNext nor Frappe Education defines it, so each site gets it as a custom doctype: a
    record of the confirmed award (the Studafy student, the scholarship/discount, the school).
    Idempotent.
    """
    if frappe.db.exists("DocType", "Scholarship Award"):
        return
    frappe.get_doc(
        {
            "doctype": "DocType",
            "name": "Scholarship Award",
            "module": "Education",
            "custom": 1,
            "autoname": "hash",
            "track_changes": 1,
            "fields": [
                {"fieldname": "student", "label": "Student", "fieldtype": "Data", "reqd": 1, "in_list_view": 1},
                {"fieldname": "scholarship_discount", "label": "Scholarship / Discount", "fieldtype": "Data", "in_list_view": 1},
                {"fieldname": "award_status", "label": "Award Status", "fieldtype": "Data", "in_list_view": 1},
                {"fieldname": "custom_school_id", "label": "Studafy School", "fieldtype": "Data"},
            ],
            "permissions": [
                {"role": role, "read": 1, "write": 1, "create": 1, "delete": 1}
                for role in ("System Manager", "Accounts Manager", "Accounts User")
            ],
        }
    ).insert(ignore_permissions=True)
    frappe.db.commit()
    print("Scholarship Award doctype created")


DEMO_FAMILIES = (
    # (customer, student name, invoice amount, days ago issued, days until due, amount paid)
    #
    # The customer is the student's admission number in the Studafy demo seed
    # (db/seeds/mock-credentials.ts): Studafy names a student's ERPNext Customer after it
    # (buildStudentCustomerId), and that is how the invoice and payment webhooks find the student.
    # Adam and Mira Fares are siblings, so the Fares family has two children owing at once.
    ("STU-0001", "Yara Khalil", 1200, 95, 30, 1200),
    ("STU-0002", "Adam Fares", 1200, 95, 30, 600),
    ("STU-0003", "Nour Saleh", 1350, 70, 30, 0),
    ("STU-0004", "Zaid Mansour", 1350, 40, 30, 1350),
    ("STU-0001", "Yara Khalil", 450, 20, 30, 0),
    ("STU-0002", "Adam Fares", 450, 10, 45, 0),
    ("STU-0009", "Mira Fares", 1080, 50, 20, 0),
)


def load_finance_demo(company):
    """Local-only sample data: tuition invoices at different ages, some paid, some partly paid."""
    if frappe.db.exists("Sales Invoice", {"remarks": "Studafy local demo", "docstatus": 1}):
        print("finance demo already loaded")
        return

    from erpnext.accounts.doctype.payment_entry.payment_entry import get_payment_entry

    if not frappe.db.exists("Item", "Tuition Fee"):
        frappe.get_doc(
            {
                "doctype": "Item",
                "item_code": "Tuition Fee",
                "item_name": "Tuition Fee",
                "item_group": "Services",
                "stock_uom": "Nos",
                "is_stock_item": 0,
            }
        ).insert(ignore_permissions=True)

    today = datetime.date.today()
    for customer, student_name, amount, issued_ago, due_in, paid in DEMO_FAMILIES:
        if not frappe.db.exists("Customer", customer):
            frappe.get_doc(
                {
                    "doctype": "Customer",
                    "customer_name": student_name,
                    "customer_type": "Individual",
                    "customer_group": "Individual",
                    "territory": "All Territories",
                }
            ).insert(ignore_permissions=True, set_name=customer)

        posting = today - datetime.timedelta(days=issued_ago)
        invoice = frappe.get_doc(
            {
                "doctype": "Sales Invoice",
                "company": company,
                "customer": customer,
                "set_posting_time": 1,
                "posting_date": posting,
                "due_date": posting + datetime.timedelta(days=due_in),
                "remarks": "Studafy local demo",
                "items": [{"item_code": "Tuition Fee", "qty": 1, "rate": amount}],
            }
        )
        invoice.insert(ignore_permissions=True)
        invoice.submit()

        if paid:
            payment = get_payment_entry("Sales Invoice", invoice.name)
            payment.posting_date = posting + datetime.timedelta(days=min(due_in, issued_ago))
            payment.reference_no = f"DEMO-{invoice.name}"
            payment.reference_date = payment.posting_date
            payment.paid_amount = paid
            payment.received_amount = paid
            payment.references[0].allocated_amount = paid
            payment.insert(ignore_permissions=True)
            payment.submit()

    frappe.db.commit()
    print(f"finance demo loaded: {len(DEMO_FAMILIES)} invoices")


def main(argv=None):
    parser = argparse.ArgumentParser(prog="python -m erpnext_seed.provision")
    parser.add_argument("site", help="the site hostname, e.g. <slug>.erpnext.studafy.com")
    parser.add_argument("step", choices=("setup", "demo", "fixtures"))
    parser.add_argument("--company", help="setup: the school's company name")
    parser.add_argument("--abbr", help="setup: a short company abbreviation, e.g. SDA")
    parser.add_argument("--currency", default="JOD")
    parser.add_argument("--country", default="Jordan")
    parser.add_argument("--school-id", help="setup: the Studafy school id, stamped on webhooks")
    parser.add_argument("--api-url", help="setup: apps/api's base URL the webhooks post to")
    args = parser.parse_args(argv)

    frappe.init(site=args.site, sites_path=".")
    frappe.connect()
    frappe.set_user("Administrator")
    try:
        if args.step == "setup":
            if not args.company or not args.abbr:
                parser.error("setup needs --company and --abbr")
            credential = os.environ.get("STUDAFY_ERPNEXT_API_KEY", "")
            api_key, _, api_secret = credential.partition(":")
            if not api_key or not api_secret:
                parser.error("STUDAFY_ERPNEXT_API_KEY must be set to <api_key>:<api_secret>")
            webhook_secret = os.environ.get("STUDAFY_ERPNEXT_WEBHOOK_SECRET", "")
            if not args.school_id or not args.api_url or not webhook_secret:
                parser.error(
                    "setup needs --school-id, --api-url and STUDAFY_ERPNEXT_WEBHOOK_SECRET "
                    "(the webhooks apps/api projects invoices and payments from)"
                )
            company = complete_setup(args.company, args.abbr, args.currency, args.country)
            set_integration_key(api_key, api_secret)
            ensure_scholarship_award_doctype()
            install_webhooks(args.school_id, args.api_url, webhook_secret)
            print(f"STUDAFY_COMPANY={company}")
        elif args.step == "fixtures":
            from erpnext_seed.load_fixtures import load_fixtures

            load_fixtures()
            frappe.db.commit()
        else:
            load_finance_demo(frappe.db.get_single_value("Global Defaults", "default_company"))
    finally:
        frappe.destroy()


if __name__ == "__main__":
    sys.exit(main())
