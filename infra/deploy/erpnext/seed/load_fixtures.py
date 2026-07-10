"""Loads infra/deploy/erpnext/seed/fixtures.json's synthetic placeholder records into whichever
site `bench --site <hostname> execute erpnext_seed.load_fixtures` is run against.

Not anonymized production data — see fixtures.json's sibling README.md. Not idempotent — designed
to run once per seed tenant, immediately after `bench new-site`, via
infra/deploy/scripts/erpnext-new-site.sh's --seed flag.
"""

import json
import os

import frappe

_FIXTURES_PATH = os.path.join(os.path.dirname(__file__), "fixtures.json")


def load_fixtures():
    with open(_FIXTURES_PATH, encoding="utf-8") as f:
        fixtures = json.load(f)

    for program in fixtures["programs"]:
        frappe.get_doc({"doctype": "Program", **program}).insert(ignore_permissions=True)

    for instructor in fixtures["instructors"]:
        frappe.get_doc({"doctype": "Instructor", **instructor}).insert(ignore_permissions=True)

    student_names = []
    for student in fixtures["students"]:
        doc = frappe.get_doc({"doctype": "Student", **student}).insert(ignore_permissions=True)
        student_names.append(doc.name)

    group = fixtures["student_group"]
    frappe.get_doc(
        {
            "doctype": "Student Group",
            "student_group_name": group["student_group_name"],
            "program": group["program"],
            "students": [{"student": name} for name in student_names],
        }
    ).insert(ignore_permissions=True)

    frappe.db.commit()
