-- Global search, extended: Arabic-aware normalization, prefix-friendly documents, sixteen more
-- searchable types, trigram typo fallback, and the two changes that make all of it fast under RLS
-- (with no search indexes, which RLS would never use; see 4).
--
-- 1. Normalization. app.search_normalize is the SQL twin of
--    apps/web/src/features/search/normalize.ts#normalizeSearchText and must apply exactly the same
--    rules, or "أحمد" typed in the palette would find a page keyword client-side but no student here:
--      lowercase; strip Arabic harakat U+064B-U+065F, superscript alef U+0670 and tatweel U+0640;
--      unify alef forms أ إ آ ٱ -> ا; alef maqsura ى -> ي; taa marbuta ة -> ه; collapse whitespace
--      (JavaScript's \s set, spelled out so the result never depends on the database locale) and trim.
--    app.search_document additionally folds punctuation to spaces. The API tokenizes a query into
--    letter/digit runs (\p{L}\p{N}); the 'simple' parser on its own reads "INV-0012" as 'inv' plus a
--    signed integer '-0012' and "omar.k@x.com" as one email token, so the prefix query 'inv' & '00':*
--    or 'omar' & 'x':* would never match. Folding punctuation first makes both sides split the same
--    way. The punctuation set is spelled out (ASCII punctuation, Latin-1 marks, Arabic and general
--    punctuation) rather than [[:punct:]] for the same locale-independence reason.
--    Both are LANGUAGE sql with a SQL-standard body, IMMUTABLE STRICT PARALLEL SAFE, no SET clause:
--    the body is bound at creation time (no search_path hijack is possible) and stays inlinable.
--
-- 2. Documents. Every search_tsv is GENERATED ALWAYS ... STORED (the 000110 convention) and now goes
--    through app.search_document inside to_tsvector. 'simple' for names and identifiers, 'english'
--    only for app.materials (prose), as 000110 decided. The four 000110 columns are rebuilt (PG16 has
--    no ALTER COLUMN ... SET EXPRESSION, so drop and re-add). Dropping a column drops the indexes on
--    it, so 000110's GIN indexes idx_students_search_tsv, idx_users_search_tsv,
--    idx_invoice_cache_search_tsv and idx_materials_search_tsv go away here and are deliberately not
--    recreated (see 4). Sixteen tables gain a column. Each column covers only the row's own
--    non-sensitive display text -- titles, names, codes, document numbers. Never a body, a
--    description that may name a child, an evaluation narrative, or anything from the school-defined
--    record tables. app.teacher_evaluations gets no column at all: its only free text is the
--    evaluator's narrative, so the API matches an evaluation through the evaluated teacher's own
--    app.users.search_tsv instead.
--
-- 3. Trigram fallback. app.students, app.users, app.classes, app.subjects and app.families gain a
--    stored search_name (the normalized person name or title). People names and titles are where
--    typos happen; identifiers (invoice numbers, codes) and high-churn tables (notifications,
--    incidents) are deliberately left out to keep write cost down.
--
-- 4. Why there are no search indexes -- RLS and leakproofness. Every one of these tables has FORCE
--    ROW LEVEL SECURITY and no Studafy role has BYPASSRLS (000002), so the policy quals apply to
--    studafy_app, to studafy_admin (tenant_isolation is TO PUBLIC, which includes the SECURITY
--    DEFINER candidate functions in 6) and to the table owner; only a superuser escapes them. PostgreSQL
--    never turns a qual into an index condition when it must run after a row-security qual unless
--    its operator function is LEAKPROOF, and neither ts_match_vq (@@) nor pg_trgm's
--    word_similarity_op (<%) is. A GIN index on search_tsv or a gin_trgm_ops index on search_name
--    could therefore never be used, while still costing write amplification and disk on every
--    insert and update. Checked on PG16: as studafy_admin with app.school_id set and
--    enable_seqscan = off, "SELECT id FROM app.students WHERE school_id = ... AND search_tsv @@
--    to_tsquery('simple', 'omar:*')" plans a Bitmap Index Scan on the school_id btree
--    (uq_students_school_normalized_admission_number) with the @@ as a Filter, even with the GIN
--    index present. So no index is created: every search scan is bounded by the tenant's school_id
--    btree, and the match is a Filter over that one school's rows. The stored columns are what keep
--    the per-row match cheap (no to_tsvector or regexp per row). What actually decides latency is
--    how expensive the policy quals are per row, hence 5 and 6. Do not add a search index without
--    first showing an EXPLAIN, under RLS, that uses it
--    (apps/api/tests/search/global-search-plans.integration.test.ts pins that none exists).
--
-- 5. Policy rewrite (same semantics, hoisted caller checks). The role_scope_visibility policies on
--    app.students, app.classes, app.courses, app.subjects and app.materials call a SECURITY DEFINER
--    predicate per row (~0.2 ms each), which made an admin's search over 5,000 students take ~1 s.
--    Each predicate already begins with app.current_user_is_school_admin() (and the attendance
--    variants with app.current_user_is_attendance_officer()). Those two depend only on the caller,
--    so they are repeated in front as scalar sub-selects, which PostgreSQL evaluates once per
--    statement as an InitPlan. The original predicate is kept verbatim as the last disjunct, so the
--    set of visible rows is identical for every caller: the added disjuncts are ones the original
--    expression already contained.
--
-- 6. Scoped candidate lookup. For callers the hoisted checks do not cover (a teacher, a parent, a
--    student) the per-row predicate still runs for every row the policy sees, so the search would
--    still pay it across the whole school. app.search_scoped_ids / app.search_scoped_fuzzy_ids return
--    the ids of the caller's school's rows that match the query, running as studafy_admin, which the
--    role_scope_visibility policies (TO studafy_app) do not apply to while tenant_isolation (TO
--    PUBLIC) still does. They return ids only, never text. The API then reads the rows themselves as
--    studafy_app with "id IN (candidates) AND <the same match>", so every returned row -- and every
--    count -- is still decided by row-level security; the candidate set only bounds how many rows the
--    per-row predicate is evaluated for.

SET ROLE studafy_admin;

-- ---------------------------------------------------------------------------
-- 1. Normalization functions
-- ---------------------------------------------------------------------------

CREATE FUNCTION app.search_normalize(value text)
RETURNS text
LANGUAGE sql
IMMUTABLE STRICT PARALLEL SAFE
RETURN pg_catalog.btrim(
  pg_catalog.regexp_replace(
    pg_catalog.translate(
      pg_catalog.regexp_replace(pg_catalog.lower(value), '[ً-ٰٟـ]', '', 'g'),
      'أإآٱىة',
      'اااايه'
    ),
    '[\t\n\v\f\r    -     　﻿]+',
    ' ',
    'g'
  ),
  ' '
);

COMMENT ON FUNCTION app.search_normalize(text) IS
  'Global search normalization; must match apps/web/src/features/search/normalize.ts exactly.';

CREATE FUNCTION app.search_document(value text)
RETURNS text
LANGUAGE sql
IMMUTABLE STRICT PARALLEL SAFE
RETURN pg_catalog.regexp_replace(
  app.search_normalize(value),
  '[!-/:-@\[-`{-~¡«·»¿،؛؟٪-٭۔‐-‧‰-⁞、-〃「-』]+',
  ' ',
  'g'
);

COMMENT ON FUNCTION app.search_document(text) IS
  'app.search_normalize plus punctuation folded to spaces, so to_tsvector splits a document the way '
  'the API tokenizes a query (letter/digit runs).';

REVOKE ALL ON FUNCTION app.search_normalize(text) FROM PUBLIC;
REVOKE ALL ON FUNCTION app.search_document(text) FROM PUBLIC;
-- Generated columns evaluate these as the writing role, and the API calls them on query text.
GRANT EXECUTE ON FUNCTION app.search_normalize(text) TO studafy_app;
GRANT EXECUTE ON FUNCTION app.search_document(text) TO studafy_app;

-- ---------------------------------------------------------------------------
-- 2a. Rebuild the four 000110 columns through app.search_document
-- ---------------------------------------------------------------------------

-- Each DROP COLUMN also drops 000110's GIN index on it; none is recreated (header, 4).

ALTER TABLE app.students DROP COLUMN search_tsv;
ALTER TABLE app.students
  ADD COLUMN search_tsv tsvector GENERATED ALWAYS AS (
    to_tsvector(
      'simple',
      app.search_document(
        coalesce(first_name, '') || ' ' || coalesce(middle_name, '') || ' ' ||
        coalesce(last_name, '') || ' ' || coalesce(preferred_name, '') || ' ' ||
        coalesce(admission_number, '')
      )
    )
  ) STORED;

ALTER TABLE app.users DROP COLUMN search_tsv;
ALTER TABLE app.users
  ADD COLUMN search_tsv tsvector GENERATED ALWAYS AS (
    to_tsvector('simple', app.search_document(coalesce(display_name, '') || ' ' || coalesce(email, '')))
  ) STORED;

-- The invoice number only; see 000110 for why a joined student name is never indexed here.
ALTER TABLE app.invoice_cache DROP COLUMN search_tsv;
ALTER TABLE app.invoice_cache
  ADD COLUMN search_tsv tsvector GENERATED ALWAYS AS (
    to_tsvector('simple', app.search_document(erpnext_docname))
  ) STORED;

ALTER TABLE app.materials DROP COLUMN search_tsv;
ALTER TABLE app.materials
  ADD COLUMN search_tsv tsvector GENERATED ALWAYS AS (
    to_tsvector('english', app.search_document(title || ' ' || coalesce(description, '')))
  ) STORED;

-- ---------------------------------------------------------------------------
-- 2b. New searchable types ('simple': names, titles, codes, document numbers)
-- ---------------------------------------------------------------------------

-- Classes match their own code; the course's code and name (below) are combined with it at query
-- time, so "Mathematics" finds the classes of that course.
ALTER TABLE app.classes
  ADD COLUMN search_tsv tsvector GENERATED ALWAYS AS (
    to_tsvector('simple', app.search_document(code))
  ) STORED;

ALTER TABLE app.courses
  ADD COLUMN search_tsv tsvector GENERATED ALWAYS AS (
    to_tsvector('simple', app.search_document(code || ' ' || name))
  ) STORED;

-- Sections match their own name; the grade level's name is combined with it at query time.
ALTER TABLE app.sections
  ADD COLUMN search_tsv tsvector GENERATED ALWAYS AS (
    to_tsvector('simple', app.search_document(name))
  ) STORED;

ALTER TABLE app.subjects
  ADD COLUMN search_tsv tsvector GENERATED ALWAYS AS (
    to_tsvector('simple', app.search_document(code || ' ' || name))
  ) STORED;

ALTER TABLE app.grade_levels
  ADD COLUMN search_tsv tsvector GENERATED ALWAYS AS (
    to_tsvector('simple', app.search_document(name))
  ) STORED;

ALTER TABLE app.academic_years
  ADD COLUMN search_tsv tsvector GENERATED ALWAYS AS (
    to_tsvector('simple', app.search_document(code || ' ' || name))
  ) STORED;

ALTER TABLE app.terms
  ADD COLUMN search_tsv tsvector GENERATED ALWAYS AS (
    to_tsvector('simple', app.search_document(code || ' ' || name))
  ) STORED;

ALTER TABLE app.rooms
  ADD COLUMN search_tsv tsvector GENERATED ALWAYS AS (
    to_tsvector(
      'simple', app.search_document(code || ' ' || name || ' ' || coalesce(building, ''))
    )
  ) STORED;

ALTER TABLE app.families
  ADD COLUMN search_tsv tsvector GENERATED ALWAYS AS (
    to_tsvector('simple', app.search_document(display_name))
  ) STORED;

-- Title only: an announcement body is long prose addressed to families.
ALTER TABLE app.announcements
  ADD COLUMN search_tsv tsvector GENERATED ALWAYS AS (
    to_tsvector('simple', app.search_document(title))
  ) STORED;

ALTER TABLE app.school_events
  ADD COLUMN search_tsv tsvector GENERATED ALWAYS AS (
    to_tsvector('simple', app.search_document(title))
  ) STORED;

-- Title only: the description is the account of what happened to a child.
ALTER TABLE app.discipline_incidents
  ADD COLUMN search_tsv tsvector GENERATED ALWAYS AS (
    to_tsvector('simple', app.search_document(title))
  ) STORED;

ALTER TABLE app.fee_structure_cache
  ADD COLUMN search_tsv tsvector GENERATED ALWAYS AS (
    to_tsvector(
      'simple',
      app.search_document(title || ' ' || erpnext_docname || ' ' || coalesce(program_erpnext_name, ''))
    )
  ) STORED;

ALTER TABLE app.scholarships
  ADD COLUMN search_tsv tsvector GENERATED ALWAYS AS (
    to_tsvector('simple', app.search_document(name || ' ' || coalesce(fee_category, '')))
  ) STORED;

-- Vendor, category and document number; never the free-text description or the attachment key.
ALTER TABLE app.expense_cache
  ADD COLUMN search_tsv tsvector GENERATED ALWAYS AS (
    to_tsvector('simple', app.search_document(vendor || ' ' || category || ' ' || erpnext_docname))
  ) STORED;

-- Title only: the body can carry another person's details the title does not.
ALTER TABLE app.notifications
  ADD COLUMN search_tsv tsvector GENERATED ALWAYS AS (
    to_tsvector('simple', app.search_document(title))
  ) STORED;

-- ---------------------------------------------------------------------------
-- 3. Trigram typo fallback on people names and titles (stored columns only; header, 4)
-- ---------------------------------------------------------------------------

ALTER TABLE app.students
  ADD COLUMN search_name text GENERATED ALWAYS AS (
    app.search_normalize(
      coalesce(preferred_name, '') || ' ' || coalesce(first_name, '') || ' ' ||
      coalesce(middle_name, '') || ' ' || coalesce(last_name, '')
    )
  ) STORED;

ALTER TABLE app.users
  ADD COLUMN search_name text GENERATED ALWAYS AS (
    app.search_normalize(coalesce(display_name, ''))
  ) STORED;

ALTER TABLE app.classes
  ADD COLUMN search_name text GENERATED ALWAYS AS (app.search_normalize(code)) STORED;

ALTER TABLE app.subjects
  ADD COLUMN search_name text GENERATED ALWAYS AS (app.search_normalize(name || ' ' || code)) STORED;

ALTER TABLE app.families
  ADD COLUMN search_name text GENERATED ALWAYS AS (app.search_normalize(display_name)) STORED;

-- ---------------------------------------------------------------------------
-- 5. role_scope_visibility: hoist the caller-only checks (same visible rows, see header)
-- ---------------------------------------------------------------------------

-- 000133: app.can_read_student_for_attendance(id) = can_read_student(id) OR attendance officer, and
-- can_read_student -> is_privileged_over_student -> current_user_is_school_admin() first.
ALTER POLICY role_scope_visibility ON app.students
  USING (
    (SELECT app.current_user_is_school_admin())
    OR (SELECT app.current_user_is_attendance_officer())
    OR app.can_read_student_for_attendance(id)
  );

-- 000133: app.can_read_class_for_attendance(id) = can_read_class(id) OR attendance officer, and
-- can_read_class starts with current_user_is_school_admin().
ALTER POLICY role_scope_visibility ON app.classes
  USING (
    (SELECT app.current_user_is_school_admin())
    OR (SELECT app.current_user_is_attendance_officer())
    OR app.can_read_class_for_attendance(id)
  );

-- 000133: (can_read_course(id) OR attendance officer); can_read_course starts with the admin check.
ALTER POLICY role_scope_visibility ON app.courses
  USING (
    (SELECT app.current_user_is_school_admin())
    OR (SELECT app.current_user_is_attendance_officer())
    OR app.can_read_course(id)
    OR app.current_user_is_attendance_officer()
  );

-- 000133/000160: (can_read_subject(id) OR attendance officer); can_read_subject starts with the
-- admin check.
ALTER POLICY role_scope_visibility ON app.subjects
  USING (
    (SELECT app.current_user_is_school_admin())
    OR (SELECT app.current_user_is_attendance_officer())
    OR app.can_read_subject(id)
    OR app.current_user_is_attendance_officer()
  );

-- 000037: app.can_read_class(class_id), which starts with the admin check. Attendance officers do
-- not read materials, so only the admin check is hoisted.
ALTER POLICY role_scope_visibility ON app.materials
  USING (
    (SELECT app.current_user_is_school_admin())
    OR app.can_read_class(class_id)
  );

-- ---------------------------------------------------------------------------
-- 6. Scoped candidate lookup (ids only; the API re-reads every row under RLS)
-- ---------------------------------------------------------------------------

CREATE FUNCTION app.search_scoped_ids(kind text, query tsquery)
RETURNS SETOF uuid
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
-- A search usually has a handful of candidates; the default estimate of 1000 made the planner
-- hash-join and scan the whole table, evaluating the per-row policy predicate for every row.
ROWS 20
SET search_path = pg_catalog
AS $function$
BEGIN
  IF kind = 'students' THEN
    RETURN QUERY
      SELECT s.id FROM app.students AS s
      WHERE s.school_id = current_setting('app.school_id')::uuid AND s.search_tsv @@ query;
  ELSIF kind = 'classes' THEN
    RETURN QUERY
      SELECT cl.id
      FROM app.classes AS cl
      LEFT JOIN app.courses AS co ON co.id = cl.course_id AND co.school_id = cl.school_id
      WHERE cl.school_id = current_setting('app.school_id')::uuid
        AND (cl.search_tsv || coalesce(co.search_tsv, ''::tsvector)) @@ query;
  ELSIF kind = 'subjects' THEN
    RETURN QUERY
      SELECT su.id FROM app.subjects AS su
      WHERE su.school_id = current_setting('app.school_id')::uuid AND su.search_tsv @@ query;
  ELSIF kind = 'materials' THEN
    RETURN QUERY
      SELECT m.id FROM app.materials AS m
      WHERE m.school_id = current_setting('app.school_id')::uuid AND m.search_tsv @@ query;
  ELSE
    RAISE EXCEPTION 'app.search_scoped_ids: unknown kind %', kind USING ERRCODE = '22023';
  END IF;
END;
$function$;

-- Trigram variant. The similarity floor is the caller's pg_trgm.word_similarity_threshold, set once
-- per search transaction by the API (SEARCH_TRIGRAM_FLOOR = 0.5 in apps/api/src/modules/search/service.ts).
CREATE FUNCTION app.search_scoped_fuzzy_ids(kind text, query text)
RETURNS SETOF uuid
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
ROWS 20
SET search_path = pg_catalog
AS $function$
BEGIN
  IF kind = 'students' THEN
    RETURN QUERY
      SELECT s.id FROM app.students AS s
      WHERE s.school_id = current_setting('app.school_id')::uuid
        AND query OPERATOR(public.<%) s.search_name;
  ELSIF kind = 'classes' THEN
    RETURN QUERY
      SELECT cl.id FROM app.classes AS cl
      WHERE cl.school_id = current_setting('app.school_id')::uuid
        AND query OPERATOR(public.<%) cl.search_name;
  ELSIF kind = 'subjects' THEN
    RETURN QUERY
      SELECT su.id FROM app.subjects AS su
      WHERE su.school_id = current_setting('app.school_id')::uuid
        AND query OPERATOR(public.<%) su.search_name;
  ELSE
    RAISE EXCEPTION 'app.search_scoped_fuzzy_ids: unknown kind %', kind USING ERRCODE = '22023';
  END IF;
END;
$function$;

REVOKE ALL ON FUNCTION app.search_scoped_ids(text, tsquery) FROM PUBLIC;
REVOKE ALL ON FUNCTION app.search_scoped_fuzzy_ids(text, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.search_scoped_ids(text, tsquery) TO studafy_app;
GRANT EXECUTE ON FUNCTION app.search_scoped_fuzzy_ids(text, text) TO studafy_app;

RESET ROLE;
