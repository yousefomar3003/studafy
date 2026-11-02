-- Look up a student id by the admission number ERPNext knows the student by, for userless
-- ingestion paths like the finance webhook cache projections.
--
-- The ERPNext webhook projects Sales Invoices into app.invoice_cache, resolving student_id from the
-- Customer name this gateway creates for each student -- buildStudentCustomerId in
-- apps/workers/src/queues/billing/invoice.service.ts names the Customer after the student's
-- admission number. The projection runs under studafy_app with no authenticated user (a webhook has
-- none), and app.students carries the restrictive role_scope_visibility SELECT policy (000037),
-- whose predicates are all false for a userless caller -- so a plain SELECT returns no student at
-- all and every incoming invoice would be silently unprojectable.
--
-- Following 000037's established pattern, this is a SECURITY DEFINER helper owned by studafy_admin:
-- the restrictive policies are declared TO studafy_app, so they never apply inside it, while the
-- permissive tenant_isolation policy (000006, FORCE RLS) still does -- correctly confining the
-- lookup to current_setting('app.school_id') and making a cross-school read impossible even for the
-- definer.

SET ROLE studafy_admin;

CREATE FUNCTION app.find_student_id_by_admission_number(p_admission_number text)
RETURNS uuid
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog
AS $function$
  -- The parameter is deliberately NOT named admission_number: inside the query an unqualified
  -- identifier would resolve to app.students.admission_number (the table column shadows the
  -- argument), making the predicate normalize-admission-number = normalize-admission-number and
  -- returning the school's first student for any input.
  SELECT id
  FROM app.students
  WHERE school_id = current_setting('app.school_id')::uuid
    AND normalized_admission_number = lower(btrim(p_admission_number))
$function$;

ALTER FUNCTION app.find_student_id_by_admission_number(text) OWNER TO studafy_admin;

REVOKE ALL ON FUNCTION app.find_student_id_by_admission_number(text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.find_student_id_by_admission_number(text) TO studafy_app;

RESET ROLE;
