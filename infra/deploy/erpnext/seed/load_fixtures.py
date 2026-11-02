"""Loads infra/deploy/erpnext/seed/fixtures.json's synthetic placeholder records into whichever
site `python -m erpnext_seed.provision <hostname> fixtures` is run against.

Not anonymized production data — see fixtures.json's sibling README.md. Not idempotent — designed
to run once per seed tenant, immediately after `bench new-site`, via
infra/deploy/scripts/erpnext-new-site.sh's --seed flag.
"""

import datetime
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

    # A Student Group needs an academic year and a grouping basis; the current school year
    # (September to August) is created if the site has none yet.
    today = datetime.date.today()
    start_year = today.year if today.month >= 9 else today.year - 1
    academic_year = f"{start_year}-{(start_year + 1) % 100:02d}"
    if not frappe.db.exists("Academic Year", academic_year):
        frappe.get_doc(
            {
                "doctype": "Academic Year",
                "academic_year_name": academic_year,
                "year_start_date": datetime.date(start_year, 9, 1),
                "year_end_date": datetime.date(start_year + 1, 8, 31),
            }
        ).insert(ignore_permissions=True)

    group = fixtures["student_group"]
    frappe.get_doc(
        {
            "doctype": "Student Group",
            "student_group_name": group["student_group_name"],
            "group_based_on": "Batch",
            "academic_year": academic_year,
            "program": group["program"],
            "students": [{"student": name} for name in student_names],
        }
    ).insert(ignore_permissions=True)

    frappe.db.commit()
