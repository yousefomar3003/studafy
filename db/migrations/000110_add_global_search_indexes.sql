-- Global search (ST-278): Postgres full-text search columns + GIN indexes backing
-- GET /api/search across app.students, app.users, app.invoice_cache, and app.materials.
--
-- Each column follows the same shape 000019 established for app.material_chunks.content_tsv:
-- GENERATED ALWAYS ... STORED, never a trigger, so the tsvector cannot drift from the source
-- columns it derives from, and a GIN index over it for @@ lookups.
--
-- Two text-search configurations are used, deliberately not one for every table:
--   * 'simple' for app.students, app.users, and app.invoice_cache. Their searchable text is names,
--     email addresses, and an ERPNext document number -- identifiers, not prose. 'simple' does no
--     stemming and drops no stopwords, so a name that happens to collide with an English stopword
--     (or a stem the English dictionary would otherwise fold away) is never silently lost.
--   * 'english' for app.materials, matching the config 000019 already uses for material content:
--     a title/description is natural-language text, where stemming ("Reading" ~ "read") is exactly
--     the recall a search box needs.
--
-- No new RLS policy is added here. app.students and app.materials already carry a
-- role_scope_visibility policy (000037: app.can_read_student / app.can_read_class), so a search hit
-- against either table is already scoped to what the caller may see, for free. app.users and
-- app.invoice_cache carry only the tenant_isolation policy (000006) -- the same posture their
-- existing list endpoints (GET /api/users, GET /api/finance/invoices) already run under -- so the
-- global-search route is what gates which roles reach those two sections at all
-- (PERMISSIONS.USER_READ / PERMISSIONS.BILLING_READ), the same permission each existing endpoint
-- already requires.

SET ROLE studafy_admin;

-- ---------------------------------------------------------------------------
-- app.students: first/middle/last/preferred name + admission number
-- ---------------------------------------------------------------------------
ALTER TABLE app.students
  ADD COLUMN search_tsv tsvector GENERATED ALWAYS AS (
    to_tsvector(
      'simple',
      coalesce(first_name, '') || ' ' || coalesce(middle_name, '') || ' ' ||
      coalesce(last_name, '') || ' ' || coalesce(preferred_name, '') || ' ' ||
      coalesce(admission_number, '')
    )
  ) STORED;

CREATE INDEX idx_students_search_tsv ON app.students USING gin (search_tsv);

-- ---------------------------------------------------------------------------
-- app.users: display name + email
-- ---------------------------------------------------------------------------
ALTER TABLE app.users
  ADD COLUMN search_tsv tsvector GENERATED ALWAYS AS (
    to_tsvector('simple', coalesce(display_name, '') || ' ' || email)
  ) STORED;

CREATE INDEX idx_users_search_tsv ON app.users USING gin (search_tsv);

-- ---------------------------------------------------------------------------
-- app.invoice_cache: the ERPNext invoice number only (see module header above for why global
-- search does not also index a joined student name onto this column).
-- ---------------------------------------------------------------------------
ALTER TABLE app.invoice_cache
  ADD COLUMN search_tsv tsvector GENERATED ALWAYS AS (
    to_tsvector('simple', erpnext_docname)
  ) STORED;

CREATE INDEX idx_invoice_cache_search_tsv ON app.invoice_cache USING gin (search_tsv);

-- ---------------------------------------------------------------------------
-- app.materials: title + description
-- ---------------------------------------------------------------------------
ALTER TABLE app.materials
  ADD COLUMN search_tsv tsvector GENERATED ALWAYS AS (
    to_tsvector('english', title || ' ' || coalesce(description, ''))
  ) STORED;

CREATE INDEX idx_materials_search_tsv ON app.materials USING gin (search_tsv);

RESET ROLE;
