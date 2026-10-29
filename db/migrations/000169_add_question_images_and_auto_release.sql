-- Question assignments (000167), second pass: a question can carry a picture, and a hand-in is
-- marked and released automatically.
--
-- Depends on 000167 (app.assignment_questions) and 000050 (ck_assignment_submissions_lifecycle).
--
-- A PICTURE ON A QUESTION.
-- Three nullable columns on app.assignment_questions, all set or all null. At most one picture per
-- question, so a column rather than a child table; it is replaced with the question set, never on
-- its own. The upload flow is the one 000134 uses for message images: the client stages the file
-- through the generic storage gateway (content class `assignment.question_image`), and the
-- question save re-checks the stored object, promotes it to permanent/<school_id>/..., and writes
-- the key in the same transaction.
--
-- THE STORAGE KEY CHECK IS A TENANT BOUNDARY, NOT A FORMAT CHECK -- the rule
-- ck_assignment_attachments_storage_key (000049) states: a persisted key is pinned to
-- '^permanent/<this row's school_id>/', the half of the boundary that still holds if the API's
-- assertSchoolOwnedKey is bypassed.
--
-- A PICTURE CAN BE THE WHOLE QUESTION.
-- ck_assignment_questions_prompt relaxes from "non-empty" to "non-empty, or there is a picture":
-- "Which organ is this?" is often the picture alone. Still trimmed, still NOT NULL; a picture-only
-- question carries the empty string.
--
-- AUTOMATIC RELEASE (reverses one decision in 000167's header).
-- 000167 left an automatic mark unstored and unreleased until a teacher published it. Teachers
-- choose the correct option for every question when they write the set, so the mark is final the
-- moment the student hands in, and the student should see it then. The submit now writes the score
-- and publishes it in one statement.
--
-- ck_assignment_submissions_lifecycle (000050) requires graded_by_user_id on a released grade, and
-- nobody graded this one by hand. Naming the teacher would put a grade in their name they never
-- gave; naming the student would have them grade themselves. So the row says what happened:
-- auto_graded = true, graded_by_user_id NULL. ck_assignment_submissions_auto_graded keeps the flag
-- honest -- it is only ever true on a released grade with no human grader -- and a teacher who
-- re-marks the work takes the grade over (the API clears the flag as it sets graded_by_user_id).
--
-- ONE TO TWENTY QUESTIONS, TWO TO FOUR OPTIONS.
-- Enforced by the API (replaceQuestionsBodySchema), as 000167 left its bounds. A database check on
-- position would refuse rows already written under 000167's wider limits, and this file cannot
-- rewrite them (see 000050's header on cross-tenant UPDATEs in a migration).

SELECT set_config('app.school_id', '00000000-0000-0000-0000-000000000000', true);
SET ROLE studafy_admin;

-- ---------------------------------------------------------------------------------------------------
-- 1. A picture on a question
-- ---------------------------------------------------------------------------------------------------

ALTER TABLE app.assignment_questions
  ADD COLUMN image_storage_key text,
  ADD COLUMN image_mime_type text,
  ADD COLUMN image_size_bytes bigint;

ALTER TABLE app.assignment_questions
  ADD CONSTRAINT uq_assignment_questions_image_storage_key UNIQUE (image_storage_key),
  ADD CONSTRAINT ck_assignment_questions_image CHECK (
    (image_storage_key IS NULL AND image_mime_type IS NULL AND image_size_bytes IS NULL)
    OR (image_storage_key IS NOT NULL AND image_mime_type IS NOT NULL
      AND image_size_bytes IS NOT NULL)
  ),
  ADD CONSTRAINT ck_assignment_questions_image_storage_key CHECK (
    image_storage_key IS NULL OR image_storage_key ~ ('^permanent/' || school_id::text || '/')
  ),
  -- Mirrors the `assignment.question_image` content class.
  ADD CONSTRAINT ck_assignment_questions_image_mime_type CHECK (
    image_mime_type IS NULL OR image_mime_type IN ('image/jpeg', 'image/png', 'image/webp')
  ),
  ADD CONSTRAINT ck_assignment_questions_image_size CHECK (
    image_size_bytes IS NULL OR image_size_bytes > 0
  );

ALTER TABLE app.assignment_questions DROP CONSTRAINT ck_assignment_questions_prompt;
ALTER TABLE app.assignment_questions ADD CONSTRAINT ck_assignment_questions_prompt CHECK (
  prompt = btrim(prompt) AND (prompt <> '' OR image_storage_key IS NOT NULL)
);

-- ---------------------------------------------------------------------------------------------------
-- 2. Automatic release
-- ---------------------------------------------------------------------------------------------------

-- A constant default: every existing grade was given by a person, so no backfill is needed.
ALTER TABLE app.assignment_submissions
  ADD COLUMN auto_graded boolean NOT NULL DEFAULT false;

ALTER TABLE app.assignment_submissions
  ADD CONSTRAINT ck_assignment_submissions_auto_graded CHECK (
    NOT auto_graded OR (grade_status = 'published' AND graded_by_user_id IS NULL)
  );

-- Restated from 000050 with one change: a released grade names its human grader, or is
-- auto_graded. The other four clauses are unchanged.
ALTER TABLE app.assignment_submissions
  DROP CONSTRAINT ck_assignment_submissions_lifecycle;

ALTER TABLE app.assignment_submissions
  ADD CONSTRAINT ck_assignment_submissions_lifecycle CHECK (
    (status = 'draft'
      AND submitted_at IS NULL
      AND grade_status = 'none'
      AND graded_at IS NULL AND graded_by_user_id IS NULL
      AND score IS NULL AND feedback IS NULL)

    OR (status IN ('submitted', 'late', 'returned')
      AND submitted_at IS NOT NULL
      AND grade_status = 'none'
      AND graded_at IS NULL AND graded_by_user_id IS NULL
      AND score IS NULL AND feedback IS NULL)

    OR (status IN ('submitted', 'late', 'returned')
      AND submitted_at IS NOT NULL
      AND grade_status = 'draft'
      AND graded_at IS NOT NULL AND graded_by_user_id IS NOT NULL)

    OR (status = 'graded'
      AND submitted_at IS NOT NULL
      AND grade_status = 'published'
      AND graded_at IS NOT NULL AND (graded_by_user_id IS NOT NULL OR auto_graded)
      AND score IS NOT NULL)

    OR (status = 'withdrawn'
      AND grade_status = 'none'
      AND graded_at IS NULL AND graded_by_user_id IS NULL
      AND score IS NULL AND feedback IS NULL)
  );

RESET ROLE;
