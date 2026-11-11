# ERPNext site setup and seed fixtures

This directory is baked into `infra/docker/erpnext.Dockerfile`'s image as the `erpnext_seed`
package (`/home/frappe/frappe-bench/erpnext_seed/`, on PYTHONPATH). Run it as a module from the
bench's `sites` directory -- `python -m erpnext_seed.provision <site> <step>` -- not through
`bench execute`, which swallows the real exception and reports a misleading NameError instead.

| Step       | What it does                                                                                                                                           | Run by                                                         |
| ---------- | ------------------------------------------------------------------------------------------------------------------------------------------------------ | -------------------------------------------------------------- |
| `setup`    | ERPNext's setup wizard (the school's company) and the integration user with the shared `ERPNEXT_API_KEY` (from `STUDAFY_ERPNEXT_API_KEY`). Idempotent. | `erpnext-new-site.sh` for every school; `bun run erpnext:site` |
| `fixtures` | The synthetic records below (`fixtures.json`, `load_fixtures.py`). Not idempotent.                                                                     | `erpnext-new-site.sh ... --seed` (a demo tenant only)          |
| `demo`     | Sample tuition invoices and payments for the Finance dashboard. Local only. Idempotent.                                                                | `bun run erpnext:site`                                         |

## Seed fixtures

`fixtures.json` and `load_fixtures.py` are the concrete mechanism behind the "seed tenant usable
end-to-end" acceptance criterion.

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

- **Exercised against the pinned image locally** (2026-10-12, `db/compose.yml`'s erpnext profile),
  which is how the Student Group's required academic year and grouping basis were found missing.
- **Not idempotent.** Re-running `--seed` against a site that already has these records will fail
  on the doctypes' own uniqueness constraints (e.g. `Student.student_email_id`), the same way
  `bench new-site` itself isn't idempotent against an existing site — this is meant to run once per
  seed tenant, not on every deploy.
