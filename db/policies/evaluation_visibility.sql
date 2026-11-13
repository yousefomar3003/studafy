-- Restrictive SELECT policy for teacher_evaluations.
--
-- REFERENCE SNAPSHOT -- NOT EXECUTED. Nothing runs this file, and it may lag the migrations. The
-- authoritative DDL is db/migrations: first installed by 000014_create_discipline_and_evaluation_tables,
-- then replaced by 000058_add_evaluation_criteria_and_share, which added the
-- "AND shared_with_teacher = true" condition. The copy below matches 000058.
--
-- This policy ANDs with the permissive tenant_isolation policy. It limits SELECT visibility
-- to the evaluator, and to the evaluated teacher once the evaluation is shared with them.
-- INSERT/UPDATE/DELETE remain scoped by tenant isolation only; application-layer authorization
-- handles write access.
--
-- Prerequisites:
--   1. app.apply_tenant_isolation('app', 'teacher_evaluations') has been called.
--   2. app.current_user_id() exists and is granted EXECUTE to studafy_app.
--   3. The application sets both session variables per transaction:
--        SELECT set_config('app.school_id', $school_id, true);
--        SELECT set_config('app.user_id', $user_id, true);
--
-- The evaluated teacher is resolved via: teachers.user_id = app.current_user_id()
--   and sees the row only when teacher_evaluations.shared_with_teacher = true (000058).
-- The evaluator is matched directly on:  teacher_evaluations.evaluator_user_id = app.current_user_id()
--
CREATE POLICY teacher_evaluation_visibility ON app.teacher_evaluations
  AS RESTRICTIVE FOR SELECT TO PUBLIC
  USING (
    (teacher_id IN (
      SELECT t.id FROM app.teachers t
      WHERE t.user_id = app.current_user_id()
        AND t.school_id = current_setting('app.school_id')::uuid
    ) AND shared_with_teacher = true)
    OR evaluator_user_id = app.current_user_id()
  );
