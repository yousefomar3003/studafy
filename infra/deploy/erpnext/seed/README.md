# ERPNext seed fixtures

`fixtures.json` and `load_fixtures.py` are baked into `infra/docker/erpnext.Dockerfile`'s image
(under `/home/frappe/frappe-bench/apps/erpnext_seed/`) and run by
`infra/deploy/scripts/erpnext-new-site.sh <env> <hostname> --seed` after `bench new-site` — the
concrete mechanism behind the "seed tenant usable end-to-end" acceptance criterion.

**This is not anonymized production data.** This repo has no student records, school data, or any
production dataset anywhere to anonymize — there is no pipeline in this repo that touches real
data. `fixtures.json` is hand-written, obviously-synthetic placeholder data (names like "Test
Student One"), just enough to exercise the Education app's core doctypes end-to-end (a program, an
instructor, a couple of students) so a reviewer can confirm the seed tenant actually works, not a
claim about anonymizing anything real.

## Contents

| Doctype         | Count | Notes                                                         |
| --------------- | ----- | ------------------------------------------------------------- |
| `Program`       | 1     | "Test Program" — the Education app's course-grouping doctype. |
| `Instructor`    | 1     | "Test Instructor One".                                        |
| `Student`       | 2     | "Test Student One", "Test Student Two".                       |
| `Student Group` | 1     | Enrolls both test students under the test program.            |

## Known gaps

- **Not exercised against a real bench.** `load_fixtures.py`'s `frappe.get_doc(...).insert()` calls
  follow the Education app's documented doctype field names as of the version this module targets
  — verify against the pinned `infra/docker/erpnext.Dockerfile` tag's actual schema before relying
  on this against a real cluster.
- **Not idempotent.** Re-running `--seed` against a site that already has these records will fail
  on the doctypes' own uniqueness constraints (e.g. `Student.student_email_id`), the same way
  `bench new-site` itself isn't idempotent against an existing site — this is meant to run once per
  seed tenant, not on every deploy.
